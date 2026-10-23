"""Pass 1: stream the whole take once and record per-frame signals.

Everything downstream (segmentation, settle detection, landing times) is
derived from these arrays, so the 400 s video is decoded exactly once here.
"""

import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.colour import card_back_mask, card_mask, felt_mask
from bj3.geometry import REGIONS

TABLE = (600, 400, 960, 560)
BODY = (600, 60, 920, 360)
DEALER = (720, 362, 805, 402)
HANDS = (600, 320, 940, 410)


def crop(a, box):
    x0, y0, x1, y1 = box
    return a[y0:y1, x0:x1]


def run(video: str, out: Path) -> None:
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    names = list(REGIONS)
    card = {k: [] for k in names}
    foreign = {k: [] for k in names}
    back = []
    arm = []
    body_motion = []
    table_motion = []
    dealer_motion = []
    hands_motion = []
    prev = None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        c = card_mask(f)
        fl = felt_mask(f)
        other = cv2.bitwise_not(cv2.bitwise_or(c, fl))
        for k in names:
            card[k].append(crop(c, REGIONS[k]).mean() / 255)
            foreign[k].append(crop(other, REGIONS[k]).mean() / 255)
        back.append(crop(card_back_mask(f), REGIONS["hole"]).mean() / 255)
        arm.append(crop(other, TABLE).mean() / 255)
        g = cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        if prev is None:
            body_motion.append(0.0)
            table_motion.append(0.0)
            dealer_motion.append(0.0)
            hands_motion.append(0.0)
        else:
            d = cv2.absdiff(g, prev)
            body_motion.append(float(crop(d, BODY).mean()))
            table_motion.append(float(crop(d, TABLE).mean()))
            dealer_motion.append(float(crop(d, DEALER).mean()))
            hands_motion.append(float(crop(d, HANDS).mean()))
        prev = g
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        fps=fps,
        names=np.array(names),
        card=np.array([card[k] for k in names]),
        foreign=np.array([foreign[k] for k in names]),
        back=np.array(back),
        arm=np.array(arm),
        body_motion=np.array(body_motion),
        table_motion=np.array(table_motion),
        dealer_motion=np.array(dealer_motion),
        hands_motion=np.array(hands_motion),
    )
    print(f"{len(arm)} frames @ {fps:.3f} fps -> {out}")


if __name__ == "__main__":
    run(sys.argv[1], Path(sys.argv[2]))
