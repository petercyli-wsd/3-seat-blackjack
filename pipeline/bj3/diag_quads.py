"""Diagnostic: draw tracked card quads over a frame, zoomed on the table."""
import json, sys
import cv2, numpy as np
from bj3.video import Frames

COL = {"seat1": (0, 200, 255), "seat2": (0, 255, 0), "seat3": (255, 120, 0), "up": (255, 0, 255), "hole": (0, 0, 255)}

def main(video, cards_json, t, out, x0="600", y0="340", x1="960", y1="560", z="3"):
    fr = Frames(video)
    d = json.load(open(cards_json))
    f = int(float(t) * d["fps"])
    img = fr.get(f).copy()
    for c in d["cards"]:
        if c["birth"] <= f < c["death"]:
            q = np.array(c["quad"], np.float32)
            cv2.polylines(img, [q.round().astype(np.int32)], True, COL[c["region"]], 1)
            cv2.circle(img, tuple(np.round(q[0]).astype(int)), 1, (0, 0, 255), -1)
    crop = img[int(y0):int(y1), int(x0):int(x1)]
    cv2.imwrite(out, cv2.resize(crop, None, fx=int(z), fy=int(z), interpolation=cv2.INTER_NEAREST))

if __name__ == "__main__":
    main(*sys.argv[1:])
