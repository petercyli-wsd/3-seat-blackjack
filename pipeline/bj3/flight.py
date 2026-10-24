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

from bj3.rigid import posed, sample, soft_card, table_map
from bj3.settle import apply
from bj3.video import Frames

MAX_BACK = 240
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


def score(moving: np.ndarray, quads: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    fill = sample(moving, _uv_to_quad(INSIDE, quads)).mean(-1)
    spill = sample(moving, _uv_to_quad(RING, quads)).mean(-1)
    return fill - 1.2 * spill, fill


def _search(moving, frame, p0, reach, turn, scales, step, turn_step):
    d = np.arange(-reach, reach + 1e-6, step, dtype=np.float32)
    a = np.deg2rad(np.arange(-turn, turn + 1e-6, turn_step, dtype=np.float32))
    s = np.asarray(scales, np.float32)
    g = np.stack(np.meshgrid(d, d, a, s, indexing="ij"), -1).reshape(-1, 4)
    p = g + np.array([p0[0], p0[1], p0[2], 0], np.float32)
    p[:, 3] *= p0[3]
    sc, fill = score(moving, posed(*frame, p))
    i = int(np.argmax(sc))
    return p[i], float(sc[i]), float(fill[i])


def _poly(shape, quad, grow: int = 0) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, np.asarray(quad).round().astype(np.int32), 1)
    if grow:
        m = cv2.dilate(m, np.ones((grow, grow), np.uint8))
    return m


def trace(fr: Frames, card: dict, before: int) -> tuple[int, list]:
    """Quads for the frames before `card` lands, nearest the landing first; (first frame, quads)."""
    q = np.asarray(card["quad"], np.float32)
    land = card["birth"]
    cx, cy = q.mean(0)
    # the card slides in from the shoe side and from further up the table
    x0, y0 = int(cx) - PAD - 60, int(cy) - PAD - 50
    x1, y1 = int(cx) + PAD + 140, int(cy) + PAD
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(fr.width, x1), min(fr.height, y1)
    crop = lambda img: img[y0:y1, x0:x1]
    off = np.array([x0, y0], np.float32)

    # what lies on the table around the card: the frame before it came, and the
    # frame it settled on with its own outline cut out (the card it lands on shows)
    shape = (y1 - y0, x1 - x0)
    bg_before = soft_card(crop(fr.median(before)))
    own = _poly(shape, q - off, grow=5)
    bg_after = soft_card(crop(fr.median(card["sample"]))) * (1 - own)
    bg = cv2.dilate(np.maximum(bg_before, bg_after), np.ones((5, 5), np.uint8))

    M = table_map(q)
    centre = (q - off).mean(0)
    frame = (((q - off) - centre) @ np.linalg.inv(M).T, M, centre)
    pose = np.array([0, 0, 0, 1], np.float32)
    vel = np.zeros(4, np.float32)
    quads, misses = [], 0
    for f in range(land - 1, max(-1, land - 1 - MAX_BACK), -1):
        moving = np.clip(soft_card(crop(fr.get(f))) - bg, 0, 1)
        guess = pose + vel
        guess[3] = np.clip(guess[3], 0.8, 1.15)
        p, sc, fill = _search(moving, frame, guess, reach=12, turn=10,
                              scales=(0.96, 1.0, 1.04), step=2, turn_step=2.5)
        p, sc, fill = _search(moving, frame, p, reach=2, turn=2.5,
                              scales=(0.985, 1.0, 1.015), step=0.5, turn_step=0.625)
        if fill < MIN_FILL or sc < MIN_SCORE:
            misses += 1
            if misses >= 2:
                break
            # one bad frame (a blur, a finger across most of it): hold the motion
            quads.append(None)
            pose = guess
            continue
        misses = 0
        vel = 0.5 * vel + 0.5 * (p - pose)
        vel[3] = 0
        pose = p
        quads.append(posed(*frame, p) + off)
    while quads and quads[-1] is None:
        quads.pop()
    # fill single dropped frames from their neighbours
    for i, v in enumerate(quads):
        if v is None:
            quads[i] = (quads[i - 1] + quads[i + 1]) / 2 if 0 < i < len(quads) - 1 else quads[i - 1]
    quads = quads[::-1]
    return land - len(quads), quads


def _smooth(quads: list, end: np.ndarray) -> list:
    """Light [1 2 1] smoothing in time, pinned to the landing outline so the hand-off is exact."""
    if len(quads) < 3:
        return quads
    a = np.stack(quads + [end])
    s = a.copy()
    s[1:-1] = (a[:-2] + 2 * a[1:-1] + a[2:]) / 4
    return list(s[:-1])


def run(video: str, cards_json: str, out: str, rest_json: str | None = None) -> None:
    cards = apply(json.load(open(cards_json))["cards"], rest_json)
    fr = Frames(video)
    paths = {}
    for c in sorted(cards, key=lambda c: c["birth"]):
        if c["face_down"]:
            continue
        before = next(int(n.split("=")[1]) for n in c["notes"] if n.startswith("before="))
        start, quads = trace(fr, c, before)
        quads = _smooth(quads, np.asarray(c["quad"], np.float32))
        paths[c["id"]] = {"from": start, "quads": [[[round(float(x), 2), round(float(y), 2)] for x, y in q] for q in quads]}
        print(f"{c['id']} {c['region']:5s} lands {c['birth']}: traced {len(quads)} frames back", flush=True)
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
