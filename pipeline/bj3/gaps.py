"""How different two frames of the dealer look: the measure re-cutting and
bridge planning optimise.

Frames are compared on the pose fingerprint (quarter-resolution grey of the
dealer's arms, hands and the discard tray; card slots and the shoe window
masked out). For scale: consecutive frames while she rests differ by ~0.2,
and a 0.3 s FILM bridge stays clean up to ~2.5.
"""

import cv2
import numpy as np

# Gap classes, in fingerprint units (see module doc).
CUT = 1.0  # indistinguishable from one frame of her resting motion: a straight cut is invisible
SHORT = 2.5  # a short flow interpolation (FILM / RIFE, ~0.3 s) covers it cleanly
LONG = 5.0  # needs a longer flow bridge (~0.6-0.8 s); above this, a generated move


class Gaps:
    def __init__(self, pose_npz: str):
        z = np.load(pose_npz)
        self.P = z["pose"][:, z["keep"]].astype(np.float32)
        m = np.zeros(len(self.P), np.float32)
        m[1:] = np.abs(self.P[1:] - self.P[:-1]).mean(1)
        self.motion = np.convolve(m, np.ones(5) / 5, "same")

    def d(self, a: int, b: int) -> float:
        return float(np.abs(self.P[a] - self.P[b]).mean())

    def matrix(self, frames_a, frames_b) -> np.ndarray:
        A = self.P[np.asarray(frames_a)]
        B = self.P[np.asarray(frames_b)]
        out = np.empty((len(A), len(B)), np.float32)
        for i in range(len(A)):
            out[i] = np.abs(B - A[i]).mean(1)
        return out


def gap_class(g: float) -> str:
    if g < CUT:
        return "cut"
    if g < SHORT:
        return "short"
    if g < LONG:
        return "long"
    return "generative"


class FlowGap:
    """How hard a bridge between two frames is for a flow interpolator, measured on the pixels
    that actually change (a moving arm is a few percent of the frame; percentiles over the
    whole frame would only see the still wall):

    * motion: 90th percentile optical-flow length over the changed pixels, in source pixels;
    * unexplained: percent of the frame still wrong after warping one frame onto the other
      (occlusion, things appearing) — what flow cannot synthesise at any length.

    Calibrated on this take: consecutive frames 0.9 px / 0.01 %; same shot a few seconds
    apart ~5 / 0.7; body sway between takes ~15 / 1.3; a lean or reach 30-45 / 2-2.5;
    the dealer mid-gesture at the tray 70 / 8.

    The seats are left out: during a bridge they are covered by plates of the game's hands
    (see the app's scene), so their cards don't count.
    """

    ROI = (380, 60, 1120, 600)
    SEAT_BOX = (620, 410, 940, 560)

    def __init__(self):
        self.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        x0, y0, x1, y1 = self.ROI
        m = np.ones(((y1 - y0) // 2, (x1 - x0) // 2), bool)
        a, b, c, d = self.SEAT_BOX
        m[(b - y0) // 2:(d - y0) // 2, (a - x0) // 2:(c - x0) // 2] = False
        self.keep = m

    def _gray(self, bgr):
        x0, y0, x1, y1 = self.ROI
        g = cv2.cvtColor(bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        return cv2.resize(g, ((x1 - x0) // 2, (y1 - y0) // 2), interpolation=cv2.INTER_AREA)

    def __call__(self, a_bgr, b_bgr) -> tuple[float, float]:
        a, b = self._gray(a_bgr), self._gray(b_bgr)
        flow = self.dis.calc(a, b, None)
        mag = np.linalg.norm(flow, axis=2) * 2
        moving = (np.abs(a.astype(np.int16) - b.astype(np.int16)) > 20) & self.keep
        motion = float(np.percentile(mag[moving], 90)) if moving.sum() > 20 else 0.0
        h, w = a.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        warped = cv2.remap(b, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LINEAR)
        wrong = (np.abs(warped.astype(np.int16) - a.astype(np.int16)) > 25) & self.keep
        return motion, float(wrong.sum() / self.keep.sum() * 100)
