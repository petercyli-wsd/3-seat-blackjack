"""Pass 3b: each card's resting outline, measured over its whole stay.

The tracker measures a card on one calm frame, and snaps dealer cards to a
slot template. A hand beside the card on that frame, or a card the dealer
put down a pixel or two off the slot, leaves the painted face off its card
for as long as it lies there. Here every card's outline is fitted again on
many frames of its stay, and the median pose is kept.

Evidence is edge contrast: just inside each side of the outline should be
card stock, just outside it should not. A side under a finger, or lying on
another card, reads the same on both sides and simply carries no weight, so
a partly covered card is fitted from the sides that show. Poses are the
rigid ones of `flight` (shift, turn on the table, scale), so the outline
stays the card's own shape.

The hole card's face only shows after the flip, so it is fitted from then.

A dealer card moved where it lies (squared against the hole card, put back a few pixels off after
the reveal) gets an outline for each stretch it lies still (`rests`, after its first), so its face
moves with it; slid along the felt under her fingers it is followed frame by frame (`slides`).

It also finds where each card *leaves*: the frame its resting outline loses
its edges for good, as the dealer starts sweeping it up. The tracker's pickup
frame is later (when most of the outline is bare felt), and a face kept on
the resting outline until then is painted onto whatever passes beneath it.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.rigid import posed, sample, soft_card, table_map
from bj3.video import Frames

SAMPLES = 24
LEAVE_LOOK = 96  # frames before the pickup to look for the card starting to move
PAD = 34
EDGE_T = np.linspace(0.12, 0.88, 12, dtype=np.float32)
OFFS = (0.6, 1.4)


def edge_contrast(m: np.ndarray, quads: np.ndarray, per_side: bool = False) -> np.ndarray:
    """Mean (inside - outside) of m across every side of each quad (..., 4, 2), clockwise on screen;
    or, per_side, one value per side (..., 4)."""
    a = quads
    b = np.roll(quads, -1, axis=-2)
    d = b - a
    t = d / np.maximum(np.linalg.norm(d, axis=-1, keepdims=True), 1e-6)
    n = np.stack([t[..., 1], -t[..., 0]], -1)[..., None, :]  # outward for a clockwise quad
    p = a[..., None, :] + d[..., None, :] * EDGE_T[:, None]  # (..., 4, 12, 2)
    total = 0.0
    for o in OFFS:
        total = total + (sample(m, p - o * n) - sample(m, p + o * n)).mean(-1)
    total = total / len(OFFS)
    return total if per_side else total.mean(-1)


def _search(m, frame, p0, reach, step, turn, turn_step, scales):
    d = np.arange(-reach, reach + 1e-6, step, dtype=np.float32)
    a = np.deg2rad(np.arange(-turn, turn + 1e-6, turn_step, dtype=np.float32))
    s = np.asarray(scales, np.float32)
    g = np.stack(np.meshgrid(d, d, a, s, indexing="ij"), -1).reshape(-1, 4)
    p = g + np.array([p0[0], p0[1], p0[2], 0], np.float32)
    p[:, 3] *= p0[3]
    sc = edge_contrast(m, posed(*frame, p))
    i = int(np.argmax(sc))
    return p[i], float(sc[i])


# Coarse search (shift reach px, turn deg, scales). Dealer cards were snapped to a slot
# template and she puts them down up to ~5 px off it, and a hole card's outline was
# measured on its back, a little inside the edge. Seat cards were measured on their own
# pixels; in a hit stack most of each card's edge lies white on white, so a wide search
# there could slide a card onto its neighbour's edge.
SEARCH = {
    "dealer": (5.5, 5, (0.94, 0.98, 1.02, 1.06, 1.10, 1.14, 1.18)),
    "seat": (3, 4, (0.97, 1.0, 1.03)),
}


def fit_frame(img: np.ndarray, q: np.ndarray, search: str) -> tuple[np.ndarray, float]:
    """Best rigid pose of outline q on one frame, as (pose, edge contrast)."""
    cx, cy = q.mean(0)
    x0, y0 = max(0, int(cx) - PAD), max(0, int(cy) - PAD)
    m = soft_card(img[y0:y0 + 2 * PAD, x0:x0 + 2 * PAD])
    off = np.array([x0, y0], np.float32)
    M = table_map(q)
    centre = (q - off).mean(0)
    frame = (((q - off) - centre) @ np.linalg.inv(M).T, M, centre)
    reach, turn, scales = SEARCH[search]
    p, _ = _search(m, frame, np.array([0, 0, 0, 1], np.float32), reach, 0.5, turn, 1, scales)
    return _search(m, frame, p, 0.5, 0.125, 0.75, 0.25, (0.99, 0.995, 1.0, 1.005, 1.01))


def still_there(img: np.ndarray, q: np.ndarray) -> float:
    """How plainly the card still lies on outline q: the second-best side's edge contrast. A card
    beside it (the hole card flipped white next to the up card) or a finger can take a side or two
    without the card having moved; once the card moves, every side goes."""
    cx, cy = q.mean(0)
    x0, y0 = max(0, int(cx) - PAD), max(0, int(cy) - PAD)
    m = soft_card(img[y0:y0 + 2 * PAD, x0:x0 + 2 * PAD])
    return float(np.sort(edge_contrast(m, (q - (x0, y0))[None], per_side=True)[0])[-2])


def leave_frame(fr: Frames, c: dict, q: np.ndarray, rest: float) -> int:
    """First frame of the card's last stretch below half its resting `still_there`, up to its pickup:
    where it starts to move for good (a hand passing over it and away doesn't count)."""
    a = max(c["birth"] + 1, c["death"] - LEAVE_LOOK)
    low = [still_there(fr.get(f), q) < 0.5 * rest for f in range(a, c["death"])]
    leave = c["death"]
    for i in range(len(low) - 1, -1, -1):
        if not low[i]:
            break
        leave = a + i
    return leave


TRIP_STEP = 2  # frames between looks while scanning a card's stay for trips
TRIP_FELT = 0.35  # share of its resting outline showing felt that says it has been lifted off


def felt_inside(img: np.ndarray, q: np.ndarray) -> float:
    """Share of the inside of outline q showing felt: the card has gone from there (a hand over
    it shows skin instead)."""
    x0, y0 = max(0, int(q[:, 0].min()) - 2), max(0, int(q[:, 1].min()) - 2)
    crop = img[y0:int(q[:, 1].max()) + 3, x0:int(q[:, 0].max()) + 3].astype(np.int16)
    blue = crop[..., 0] - np.maximum(crop[..., 1], crop[..., 2])
    m = np.zeros(crop.shape[:2], np.uint8)
    cv2.fillConvexPoly(m, (q - (x0, y0)).round().astype(np.int32), 1)
    m = cv2.erode(m, np.ones((3, 3), np.uint8))
    return float(((blue > 30) & (m > 0)).sum()) / max(1, int(m.sum()))


def trips(fr: Frames, c: dict, q: np.ndarray, rest: float, start: int, leave: int) -> list[list[int]]:
    """Stretches [a, b) the card leaves its resting place and comes back before it is swept up:
    the dealer's up card lifted to scoop the hole card over at the reveal. Its edges go, and
    felt shows where it lay (under a hand passing over it, skin would)."""
    out, run, lifted = [], None, False
    for f in range(start, leave, TRIP_STEP):
        img = fr.get(f)
        if still_there(img, q) < 0.5 * rest:
            run = f if run is None else run
            lifted = lifted or felt_inside(img, q) >= TRIP_FELT
        elif run is not None:
            if lifted:
                out.append([max(start, run - TRIP_STEP), f])
            run, lifted = None, False
    return out


# A dealer card is moved where it lies: squared against the hole card once that is dealt, put back
# beside it a few pixels off after scooping it over at the reveal. Its stay is split into stretches
# it lies still, each with its own outline: every STAY_STEP frames it is fitted afresh within
# STAY_REACH px of its median outline, and a fit that plainly shows the card (three sides or more)
# more than MOVED px or MOVED_DEG off the stretch it is in, with STAY_CONFIRM more agreeing, starts
# another stretch.
STAY_STEP = 3
STAY_REACH = 10.0
STAY_TURN = 4
MOVED = 1.0
MOVED_DEG = 1.0
STAY_CONFIRM = 3
CLEAR = 0.6  # its third-best side against the median of the stay's, for a fit to count


def fit_near(img: np.ndarray, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Outline q moved (shift, turn; its own size) to where the card lies near it on one frame,
    and the edge contrast of each of its sides there."""
    cx, cy = q.mean(0)
    x0, y0 = max(0, int(cx) - PAD), max(0, int(cy) - PAD)
    m = soft_card(img[y0:y0 + 2 * PAD, x0:x0 + 2 * PAD])
    off = np.array([x0, y0], np.float32)
    M = table_map(q)
    centre = (q - off).mean(0)
    frame = (((q - off) - centre) @ np.linalg.inv(M).T, M, centre)
    p, _ = _search(m, frame, np.array([0, 0, 0, 1], np.float32), STAY_REACH, 1.0, STAY_TURN, 1, (1.0,))
    p, _ = _search(m, frame, p, 0.75, 0.125, 0.75, 0.25, (0.995, 1.0, 1.005))
    found = posed(*frame, p[None])[0]
    return found + off, edge_contrast(m, found[None], per_side=True)[0]


def _apart(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """How far apart two outlines of one card are: centre shift (px) and turn (degrees)."""
    turn = lambda q: np.degrees(np.arctan2(*(q[1] - q[0])[::-1]))
    d = (turn(a) - turn(b) + 180) % 360 - 180
    return float(np.hypot(*(a.mean(0) - b.mean(0)))), abs(float(d))


def stays(fr: Frames, q: np.ndarray, a: int, b: int) -> list[dict]:
    """The stretches of [a, b) the card lies still: each its first and last clear frame and outline."""
    fits = [(f, *fit_near(fr.get(f), q)) for f in range(a, b, STAY_STEP)]
    if not fits:
        return []
    third = np.array([np.sort(s)[-3] for _, _, s in fits])
    clear = [(f, quad) for (f, quad, _), t in zip(fits, third) if t >= CLEAR * np.median(third)]
    out: list[dict] = []
    i = 0
    while i < len(clear):
        f, quad = clear[i]
        run = [clear[i]]
        j = i + 1
        while j < len(clear):
            ref = np.median(np.stack([x for _, x in run]), 0)
            shift, turn = _apart(clear[j][1], ref)
            if shift <= MOVED and turn <= MOVED_DEG:
                run.append(clear[j])
                j += 1
                continue
            # moved, if the next fits agree it has; else a stray fit, skipped
            ahead = clear[j:j + STAY_CONFIRM + 1]
            if len(ahead) > STAY_CONFIRM and all(max(_apart(x, ahead[0][1])) <= MOVED for _, x in ahead):
                break
            j += 1
        out.append({"first": run[0][0], "last": run[-1][0], "quad": np.median(np.stack([x for _, x in run]), 0)})
        i = j
    # stretches at one place (a hand over the card between) are one stay
    merged = [out[0]] if out else []
    for s in out[1:]:
        if max(*_apart(s["quad"], merged[-1]["quad"])) <= MOVED:
            merged[-1]["last"] = s["last"]
        else:
            merged.append(s)
    return merged


def moved_at(fr: Frames, old: np.ndarray, new: np.ndarray, a: int, b: int) -> int:
    """The frame in (a, b] from which the card plainly lies at `new` rather than at `old`."""
    for f in range(a + 1, b + 1):
        img = fr.get(f)
        if still_there(img, new) > still_there(img, old) and still_there(fr.get(min(f + 1, b)), new) > still_there(fr.get(min(f + 1, b)), old):
            return f
    return b


SLIDE_OFF = 1.5  # px a fit may lie off the line between where the card lay and where it ends up


def slide(fr: Frames, old: np.ndarray, new: np.ndarray, a: int, b: int) -> list | None:
    """Outlines over [a, b) as she slides the card from `old` to `new` under her fingers: fitted on
    each frame it shows on two sides or more, on its way between the two; on the frames between,
    moved on in step with the fits either side. None if it never shows."""
    _, sides = fit_near(fr.get(a - 1), old)
    ref = float(np.sort(sides)[-2])
    d = new.mean(0) - old.mean(0)
    span = max(float(np.hypot(*d)), 1e-6)
    u = d / span
    known = {a - 1: 0.0, b: 1.0}
    fits = {}
    for f in range(a, b):
        quad, sides = fit_near(fr.get(f), old)
        if np.sort(sides)[-2] < CLEAR * ref:
            continue
        o = quad.mean(0) - old.mean(0)
        t = float(o @ u) / span
        if -0.2 <= t <= 1.2 and abs(float(o[0] * u[1] - o[1] * u[0])) <= SLIDE_OFF:
            known[f], fits[f] = t, quad
    if not fits:
        return None
    at = sorted(known)
    ts = np.interp(np.arange(a, b), at, [known[f] for f in at])
    return [fits.get(f, old + t * (new - old)) for f, t in zip(range(a, b), ts)]


def outermost(spans: list[list[int]]) -> list[list[int]]:
    """The spans not inside another (a lift found again within the move it is part of)."""
    spans = sorted(spans)
    return [s for i, s in enumerate(spans) if not any(j != i and o[0] <= s[0] and s[1] <= o[1] for j, o in enumerate(spans))]


def settle(fr: Frames, c: dict) -> dict | None:
    q = np.asarray(c["quad"], np.float32)
    if c["face_down"] and c["flip"] is None:
        return None
    start = c["flip"] if c["face_down"] else c["birth"]
    a, b = start + 2, c["death"] - 2
    if b - a < 4:
        return None
    frames = np.unique(np.linspace(a, b - 1, min(SAMPLES, b - a)).round().astype(int))
    search = "dealer" if c["region"] in ("up", "hole") else "seat"
    fits = [(f, *fit_frame(fr.get(int(f)), q, search)) for f in frames]
    best = max(sc for _, _, sc in fits)
    kept = [p for _, p, sc in fits if sc >= max(0.15, 0.6 * best)]
    if len(kept) < 3:
        return None
    pose = np.median(np.stack(kept), 0)
    M = table_map(q)
    centre = q.mean(0)
    out = posed((q - centre) @ np.linalg.inv(M).T, M, centre, pose)
    # a dealer card moved where it lies: each stretch it lies still with its own outline, from the
    # frame it is moved there (slid: the frame it plainly lies there; lifted and put down: the
    # frame it is seen still there, its trip until then traced as the reveal's scoop is)
    rnd = lambda quad: [[round(float(x), 2), round(float(y), 2)] for x, y in quad]
    rests, moves, slides = [], [], []
    if search == "dealer":
        found = stays(fr, out, a, b)
        if len(found) > 1:
            rests = [[start, found[0]["quad"]]]
            for prev, s in zip(found, found[1:]):
                if any(felt_inside(fr.get(f), prev["quad"]) >= TRIP_FELT for f in range(prev["last"], s["first"], TRIP_STEP)):
                    rests.append([s["first"], s["quad"]])
                    moves.append([prev["last"] + 1, s["first"]])
                    continue
                # slid along the felt: followed under her fingers, or else moved where it plainly lies
                quads = slide(fr, prev["quad"], s["quad"], prev["last"] + 1, s["first"])
                if quads:
                    slides.append({"from": prev["last"] + 1, "quads": [rnd(q) for q in quads]})
                    rests.append([s["first"], s["quad"]])
                else:
                    rests.append([moved_at(fr, prev["quad"], s["quad"], prev["last"], s["first"]), s["quad"]])
            out = rests[0][1]
    # where it lies last, when it is swept up
    last = rests[-1][1] if rests else out
    rest = float(np.median([still_there(fr.get(int(f)), last) for f in frames]))
    leave = leave_frame(fr, c, last, rest)
    # and the times it is lifted and put back where it lay, stretch by stretch
    found_trips = list(moves)
    for i, (f0, quad) in enumerate(rests or [[a, out]]):
        f0 = max(a, f0)
        f1 = rests[i + 1][0] if i + 1 < len(rests) else leave
        if f1 - f0 < 4:
            continue
        here = float(np.median([still_there(fr.get(f), quad) for f in range(f0, f1, max(1, (f1 - f0) // 12))]))
        found_trips += trips(fr, c, quad, here, f0, f1)
    found_trips = outermost(found_trips)
    return {
        "leave": leave,
        "trips": sorted(found_trips),
        "rests": [[int(f), rnd(quad)] for f, quad in rests[1:]],
        "slides": slides,
        "quad": rnd(out),
        "shift": round(float(np.hypot(pose[0], pose[1])), 2),
        "turn": round(float(np.rad2deg(pose[2])), 2),
        "scale": round(float(pose[3]), 4),
        "frames": len(kept),
        "contrast": round(best, 3),
    }


def run(video: str, cards_json: str, out: str) -> None:
    cards = json.load(open(cards_json))["cards"]
    fr = Frames(video)
    rest = {}
    for c in sorted(cards, key=lambda c: c["birth"]):
        r = settle(fr, c)
        if r is None:
            print(f"{c['id']} {c['region']:5s} kept as tracked", flush=True)
            continue
        rest[c["id"]] = r
        print(f"{c['id']} {c['region']:5s} shift {r['shift']:4.2f}px turn {r['turn']:+5.2f} "
              f"scale {r['scale']:.3f} from {r['frames']} frames (contrast {r['contrast']:.2f}), "
              f"leaves {c['death'] - r['leave']} frames before pickup"
              + (f", moved at {[f for f, _ in r['rests']]}" if r["rests"] else ""), flush=True)
    Path(out).write_text(json.dumps({"rest": rest}, indent=1))
    print(f"{len(rest)} resting outlines -> {out}")


def apply(cards: list[dict], rest_json: str | None) -> list[dict]:
    """The cards with their settled outlines (and the frame each leaves) swapped in, for later passes."""
    if not rest_json or not Path(rest_json).exists():
        return cards
    rest = json.load(open(rest_json))["rest"]
    for c in cards:
        if c["id"] in rest:
            c["quad"] = rest[c["id"]]["quad"]
            c["leave"] = rest[c["id"]].get("leave", c["death"])
            c["trips"] = rest[c["id"]].get("trips", [])
            c["rests"] = rest[c["id"]].get("rests", [])
            c["slides"] = rest[c["id"]].get("slides", [])
    return cards


def rest_at(c: dict, f: int) -> list:
    """The outline a card lies on at frame f: its first (`quad`), or one it was moved to since."""
    q = c["quad"]
    for g, quad in c.get("rests", []):
        if f >= g:
            q = quad
    return q


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3])
