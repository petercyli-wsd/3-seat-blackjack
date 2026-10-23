"""Diagnostic: render the signal arrays as a strip chart (no matplotlib dependency)."""

import sys
from pathlib import Path

import cv2
import numpy as np


def strip(rows, fps, t0, t1, px_per_s=20, row_h=70, marks=()):
    n = len(rows)
    w = int((t1 - t0) * px_per_s) + 120
    img = np.full((row_h * n + 30, w, 3), 24, np.uint8)
    f0, f1 = int(t0 * fps), int(t1 * fps)
    for i, (name, arr, colour, hi) in enumerate(rows):
        y0 = 30 + i * row_h
        cv2.putText(img, name, (4, y0 + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)
        seg = np.asarray(arr[f0:f1], float)
        xs = 120 + (np.arange(len(seg)) / fps) * px_per_s
        ys = y0 + row_h - 6 - np.clip(seg / hi, 0, 1) * (row_h - 12)
        pts = np.stack([xs, ys], 1).astype(np.int32)
        cv2.polylines(img, [pts], False, colour, 1, cv2.LINE_AA)
        cv2.line(img, (120, y0 + row_h - 3), (w, y0 + row_h - 3), (60, 60, 60), 1)
    for s in range(int(t0), int(t1) + 1):
        x = 120 + int((s - t0) * px_per_s)
        cv2.line(img, (x, 22), (x, 28 if s % 5 else 18), (150, 150, 150), 1)
        if s % 5 == 0:
            cv2.putText(img, f"{s // 60}:{s % 60:02d}", (x + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (220, 220, 0), 1)
    for t, colour in marks:
        x = 120 + int((t - t0) * px_per_s)
        cv2.line(img, (x, 22), (x, img.shape[0]), colour, 1)
    return img


def main(npz: str, out: str, t0: float, t1: float, marks_file: str | None = None):
    d = np.load(npz)
    fps = float(d["fps"])
    names = list(d["names"])
    card = d["card"]
    k = max(1, int(fps * 0.25))
    sm = lambda a: np.convolve(a, np.ones(k) / k, "same")
    rows = [(f"card {n}", card[i], (90, 230, 255), 0.6) for i, n in enumerate(names)]
    rows.append(("hole back", d["back"], (120, 120, 255), 0.8))
    rows.append(("arm on table", sm(d["arm"]), (120, 255, 120), 0.25))
    rows.append(("body motion", sm(d["body_motion"]), (255, 160, 90), 3.0))
    rows.append(("table motion", sm(d["table_motion"]), (255, 90, 200), 2.0))
    marks = []
    if marks_file:
        import json
        for m in json.load(open(marks_file)):
            marks.append((m, (0, 0, 255)))
    cv2.imwrite(out, strip(rows, fps, t0, t1, marks=marks))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), sys.argv[5] if len(sys.argv) > 5 else None)
