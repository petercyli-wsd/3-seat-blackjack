"""Random-access frame reads with a small sequential cache (cv2 seeking is slow)."""

import cv2
import numpy as np


class Frames:
    def __init__(self, path: str):
        self.cap = cv2.VideoCapture(path)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        self.count = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.pos = -1
        self.last = None

    def get(self, i: int) -> np.ndarray:
        i = max(0, min(self.count - 1, i))
        if i == self.pos:
            return self.last
        if not (0 <= i - self.pos <= 48):
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            self.pos = i - 1
        while self.pos < i:
            ok, f = self.cap.read()
            if not ok:
                raise IndexError(i)
            self.pos += 1
            self.last = f
        return self.last

    def median(self, i: int, n: int = 5) -> np.ndarray:
        stack = [self.get(i + k) for k in range(-(n // 2), n // 2 + 1)]
        return np.median(np.stack(stack), axis=0).astype(np.uint8)
