"""A card as a rigid outline on the table: how it is posed and what it is measured on.

Shared by `settle` (cards at rest) and `flight` (cards slid in).
"""

import cv2
import numpy as np

CARD_MM = np.array([63.0, 88.0], np.float32)


def soft_card(bgr: np.ndarray) -> np.ndarray:
    """1.0 on card stock, 0.0 on felt / skin / sleeve, at source resolution."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    warm = bgr[..., 2].astype(np.float32) - bgr[..., 0].astype(np.float32)
    s, v = hsv[..., 1], hsv[..., 2]
    return np.clip((200 - s) / 150, 0, 1) * np.clip((v - 120) / 60, 0, 1) * np.clip((24 - warm) / 10, 0, 1)


def table_map(q: np.ndarray) -> np.ndarray:
    """The table's local linear map into the image, from one settled card outline.

    The outline's mean edge vectors per millimetre, B = [x-edge | y-edge] / (63, 88),
    are M @ R: the card turned by R on the table, then the table mapped by M. With
    the camera square to the table (no roll), M is upper triangular, so this is the
    RQ factorisation of B and M is unique.
    """
    ex = ((q[1] - q[0]) + (q[2] - q[3])) / 2 / CARD_MM[0]
    ey = ((q[3] - q[0]) + (q[2] - q[1])) / 2 / CARD_MM[1]
    B = np.stack([ex, ey], 1)
    d = float(np.linalg.norm(B[1]))
    sn, cs = B[1] / d
    a = float(B[0] @ np.array([cs, -sn]))
    b = float(B[0] @ np.array([sn, cs]))
    return np.array([[a, b], [0.0, d]], np.float32)


def posed(rel_t: np.ndarray, M: np.ndarray, centre: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Quads for poses p (..., 4) = dx, dy (image px), turn on the table (rad), scale."""
    cs, sn = np.cos(p[..., 2]), np.sin(p[..., 2])
    R = np.stack([np.stack([cs, -sn], -1), np.stack([sn, cs], -1)], -2)  # (..., 2, 2)
    q_t = np.einsum("...ij,kj->...ki", R, rel_t) * p[..., 3, None, None]
    return q_t @ M.T + centre + p[..., None, :2]


def sample(m: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Bilinear lookup of m at (..., 2) points; outside the map reads 0."""
    h, w = m.shape
    x, y = pts[..., 0], pts[..., 1]
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    fx, fy = x - x0, y - y0
    out = np.zeros(x.shape, np.float32)
    for dx, dy, wt in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        xi, yi = x0 + dx, y0 + dy
        ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        out += np.where(ok, m[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)], 0) * wt
    return out


# A card's image scale on the table depends only on its depth, i.e. its image height: px/mm
# across the table, fitted on every settled card, is ~DEPTH_K * y + DEPTH_B (residual ~2%).
DEPTH_K, DEPTH_B = 0.00071, 0.134


def depth_scale(y_from: float, y_to) -> np.ndarray:
    """How much larger a card looks with its centre at image height y_to than at y_from."""
    return (DEPTH_K * np.asarray(y_to, np.float32) + DEPTH_B) / (DEPTH_K * y_from + DEPTH_B)
