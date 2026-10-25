"""Quality checks for generated bridges, and a review page to look at them.

    python -m bj3.bridges review        # bridges/review.html over every ingested bridge

Each bridge is scored against the footage it joins, on the dealer region (the
seats are bare felt in bridges and covered by plates in the game):

* seams: how different the first bridge frame is from the exit frame, and the
  last from the entry frame, relative to how much the dealer moves per frame
  (in the bridge and in the footage either side) — a jump at either end is a
  visible pop;
* spike: the biggest step inside the bridge relative to its median step —
  a flicker, a glitch frame, a sudden lurch;
* frozen: steps of (almost) nothing — a held frame that stutters;
* tone: mean brightness / colour drift of the bridge from the two ends —
  a generative model re-grading the shot.

Flags are thresholds on those, tuned to catch what reads as a glitch at
full speed; everything is listed on the review page for a human verdict.
"""

from dataclasses import dataclass

import numpy as np

ROI = (380, 60, 1120, 600)
SEAT_BOX = (620, 410, 940, 560)


def _region(f: np.ndarray) -> np.ndarray:
    x0, y0, x1, y1 = ROI
    r = f[y0:y1:2, x0:x1:2].astype(np.float32)
    a, b, c, d = SEAT_BOX
    r[(b - y0) // 2:(d - y0) // 2, (a - x0) // 2:(c - x0) // 2] = 0
    return r


@dataclass
class Quality:
    seam_in: float  # exit frame -> first bridge frame, in yardstick steps (see assess)
    seam_out: float  # last bridge frame -> entry frame, in yardstick steps
    spike: float  # largest step inside the bridge, in yardstick steps
    frozen: int  # bridge steps that barely move
    tone: float  # brightness drift from the ends, 0-255
    flags: list[str]


def _steps(frames: list[np.ndarray]) -> list[float]:
    return [float(np.abs(b - a).mean()) for a, b in zip(frames, frames[1:])]


def assess(exit_stub: list[np.ndarray], bridge: list[np.ndarray], entry_stub: list[np.ndarray]) -> Quality:
    """`exit_stub` ends on the exit frame, `entry_stub` starts on the entry frame."""
    seq = [_region(exit_stub[-1])] + [_region(f) for f in bridge] + [_region(entry_stub[0])]
    steps = _steps(seq)
    inner = steps[1:-1] or steps
    # a still stretch in the bridge (generative models often hold) mustn't make an ordinary
    # step at a seam look like a jump: the yardstick is also how she moves in the footage
    around = _steps([_region(f) for f in exit_stub]) + _steps([_region(f) for f in entry_stub])
    base = max(float(np.median(inner)), float(np.median(around)) if around else 0.0, 0.6)
    seam_in, seam_out = steps[0] / base, steps[-1] / base
    spike = max(inner) / base
    frozen = sum(1 for s in inner if s < 0.25)
    ends = (float(seq[0].mean()) + float(seq[-1].mean())) / 2
    tone = max(abs(float(f.mean()) - ends) for f in seq[1:-1]) if len(seq) > 2 else 0.0
    flags = []
    if seam_in > 3.0:
        flags.append("pop at start")
    if seam_out > 3.0:
        flags.append("pop at end")
    if spike > 3.5 and max(inner) > 2.0:
        flags.append("glitch mid-bridge")
    if frozen >= 2 and len(inner) <= 20:
        flags.append("held frames")
    if tone > 4.0:
        flags.append("tone drift")
    r2 = lambda x: round(float(x), 2)
    return Quality(r2(seam_in), r2(seam_out), r2(spike), int(frozen), r2(tone), flags)
