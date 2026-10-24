"""Pass 3c: where each card is while the dealer slides it in.

The tracker measures a card once it lies still. Before that, it travels face
up under her fingers from where she turned it over to where it lands, and
the face has to ride along or the card is blank until it settles.

Each face-up card is followed backward from its landing frame. The card is
rigid and lies on the table, so every frame is a pose of its own settled
outline: a shift, a turn about the table's normal and a scale (the table
recedes toward the shoe). Turns are made in table space: the settled
outline is factored into a true 63 x 88 card turned on the table, then the
table's local map into the image (`table_map`), and only the turn changes.

A pose is scored on the card stock that is *moving*: this frame's card
pixels minus the cards that lie on the table around it. The outline should
be full of it and the thin ring around the outline empty of it. Fingers on
the card are skin, so they count for neither and cost every pose alike.

The trace stops, going back, where the outline stops finding card stock:
the card is still face down, edge on or lifted in her hand. A card that lay
still for a while before the tracker saw it land (a hand beside it kept the
region from settling) is followed back to where it really came down.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.rigid import depth_scale, posed, sample, soft_card, table_map
from bj3.settle import apply, edge_contrast
from bj3.video import Frames

MAX_BACK = 240
# followed off its resting place no further than this past the tracker's pickup frame
AWAY_PAST = 24
PAD = 70
# inside the outline must be at least this much moving card stock to keep tracing
MIN_FILL = 0.42
MIN_SCORE = 0.30


def _grid(n_u: int, n_v: int, lo: float, hi: float) -> np.ndarray:
    u, v = np.meshgrid(np.linspace(lo, hi, n_u), np.linspace(lo, hi, n_v))
    return np.stack([u.ravel(), v.ravel()], 1).astype(np.float32)


INSIDE = _grid(9, 12, 0.08, 0.92)


def _ring(off: float, n: int = 14) -> np.ndarray:
    t = np.linspace(-off, 1 + off, n, dtype=np.float32)
    lo, hi = np.full(n, -off, np.float32), np.full(n, 1 + off, np.float32)
    return np.concatenate([np.stack([t, lo], 1), np.stack([t, hi], 1),
                           np.stack([lo, t], 1), np.stack([hi, t], 1)])


RING = _ring(0.16)


def _uv_to_quad(uv: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Bilinear map of face UVs onto quads; q: (..., 4, 2) TL TR BR BL -> (..., N, 2)."""
    u, v = uv[:, 0, None], uv[:, 1, None]
    a, b, c, d = q[..., 0, None, :], q[..., 1, None, :], q[..., 2, None, :], q[..., 3, None, :]
    return (1 - v) * ((1 - u) * a + u * b) + v * ((1 - u) * d + u * c)


def score(moving: np.ndarray, free: np.ndarray, quads: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(score, fill) per quad. Fill counts only the part of the outline off the cards already
    lying there: a hit card sliding onto its stack shows nothing new where it covers them."""
    inside = _uv_to_quad(INSIDE, quads)
    room = np.maximum(sample(free, inside).sum(-1), 0.25 * len(INSIDE))
    fill = sample(moving, inside).sum(-1) / room
    spill = sample(moving, _uv_to_quad(RING, quads)).mean(-1)
    return fill - 1.2 * spill, fill


# fine search: score lost per px / degree away from the predicted pose, so a card whose edges
# are mostly under her fingers holds its pose instead of drifting where the evidence is weak
PRIOR_PX, PRIOR_DEG = 0.03, 0.03


def _search(moving, free, frame, p0, reach, turn, step, turn_step, edges=False, expect=None):
    """Best pose near p0 as (pose, score, fill). Scale isn't searched: on the table it follows
    from how far up or down the image the card has moved (`depth_scale`). With `edges`, the
    card's edge contrast joins the score, which pins it to a fraction of a pixel, and poses pay
    for straying from the predicted pose `expect` (default p0)."""
    d = np.arange(-reach, reach + 1e-6, step, dtype=np.float32)
    a = np.deg2rad(np.arange(-turn, turn + 1e-6, turn_step, dtype=np.float32))
    g = np.stack(np.meshgrid(d, d, a, indexing="ij"), -1).reshape(-1, 3)
    p = np.concatenate([g + p0[:3], np.ones((len(g), 1), np.float32)], 1)
    y0 = float(frame[2][1])
    p[:, 3] = depth_scale(y0, y0 + p[:, 1])
    quads = posed(*frame, p)
    sc, fill = score(moving, free, quads)
    rank = sc
    if edges:
        e = p0 if expect is None else expect
        rank = (sc + edge_contrast(moving, quads) - PRIOR_PX * np.hypot(*(p[:, :2] - e[:2]).T)
                - PRIOR_DEG * np.abs(np.rad2deg(p[:, 2] - e[2])))
    i = int(np.argmax(rank))
    return p[i], float(sc[i]), float(fill[i])


def _poly(shape, quad, grow: int = 0) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, np.asarray(quad).round().astype(np.int32), 1)
    if grow:
        m = cv2.dilate(m, np.ones((grow, grow), np.uint8))
    return m


def _window(fr: Frames, q: np.ndarray):
    """Search crop around a card's resting outline: (crop fn, crop offset, crop shape)."""
    cx, cy = q.mean(0)
    # cards come in from the shoe side and further up the table, and are swept off to the left
    x0, y0 = max(0, int(cx) - PAD - 60), max(0, int(cy) - PAD - 50)
    x1, y1 = min(fr.width, int(cx) + PAD + 140), min(fr.height, int(cy) + PAD)
    return (lambda img: img[y0:y1, x0:x1]), np.array([x0, y0], np.float32), (y1 - y0, x1 - x0)


REST = np.array([0, 0, 0, 1], np.float32)
# a card lying still can be hidden this long (her arm passing over it) and still be there after
MAX_HIDDEN = 36
# poses this close are the same place: a card lying still (STILL_RUN frames or more) is drawn
# at one pose there, the resting pose itself if it is that close to it
STILL_PX, STILL_DEG, STILL_SCALE = 1.0, 1.0, 0.012
STILL_RUN = 4
STEADY = np.array([1, 4, 6, 4, 1], np.float32) / 16


def _near(a: np.ndarray, b: np.ndarray) -> bool:
    return (np.hypot(a[0] - b[0], a[1] - b[1]) < STILL_PX and abs(np.rad2deg(a[2] - b[2])) < STILL_DEG
            and abs(a[3] - b[3]) < STILL_SCALE)


def _was_still(seen: list) -> bool:
    """Whether the card lay still just now: STILL_RUN poses in one place among the last few. By
    position only: as a hand arrives over a card its turn is the first thing to be fitted askew."""
    # the still stretch must reach to within the last couple of fits, or it is history
    recent = seen[-(STILL_RUN + 2):]
    return any(all(np.hypot(*(x[:2] - recent[i][:2])) < STILL_PX for x in recent[i:i + STILL_RUN])
               for i in range(len(recent) - STILL_RUN + 1))


def _steady(poses: list) -> np.ndarray:
    """Per-frame fits jitter by a fraction of a pixel and degree, which shows as the face wobbling
    on its card wherever the card moves slowly or not at all. Gaps (frames the card was hidden)
    are interpolated; each stretch of the card lying still is drawn at one pose (its median, or
    the resting pose when next to rest and that close to it); the moving frames are smoothed in
    time, continuing from rest."""
    P = np.array([REST * np.nan if p is None else p for p in poses], np.float32).reshape(-1, 4)
    n = len(P)
    if not n:
        return P
    idx = np.arange(n)
    for k in range(4):
        known = ~np.isnan(P[:, k])
        P[:, k] = np.interp(idx, np.concatenate([[-1], idx[known]]), np.concatenate([[REST[k]], P[known, k]]))
    held = np.zeros(n, bool)
    i = 0
    while i < n:
        j = i + 1
        while j < n and _near(P[j], np.median(P[i:j], 0)):
            j += 1
        if j - i >= STILL_RUN or (i == 0 and _near(P[0], REST)):
            at = np.median(P[i:j], 0)
            P[i:j] = REST if i == 0 and _near(at, REST) else at
            held[i:j] = True
            i = j
        else:
            i += 1
    padded = np.concatenate([np.repeat(REST[None], 2, 0), P, np.repeat(P[-1:], 2, 0)])
    smooth = np.stack([np.convolve(padded[:, k], STEADY, "valid") for k in range(4)], 1)
    P[~held] = smooth[~held]
    return P


def _follow(fr: Frames, frames, q: np.ndarray, crop, off, bg: np.ndarray):
    """Follow the card from its resting outline q through `frames` (walking away from rest) while
    its outline keeps finding moving card stock. Returns (quads nearest rest first, last pose, model)."""
    free = 1 - bg
    M = table_map(q)
    centre = (q - off).mean(0)
    frame = (((q - off) - centre) @ np.linalg.inv(M).T, M, centre)
    pose = REST.copy()
    vel = np.zeros(4, np.float32)
    poses, misses = [], 0
    seen = [REST] * STILL_RUN  # fitted poses, latest last; it starts lying at rest
    for f in frames:
        moving = np.clip(soft_card(crop(fr.get(f))) - bg, 0, 1)
        guess = pose + vel
        p, sc, fill = _search(moving, free, frame, guess, reach=12, turn=10, step=2, turn_step=2.5)
        p, sc, fill = _search(moving, free, frame, p, reach=2, turn=2.5, step=0.25, turn_step=0.5,
                              edges=True, expect=guess)
        if fill < MIN_FILL or sc < MIN_SCORE:
            misses += 1
            # lying still it is only hidden (her arm over it): wait for it to show again there;
            # on the move, one bad frame (a blur, a finger across most of it) holds the motion
            still = _was_still(seen)
            if misses >= (MAX_HIDDEN if still else 2):
                break
            if still:
                vel[:] = 0
            poses.append(None)
            pose = guess
            continue
        misses = 0
        step = p - pose
        # a move this small is fitting noise, not motion: don't carry it on to the next frame
        if np.hypot(step[0], step[1]) < 0.5 and abs(np.rad2deg(step[2])) < 0.5:
            step[:] = 0
        vel = 0.5 * vel + 0.5 * step
        vel[3] = 0
        pose = p
        poses.append(p)
        seen.append(p)
    while poses and poses[-1] is None:
        poses.pop()
    quads = [posed(*frame, p) + off for p in _steady(poses)]
    return quads, pose, frame, _was_still(seen)


def trace(fr: Frames, card: dict, before: int) -> tuple[int, list]:
    """Quads for the frames before `card` lands; (first frame, quads in time order)."""
    q = np.asarray(card["quad"], np.float32)
    land = card["birth"]
    crop, off, shape = _window(fr, q)
    # what lies on the table around the card: the frame before it came, and the
    # frame it settled on with its own outline cut out (the card it lands on shows)
    bg_before = soft_card(crop(fr.median(before)))
    own = _poly(shape, q - off, grow=5)
    bg_after = soft_card(crop(fr.median(card["sample"]))) * (1 - own)
    bg = cv2.dilate(np.maximum(bg_before, bg_after), np.ones((5, 5), np.uint8))
    quads, pose, frame, _ = _follow(fr, range(land - 1, max(-1, land - 1 - MAX_BACK), -1), q, crop, off, bg)
    # before it lay flat, the card was coming down out of her hand face up: tilted up off the table
    if quads:
        for f in range(land - 1 - len(quads), max(-1, land - 1 - len(quads) - TILT_BACK), -1):
            moving = np.clip(soft_card(crop(fr.get(f))) - bg, 0, 1)
            found = _search_tilt(moving, 1 - bg, frame, pose)
            if found is None:
                break
            quads.append(found + off)
    quads = quads[::-1]
    return land - len(quads), quads


def trace_away(fr: Frames, card: dict) -> tuple[int, list]:
    """Quads from the frame `card` leaves its resting outline, while it is swept off on its own;
    (first frame, quads in time order). It stops where the card joins the pile in her hand: its
    outline is then ringed by other moving cards."""
    q = np.asarray(card["quad"], np.float32)
    leave = card["leave"]
    crop, off, shape = _window(fr, q)
    # the cards still lying around it just before it moved, without itself
    own = _poly(shape, q - off, grow=5)
    bg = cv2.dilate(soft_card(crop(fr.median(leave - 4))) * (1 - own), np.ones((5, 5), np.uint8))
    # until the pickup (an early `leave` just follows it lying still) and a little past it
    quads, _, _, _ = _follow(fr, range(leave, min(fr.count, card["death"] + AWAY_PAST)), q, crop, off, bg)
    return leave, quads


TILT_BACK = 3
TILT_FILL = 0.5  # a tilted fit has more freedom, so it must find more of the card to count
# beyond this the card is near edge on: little face shows, and a sliver fits anything white
TILTS = np.arange(10, 56, 5, dtype=np.float32)


def tilted(frame, p: np.ndarray, edge: int, theta: float) -> np.ndarray:
    """Quads (image) for poses p (N, 4) with the card swung up `theta` degrees about one edge
    (corners edge, edge + 1) as a hinge resting on the table.

    Swinging up shortens the card across the hinge on the table plane and lifts its far side.
    With the camera square to the table, height shows as straight up the image, at the table
    map's px/mm across (a) times the cosine of the camera's elevation (sin = d / a)."""
    rel_t, M, centre = frame
    cs, sn = np.cos(p[:, 2]), np.sin(p[:, 2])
    R = np.stack([np.stack([cs, -sn], -1), np.stack([sn, cs], -1)], -2)
    c = np.einsum("nij,kj->nki", R, rel_t) * p[:, 3, None, None]  # (N, 4, 2) table mm
    a, b = c[:, edge], c[:, (edge + 1) % 4]
    d = (b - a) / np.linalg.norm(b - a, axis=-1, keepdims=True)
    n = np.stack([-d[:, 1], d[:, 0]], -1)
    n *= np.sign(((c.mean(1) - a) * n).sum(-1))[:, None]  # into the card
    r = ((c - a[:, None]) * n[:, None]).sum(-1)  # (N, 4) distance from the hinge
    t = np.deg2rad(theta)
    flat = c + n[:, None] * (r * (np.cos(t) - 1))[..., None]
    img = flat @ M.T + centre + p[:, None, :2]
    up = float(M[0, 0]) * np.sqrt(max(0.0, 1 - (float(M[1, 1]) / float(M[0, 0])) ** 2))
    img[..., 1] -= up * r * np.sin(t)
    return img


def _search_tilt(moving, free, frame, p0) -> np.ndarray | None:
    """The best tilted pose near p0 (one frame further back than the card lay flat), if the card shows."""
    d = np.arange(-8, 8.1, 2, dtype=np.float32)
    a = np.deg2rad(np.arange(-10, 10.1, 5, dtype=np.float32))
    g = np.stack(np.meshgrid(d, d, a, indexing="ij"), -1).reshape(-1, 3)
    p = np.concatenate([g + p0[:3], np.full((len(g), 1), p0[3], np.float32)], 1)
    best = (-1e9, 0.0, None)
    for edge in range(4):
        for theta in TILTS:
            qs = tilted(frame, p, edge, float(theta))
            sc, fill = score(moving, free, qs)
            i = int(np.argmax(sc))
            if sc[i] > best[0]:
                best = (float(sc[i]), float(fill[i]), qs[i])
    sc, fill, quad = best
    return quad if fill >= TILT_FILL and sc >= MIN_SCORE else None


SLIDE_APART = 3.0  # px two overlapping cards may shift against each other before their faces end
OVERLAP = 0.1  # share of the smaller card two outlines must cover to count as overlapping


def untangle(cards: list[dict], paths: dict) -> None:
    """End swept-up cards' faces where the pile forms.

    A stack pushed along as one keeps its order, so its faces can ride with it. Once two
    overlapping cards slide against each other they are being gathered into a pile whose order
    the footage doesn't show, and two faces drawn there tangle. Each card's `away` path is cut
    at the first frame it has shifted more than SLIDE_APART against any card it overlaps.
    """
    def quad_at(c, f):
        away = paths.get(c["id"], {}).get("away")
        if away and f >= away["from"]:
            i = f - away["from"]
            return np.asarray(away["quads"][i], np.float32) if i < len(away["quads"]) else None
        return np.asarray(c["quad"], np.float32) if c["birth"] <= f < c["death"] else None

    swept = [c for c in cards if paths.get(c["id"], {}).get("away", {}).get("quads")]
    cut = {}
    for c in swept:
        away = paths[c["id"]]["away"]
        for f in range(away["from"], away["from"] + len(away["quads"])):
            if f >= cut.get(c["id"], f + 1):
                break
            q = quad_at(c, f)
            for o in cards:
                if o is c or (p := quad_at(o, f)) is None:
                    continue
                area, _ = cv2.intersectConvexConvex(q, p)
                # cards lying edge to edge (the up and hole cards) only touch
                if area <= OVERLAP * min(cv2.contourArea(q), cv2.contourArea(p)):
                    continue
                moved = (q.mean(0) - np.asarray(c["quad"]).mean(0)) - (p.mean(0) - np.asarray(o["quad"]).mean(0))
                if np.hypot(*moved) > SLIDE_APART:
                    cut[c["id"]] = min(cut.get(c["id"], f), f)
                    if o["id"] in paths and paths[o["id"]].get("away"):
                        cut[o["id"]] = min(cut.get(o["id"], f), f)
    for cid, f in cut.items():
        away = paths[cid]["away"]
        away["quads"] = away["quads"][:max(0, f - away["from"])]


def _rounded(quads: list) -> list:
    return [[[round(float(x), 2), round(float(y), 2)] for x, y in q] for q in quads]


def run(video: str, cards_json: str, out: str, rest_json: str | None = None) -> None:
    cards = apply(json.load(open(cards_json))["cards"], rest_json)
    fr = Frames(video)
    paths = {}
    for c in sorted(cards, key=lambda c: c["birth"]):
        entry, said = {}, []
        # the hole card comes in face down; its face only shows once flipped, so it has no slide-in
        if not c["face_down"]:
            before = next(int(n.split("=")[1]) for n in c["notes"] if n.startswith("before="))
            start, quads = trace(fr, c, before)
            entry.update({"from": start, "quads": _rounded(quads)})
            said.append(f"traced {len(quads)} frames back")
        if "leave" in c and (not c["face_down"] or c["flip"] is not None):
            leave, away = trace_away(fr, c)
            entry["away"] = {"from": leave, "quads": _rounded(away)}
            said.append(f"{len(away)} on from leaving at {leave}")
        if entry:
            paths[c["id"]] = entry
            print(f"{c['id']} {c['region']:5s} lands {c['birth']}: " + ", ".join(said), flush=True)
    untangle(cards, paths)
    Path(out).write_text(json.dumps({"paths": paths}, indent=1))
    print(f"{len(paths)} flight paths -> {out}")


def overlay(video: str, cards_json: str, flights_json: str, card_id: str, out: str) -> None:
    """Contact sheet of one card's traced path drawn over the footage."""
    card = next(c for c in json.load(open(cards_json))["cards"] if c["id"] == card_id)
    path = json.load(open(flights_json))["paths"][card_id]
    fr = Frames(video)
    cx, cy = np.asarray(card["quad"]).mean(0)
    x0, y0 = max(0, int(cx) - 200), max(0, int(cy) - 140)
    tiles = []
    for f in range(path["from"] - 3, card["birth"] + 3):
        im = fr.get(f).copy()
        i = f - path["from"]
        q = path["quads"][i] if 0 <= i < len(path["quads"]) else (card["quad"] if f >= card["birth"] else None)
        if q is not None:
            cv2.polylines(im, [np.asarray(q).round().astype(np.int32)], True, (0, 0, 255) if f < card["birth"] else (0, 255, 0), 1, cv2.LINE_AA)
            cv2.circle(im, tuple(np.asarray(q[0]).round().astype(int)), 2, (0, 255, 255), -1)
        t = cv2.resize(im[y0:y0 + 200, x0:x0 + 320], None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
        cv2.putText(t, str(f), (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        tiles.append(t)
    cols = 4
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))


if __name__ == "__main__":
    run(*sys.argv[1:5])
