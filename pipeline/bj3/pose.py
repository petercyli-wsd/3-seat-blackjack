"""Pass 1b: a compact grayscale fingerprint of the dealer's arms, hands and the
discard tray for every frame (quarter resolution, uint8).

Used to choose cut points at the neutral pose (hands resting on the table
edge) and to know when the discard tray is still being used — both things
the felt-only motion signals cannot see.
"""

import sys

import cv2
import numpy as np

BOX = (470, 200, 1000, 420)
SCALE = 4
# dealer card slots and the shoe's card window change with game state, not pose
IGNORE = [(722, 362, 802, 402), (900, 330, 1000, 420)]


def ignore_mask() -> np.ndarray:
    x0, y0, x1, y1 = BOX
    m = np.ones(((y1 - y0) // SCALE, (x1 - x0) // SCALE), bool)
    for a, b, c, d in IGNORE:
        m[(b - y0) // SCALE:(d - y0) // SCALE + 1, (a - x0) // SCALE:(c - x0) // SCALE + 1] = False
    return m


def run(video: str, out: str) -> None:
    cap = cv2.VideoCapture(video)
    x0, y0, x1, y1 = BOX
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(f[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        frames.append(cv2.resize(g, ((x1 - x0) // SCALE, (y1 - y0) // SCALE), interpolation=cv2.INTER_AREA))
    np.savez_compressed(out, pose=np.stack(frames), keep=ignore_mask())
    print(len(frames), "pose fingerprints ->", out)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
