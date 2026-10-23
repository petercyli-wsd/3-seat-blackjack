"""Review sheets: first / middle / last frame of every segment, for eyeballing cut points."""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.video import Frames

W = 300


def thumb(frame, label):
    t = cv2.resize(frame[250:600, 480:1100], (W, int(W * 350 / 620)), interpolation=cv2.INTER_AREA)
    cv2.putText(t, label, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1, cv2.LINE_AA)
    return t


def main(video, edl, out_dir, per_page="12"):
    fr = Frames(video)
    segs = json.load(open(edl))["segments"]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    n = int(per_page)
    for p in range(0, len(segs), n):
        rows = []
        for s in segs[p:p + n]:
            a, b = s["start"], s["end"] - 1
            cells = [thumb(fr.get(f), f"{s['name']} {tag} f{f}") for f, tag in ((a, "in"), ((a + b) // 2, "mid"), (b, "out"))]
            rows.append(np.hstack(cells))
        cv2.imwrite(str(out / f"edl_{p // n:02d}.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    main(*sys.argv[1:])
