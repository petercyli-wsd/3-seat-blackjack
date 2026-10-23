"""Pixel classes on the blue-screen table.

Measured on the footage: card stock reads as bluish white (S < 35, V > 200,
B >= R), the felt as saturated blue (H 100-120, S > 150), and skin as a warm
low-saturation highlight (R - B ~ +35) that a naive "bright and unsaturated"
test would mistake for a card. The R - B guard is what separates them.
"""

import cv2
import numpy as np


def card_mask(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    b = bgr[..., 0].astype(np.int16)
    r = bgr[..., 2].astype(np.int16)
    m = (hsv[..., 1] < 48) & (hsv[..., 2] > 180) & ((r - b) < 14)
    return m.astype(np.uint8) * 255


def felt_mask(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    m = (hsv[..., 0] >= 98) & (hsv[..., 0] <= 125) & (hsv[..., 1] > 140) & (hsv[..., 2] > 50)
    return m.astype(np.uint8) * 255


def card_back_mask(bgr: np.ndarray) -> np.ndarray:
    """The maroon back of the dealer's face-down card."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h = hsv[..., 0]
    m = ((h >= 150) | (h <= 8)) & (hsv[..., 1] > 55) & (hsv[..., 2] > 70) & (hsv[..., 2] < 160)
    return m.astype(np.uint8) * 255
