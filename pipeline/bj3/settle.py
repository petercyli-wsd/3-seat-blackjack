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

It also finds where each card *leaves*: the frame its resting outline loses
its edges for good, as the dealer starts sweeping it up. The tracker's pickup
frame is later (when most of the outline is bare felt), and a face kept on
the resting outline until then is painted onto whatever passes beneath it.
"""

import json
import sys
from pathlib import Path

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
    rest = float(np.median([still_there(fr.get(int(f)), out) for f in frames]))
    return {
        "leave": leave_frame(fr, c, out, rest),
        "quad": [[round(float(x), 2), round(float(y), 2)] for x, y in out],
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
              f"leaves {c['death'] - r['leave']} frames before pickup", flush=True)
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
    return cards


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3])
