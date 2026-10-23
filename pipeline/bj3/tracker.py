"""Pass 2: find every physical card in the take — where it lies and when it
lands, flips and is picked up.

Per table region the card/foreign signals are piecewise constant while
nothing touches that region. Those plateaus are sampled (median of 5
frames), consecutive plateaus are diffed to find cards that appeared,
disappeared or flipped, and each card's exact frames are then refined by
scanning the transition frames for the card's own outline.

Regions are independent, so a deal that touches all three seats still gives
each seat clean before/after plateaus between its own cards.
"""

import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

from bj3 import cardfit
from bj3.colour import card_back_mask, card_mask
from bj3.geometry import REGIONS
from bj3.video import Frames

MIN_PLATEAU_S = 0.35

# Search windows for the diffing. Seat 1's fan climbs right into seat 2's
# signal box, so seat 1 is widened; the resulting duplicate sightings are
# resolved in `_resolve` by IoU, and ownership by which stack a card lands on.
TRACK_REGIONS = {**REGIONS, "seat1": (632, 440, 792, 540), "seat2": (756, 432, 852, 548)}
ANCHORS = {"seat1": (670, 511), "seat2": (783, 519), "seat3": (879, 511)}


@dataclass
class CardInstance:
    id: str
    region: str
    birth: int
    death: int
    quad: list  # face TL, TR, BR, BL in source pixels (TL->TR is the face's top edge)
    face_down: bool = False
    flip: int | None = None
    isolated: bool = False
    sample: int = 0  # settled frame the outline was measured on
    notes: list = field(default_factory=list)


def rolling_std(a: np.ndarray, w: int) -> np.ndarray:
    k = np.ones(w) / w
    m = np.convolve(a, k, "same")
    m2 = np.convolve(a * a, k, "same")
    return np.sqrt(np.maximum(m2 - m * m, 0))


def plateaus(card: np.ndarray, foreign: np.ndarray, fps: float) -> list[tuple[int, int]]:
    w = max(3, int(0.3 * fps))
    stable = (rolling_std(card, w) < 0.004) & (rolling_std(foreign, w) < 0.006)
    out, s = [], None
    for i, v in enumerate(stable):
        if v and s is None:
            s = i
        elif not v and s is not None:
            out.append((s, i))
            s = None
    if s is not None:
        out.append((s, len(stable)))
    return [(a, b) for a, b in out if (b - a) / fps >= MIN_PLATEAU_S]


def region_masks(frame: np.ndarray, region: str) -> tuple[np.ndarray, np.ndarray]:
    x0, y0, x1, y1 = TRACK_REGIONS[region]
    crop = frame[y0:y1, x0:x1]
    white = cv2.morphologyEx(card_mask(crop), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    back = cv2.morphologyEx(card_back_mask(crop), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    return white, back


def rect_ratio(frame: np.ndarray, quad: np.ndarray, back: bool = False) -> float:
    """Fraction of the card's outline (source coords) showing card stock (or its back)."""
    xs, ys = quad[:, 0], quad[:, 1]
    x0, y0 = int(xs.min()) - 2, int(ys.min()) - 2
    x1, y1 = int(xs.max()) + 3, int(ys.max()) + 3
    crop = frame[y0:y1, x0:x1]
    src = card_back_mask(crop) if back else card_mask(crop)
    m = np.zeros(src.shape, np.uint8)
    cv2.fillConvexPoly(m, (quad - (x0, y0)).round().astype(np.int32), 255)
    # shrink 1 px so the anti-aliased rim does not count against the card
    m = cv2.erode(m, np.ones((3, 3), np.uint8))
    return float(cv2.bitwise_and(m, src).sum()) / max(1.0, float(m.sum()))


def detect(fr: Frames, d) -> list[dict]:
    fps = float(d["fps"])
    names = list(d["names"])
    found = []
    for region in REGIONS:
        i = names.index(region)
        sig_c = d["card"][i]
        sig_f = d["foreign"][i]
        if region == "hole":
            sig_c = sig_c + d["back"]
        x0, y0, _, _ = TRACK_REGIONS[region]
        pls = plateaus(sig_c, sig_f, fps)
        prev = None
        live: list[dict] = []
        for (s, e) in pls:
            mid = (s + e) // 2
            white, back = region_masks(fr.median(mid), region)
            if prev is None:
                prev = (white, back, e, mid)
                continue
            p_white, p_back, p_end, p_mid = prev
            k3 = np.ones((3, 3), np.uint8)
            added = cv2.bitwise_and(white, cv2.bitwise_not(cv2.dilate(p_white, k3)))
            added = cv2.morphologyEx(added, cv2.MORPH_OPEN, k3)
            added_back = cv2.bitwise_and(back, cv2.bitwise_not(cv2.dilate(p_back, k3)))
            added_back = cv2.morphologyEx(added_back, cv2.MORPH_OPEN, k3)
            for c in list(live):
                m = np.zeros_like(white)
                cv2.fillConvexPoly(m, (c["rough"] - (x0, y0)).astype(np.int32), 255)
                area = max(1.0, float(m.sum()))
                w_ratio = float(cv2.bitwise_and(m, white).sum()) / area
                b_ratio = float(cv2.bitwise_and(m, back).sum()) / area
                if c["face_down"] and c["flip"] is None and w_ratio > 0.55 and b_ratio < 0.2:
                    c["flip"] = (p_end, s)
                    continue
                still = b_ratio > 0.4 if (c["face_down"] and c["flip"] is None) else w_ratio > 0.4
                if not still:
                    c["death"] = (p_end, s)
                    live.remove(c)
                    found.append(c)
            for src, face_down in ((added, False), (added_back, True)):
                if face_down and region != "hole":
                    continue
                n, lab, st, _ = cv2.connectedComponentsWithStats(src)
                for k in range(1, n):
                    if st[k, 4] < 120:
                        continue
                    comp = (lab == k).astype(np.uint8) * 255
                    if not face_down and any(c["face_down"] and c["flip"] is not None and
                                             _overlap(comp, c["rough"] - (x0, y0)) > 0.5 for c in live):
                        continue
                    ys, xs = np.nonzero(comp)
                    rect = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
                    live.append({
                        "region": region, "face_down": face_down, "birth": (p_end, s), "flip": None,
                        "rough": cv2.boxPoints(rect) + (x0, y0), "mid": mid, "prev_mid": p_mid,
                    })
            prev = (white, back, e, mid)
        for c in live:
            c["death"] = (prev[2], len(sig_c))
            found.append(c)
    return found


def _overlap(comp: np.ndarray, poly: np.ndarray) -> float:
    m = np.zeros_like(comp)
    cv2.fillConvexPoly(m, poly.astype(np.int32), 255)
    return float(cv2.bitwise_and(m, comp).sum()) / max(1.0, float(comp.sum()))


def _poly_mask(quad, shape=(810, 1440)) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, np.array(quad, np.float32).round().astype(np.int32), 255)
    return m


def _iou(a, b) -> float:
    ma, mb = _poly_mask(a), _poly_mask(b)
    return float(cv2.bitwise_and(ma, mb).sum()) / max(1.0, float(cv2.bitwise_or(ma, mb).sum()))


def _cover(a, b) -> float:
    ma, mb = _poly_mask(a), _poly_mask(b)
    return float(cv2.bitwise_and(ma, mb).sum()) / max(1.0, float(ma.sum()))


def resolve(found: list[dict], fps: float) -> list[dict]:
    """Merge duplicate sightings, stitch occlusion splits, and assign hit cards to their stack."""
    seats = sorted([c for c in found if c["region"].startswith("seat")], key=lambda c: c["birth"][1])
    dealer = [c for c in found if not c["region"].startswith("seat")]
    for c in found:
        c.setdefault("notes", [])

    kept: list[dict] = []
    for c in seats:
        dup = next((k for k in kept if _iou(k["rough"], c["rough"]) > 0.3
                    and abs(k["birth"][1] - c["birth"][1]) < fps), None)
        if dup is None:
            kept.append(c)
        elif (c["death"][1] - c["birth"][1]) > (dup["death"][1] - dup["birth"][1]):
            kept[kept.index(dup)] = c

    def stitch(group):
        group.sort(key=lambda c: c["birth"][1])
        out: list[dict] = []
        for c in group:
            prev = next((p for p in reversed(out) if p["region"] == c["region"]
                         and 0 <= c["birth"][1] - p["death"][1] < 4 * fps
                         and _iou(p["rough"], c["rough"]) > 0.5), None)
            if prev is None:
                out.append(c)
                continue
            prev["death"] = c["death"]
            prev["flip"] = prev["flip"] or c["flip"]
            prev["notes"].append("stitched across an occlusion")
        return out

    kept = stitch(kept)
    dealer = stitch(dealer)

    for c in kept:
        live = [p for p in kept if p is not c and p["birth"][1] < c["birth"][1] < p["death"][1]]
        best = max(live, key=lambda p: _cover(c["rough"], p["rough"]), default=None)
        if best is not None and _cover(c["rough"], best["rough"]) > 0.08:
            owner = best["region"]
        else:
            cx, cy = c["rough"].mean(0)
            owner = min(ANCHORS, key=lambda k: (ANCHORS[k][0] - cx) ** 2 + (ANCHORS[k][1] - cy) ** 2)
        if owner != c["region"]:
            c["notes"].append(f"reassigned {c['region']} -> {owner} (lands on that stack)")
            c["region"] = owner
    return kept + dealer


def choose_samples(cards: list[dict], calm: np.ndarray) -> None:
    """Pick, per card, the calmest frame with it settled and the calmest frame just before it.

    "After" must precede the next card landing nearby, or a later card would
    be fitted into this card's outline; "before" must follow the previous one.
    """
    for c in cards:
        cx, cy = c["rough"].mean(0)
        near = [o for o in cards if o is not c and np.hypot(*(o["rough"].mean(0) - (cx, cy))) < 75]
        nxt = min([o["t_birth"] for o in near if o["t_birth"] > c["t_birth"]] + [c["t_death"]])
        prv = max([o["t_birth"] for o in near if o["t_birth"] < c["t_birth"]] + [0])
        prv = max([prv] + [o["t_death"] for o in near if o["t_death"] <= c["t_birth"]])
        a, b = c["t_birth"] + 4, nxt - 4
        c["mid"] = a + int(np.argmin(calm[a:b])) if b > a + 2 else c["t_birth"] + 3
        a, b = prv + 4, c["birth"][0]
        c["prev_mid"] = a + int(np.argmin(calm[a:b])) if b > a + 2 else max(0, c["birth"][0] - 2)


def refit(fr: Frames, cards: list[dict]) -> None:
    """Sub-pixel outlines: isolated cards measured, overlapped cards fitted from their seat's template."""
    templates: dict[str, np.ndarray] = {}
    up = cardfit.UP
    for c in sorted(cards, key=lambda c: c["t_birth"]):
        cx, cy = c["rough"].mean(0)
        x0, y0 = int(cx) - 45, int(cy) - 40
        after = fr.median(c["mid"])[y0:y0 + 80, x0:x0 + 90].copy()
        before = fr.median(c["prev_mid"])[y0:y0 + 80, x0:x0 + 90].copy()
        dealer = c["region"] in ("up", "hole")
        if dealer:
            # the two dealer cards touch; confine each to its own slot
            rx0, ry0, rx1, ry1 = REGIONS[c["region"]]
            keep = np.zeros(after.shape[:2], bool)
            keep[max(0, ry0 - y0 - 2):ry1 - y0 + 2, max(0, rx0 - x0 - 2):rx1 - x0 + 2] = True
            after[~keep] = (150, 60, 10)
            before[~keep] = (150, 60, 10)
        if c["face_down"]:
            sup_a, sup_b = cardfit.soft_back(after), cardfit.soft_back(before)
        else:
            sup_a, sup_b = cardfit.soft_card(after), cardfit.soft_card(before)
        added = np.clip(sup_a - cv2.dilate(sup_b, np.ones((9, 9), np.uint8)), 0, 1)
        added = cv2.morphologyEx(added, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        # isolated: the blob holding the new pixels is no larger than the new pixels
        n, lab, st, _ = cv2.connectedComponentsWithStats((sup_a > 0.5).astype(np.uint8))
        ay, ax = np.nonzero(added > 0.5)
        q = None
        if len(ax):
            k = np.bincount(lab[ay, ax], minlength=n)[1:].argmax() + 1 if n > 1 else 0
            blob = (lab == k).astype(np.float32)
            if k and blob.sum() <= 1.2 * (added > 0.5).sum():
                q = cardfit.corners_from_mask(blob)
                c["isolated"] = q is not None
        tmpl_key = c["region"] if not dealer else "dealer"
        if q is None:
            if tmpl_key in templates:
                q = cardfit.fit_template(templates[tmpl_key] - (x0 * up, y0 * up), added, sup_a)
                c["notes"].append("fitted from seat template")
            else:
                q = (c["rough"] - (x0, y0)) * up
                c["notes"].append("rough outline (no template yet)")
        q = cardfit.orient(np.asarray(q, np.float32))
        src_q = q / up + (x0, y0)
        if c.get("isolated"):
            templates[tmpl_key] = src_q * up
        c["quad"] = src_q


def _rectangular(q: np.ndarray) -> bool:
    w = np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3])
    h = np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1])
    return (19 <= min(w) and max(w) <= 26 and 11 <= min(h) and max(h) <= 18
            and abs(w[0] - w[1]) < 2.5 and abs(h[0] - h[1]) < 2.5)


def register_dealer(fr: Frames, cards: list[dict]) -> None:
    """Dealer cards lie in two fixed slots, square-on. Template each slot from its clean
    isolated fits, then register every dealer card to it (small shift and turn only):
    the two cards touch and a hand is often beside them, so free outlines are fragile."""
    up = cardfit.UP
    for slot in ("up", "hole"):
        group = [c for c in cards if c["region"] == slot]
        good = [c["quad"] for c in group if c.get("isolated") and _rectangular(c["quad"])]
        if not good:
            continue
        rel = np.median([q - q.mean(0) for q in good], axis=0)
        centre = np.median([q.mean(0) for q in good], axis=0)
        print(f"dealer slot {slot}: {len(good)}/{len(group)} clean fits, centre {centre.round(1)}")
        for c in group:
            x0, y0 = int(centre[0]) - 30, int(centre[1]) - 20
            frame = fr.median(c["mid"])[y0:y0 + 40, x0:x0 + 60].copy()
            rx0, ry0, rx1, ry1 = REGIONS[slot]
            keep = np.zeros(frame.shape[:2], bool)
            keep[max(0, ry0 - y0 - 2):ry1 - y0 + 2, max(0, rx0 - x0 - 2):rx1 - x0 + 2] = True
            frame[~keep] = (150, 60, 10)
            sup = cardfit.soft_back(frame) if c["face_down"] else cardfit.soft_card(frame)
            tmpl = (rel + centre - (x0, y0)) * up
            q = cardfit.fit_template(tmpl, sup, sup, reach=4, turn=2, scales=(0.97, 1.0, 1.03),
                                     start=(centre - (x0, y0)) * up)
            c["quad"] = cardfit.orient(np.asarray(q, np.float32) / up + (x0, y0))
            c["isolated"] = False
            c["notes"].append("registered to dealer slot")


def refine_times(fr: Frames, c: dict, q: np.ndarray) -> tuple[int, int, int | None]:
    a, b = c["birth"]
    vals = [rect_ratio(fr.get(f), q, back=c["face_down"]) for f in range(a, b + 1)]
    birth = next((a + i for i in range(len(vals)) if all(v >= 0.75 for v in vals[i:i + 6])),
                 a + max([i for i, v in enumerate(vals) if v < 0.6], default=-1) + 1)
    flip = None
    if c["flip"]:
        a, b = c["flip"]
        vals = [rect_ratio(fr.get(f), q) for f in range(a, b + 1)]
        flip = next((a + i for i in range(len(vals)) if all(v >= 0.7 for v in vals[i:i + 4])), b)
    a, b = c["death"]
    if b - a > 24 * 30:
        return birth, b, flip
    back = c["face_down"] and not c["flip"]
    vals = [rect_ratio(fr.get(f), q, back=back) for f in range(a, b + 1)]
    death = a + max([i for i, v in enumerate(vals) if v >= 0.4], default=-1) + 1
    return birth, death, flip


def track(video: str, signals: str, out: str) -> None:
    d = np.load(signals)
    fps = float(d["fps"])
    fr = Frames(video)
    found = resolve(detect(fr, d), fps)
    for c in found:
        c["t_birth"], c["t_death"], _ = refine_times(fr, c, c["rough"])
    k = 5
    calm = np.convolve(d["table_motion"] + d["hands_motion"] + d["dealer_motion"], np.ones(k) / k, "same")
    choose_samples(found, calm)
    refit(fr, found)
    register_dealer(fr, found)
    cards = []
    for c in found:
        birth, death, flip = refine_times(fr, c, c["quad"])
        cards.append(CardInstance(
            id="", region=c["region"], birth=birth, death=death,
            quad=[[round(float(x), 2), round(float(y), 2)] for x, y in c["quad"]],
            face_down=c["face_down"], flip=flip, isolated=bool(c.get("isolated")), sample=int(c["mid"]),
            notes=c["notes"] + [f"before={c['prev_mid']}"],
        ))
    cards.sort(key=lambda c: (c.birth, c.region))
    for i, c in enumerate(cards):
        c.id = f"c{i:03d}"
    Path(out).write_text(json.dumps({"fps": fps, "cards": [asdict(c) for c in cards]}, indent=1))
    print(f"{len(cards)} card instances -> {out}")


if __name__ == "__main__":
    track(sys.argv[1], sys.argv[2], sys.argv[3])
