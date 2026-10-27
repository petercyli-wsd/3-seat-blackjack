"""Pass 9, with the manifest: when her hand reaches each hand's cards in the discards, for the cards no take holds.

    python -m bj3.discard <full_footage.mp4> [game_assets]

A discard was filmed for every seat combination with two cards in each seat, so a hand of three
or more shows its two real cards plus the rest laid in from a still of a bigger hand (the seat's
plate), where the full-table round's dealer put them, as the hits show them landing. She can't
pick them up, so they fade out just before her hand first comes over the hand's cards; the
graphic dealer draws likewise, before she reaches the dealer's.

For every discard clip, `reach[seat][n]` (a hand of n = 3..6) and `reach["dealer"][k]` (k graphic
draws, 1..5): the clip frame her hand comes over the hand's cards (the real ones, and the laid-in
ones where the app draws them) on the approach that lifts them. That is the first frame of the run
leading into the first pickup in which something that isn't felt or card stock (her hand, her
sleeve) is within MARGIN px of the cards.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.geometry import SEATS
from bj3.video import Frames

MARGIN = 8
MIN_PX = 15
DEALER_DRAWS = 5


def dealer_draw_quad(up: list, i: int) -> list:
    """The app's dealerExtraQuad (scene.ts): a second row just in front of the two real cards."""
    q = np.array(up, np.float64)
    c = np.array([735 + i * 26, 402])
    return (c + (q - q.mean(0)) * 1.03).tolist()


def tableness(bgr: np.ndarray) -> np.ndarray:
    """The app's tableness key (shaders.ts): felt or card stock, as a smooth weight."""
    f = bgr.astype(np.float32) / 255
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    s = lambda e0, e1, x: (t := np.clip((x - e0) / (e1 - e0), 0, 1)) * t * (3 - 2 * t)
    felt = s(0.03, 0.12, b - np.maximum(r, g))
    card = s(0.55, 0.70, f.min(axis=2)) * (1 - s(0.02, 0.06, r - b))
    return np.maximum(felt, card)


def area(quads: list, shape: tuple) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    for q in quads:
        cv2.fillConvexPoly(m, np.array(q, np.float32).round().astype(np.int32), 1)
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * MARGIN + 1, 2 * MARGIN + 1))) > 0


def reach(frames: list[np.ndarray], region: np.ndarray, lift: int) -> int:
    """First frame of the run, ending at the frame before `lift`, with her over `region`."""
    ys, xs = np.nonzero(region)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    region = region[y0:y1, x0:x1]
    keyed = [tableness(f[y0:y1, x0:x1]) for f in frames[:lift]]
    # table at rest at the start of the clip: only what comes over it later counts
    rest = region & (np.max(keyed[:3], axis=0) >= 0.5)
    f = lift
    while f > 0 and np.count_nonzero(rest & (keyed[f - 1] < 0.3)) >= MIN_PX:
        f -= 1
    return f


def run(video: str, assets: str = "../game_assets") -> None:
    path = Path(assets) / "manifest.json"
    m = json.loads(path.read_text())
    fr = Frames(video)
    shape = (m["height"], m["width"])
    for name, clip in sorted(m["clips"].items()):
        if clip["kind"] != "discard":
            continue
        frames = [fr.get(clip["sourceStart"] + f).copy() for f in range(clip["frames"])]
        out = {}
        for seat in SEATS:
            real = {c["index"]: c for c in clip["cards"] if c["slot"] == seat}
            if sorted(real) != [1, 2]:
                continue
            lift = min(c["out"] for c in real.values())
            out[seat] = {}
            for n in range(3, 7):
                extras = m["plates"][seat][str(n)]["cards"][2:]
                out[seat][str(n)] = reach(frames, area([real[1]["quad"], real[2]["quad"], *extras], shape), lift)
            print(f"  {name} {seat}: first pickup {lift}, hand reaches it at {out[seat]}")
        dealer = [c for c in clip["cards"] if c["slot"] in ("up", "hole")]
        if dealer:
            lift = min(c["out"] for c in dealer)
            real = [c["quad"] for c in dealer]
            out["dealer"] = {str(k): reach(frames, area(real + [dealer_draw_quad(m["dealer"]["up"], i) for i in range(k)], shape), lift)
                             for k in range(1, DEALER_DRAWS + 1)}
            print(f"  {name} dealer: first pickup {lift}, hand reaches it at {out['dealer']}")
        clip["reach"] = out
    path.write_text(json.dumps(m, indent=1))
    print(f"reach written for the discards -> {path}")


if __name__ == "__main__":
    run(*sys.argv[1:])
