"""Sub-pixel card outlines.

A card on this table is a parallelogram in the image (portrait card, ~30°
camera elevation). An isolated card's four corners are measured directly:
the saturation channel is upsampled (felt S≈235, card S≈11, so S is a clean
soft edge), the outline approximated to four vertices, and each side refitted
as a least-squares line whose intersections give the corners.

A card that lands overlapping another (every hit card) has one or two edges
lying white-on-white, so it is fitted instead as its seat's isolated card
moved, rotated and scaled: the pose that keeps the newly exposed pixels inside
the card and the card on card pixels.
"""

import cv2
import numpy as np

UP = 4


def soft_card(bgr: np.ndarray) -> np.ndarray:
    """1.0 on card stock, 0.0 on felt, linear in between (from saturation), 4x upsampled."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    warm = bgr[..., 2].astype(np.float32) - bgr[..., 0].astype(np.float32)
    s = cv2.resize(hsv[..., 1], None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    v = cv2.resize(hsv[..., 2], None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    warm = cv2.resize(warm, None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    # skin is bright and unsaturated too; it is told apart by being warm (R > B)
    card = np.clip((200 - s) / 150, 0, 1) * np.clip((v - 120) / 60, 0, 1) * np.clip((24 - warm) / 10, 0, 1)
    return card


def soft_back(bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h = hsv[..., 0].astype(np.int16)
    m = (((h >= 150) | (h <= 8)) & (hsv[..., 1] > 50) & (hsv[..., 2] > 60)).astype(np.float32)
    # the back has a thin white border; close over it so the outline is the card's edge
    m = cv2.resize(m, None, fx=UP, fy=UP, interpolation=cv2.INTER_LINEAR)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return cv2.dilate(m, np.ones((5, 5), np.uint8))


def corners_from_mask(mask: np.ndarray) -> np.ndarray | None:
    """Four corners (clockwise, image coords at UP scale) of the largest blob, or None."""
    m = (mask > 0.5).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return None
    c = max(cs, key=cv2.contourArea)
    hull = cv2.convexHull(c)
    peri = cv2.arcLength(hull, True)
    approx = None
    for eps in np.linspace(0.01, 0.12, 40):
        a = cv2.approxPolyDP(hull, eps * peri, True)
        if len(a) == 4:
            approx = a[:, 0, :].astype(np.float32)
            break
    if approx is None:
        return None
    pts = c[:, 0, :].astype(np.float32)
    # assign each contour point to the nearest side, fit a line per side, intersect
    lines = []
    for i in range(4):
        p, q = approx[i], approx[(i + 1) % 4]
        d = q - p
        L = np.linalg.norm(d)
        if L < 1:
            return None
        t = ((pts - p) @ d) / (L * L)
        dist = np.abs((pts - p) @ np.array([-d[1], d[0]]) / L)
        sel = pts[(t > 0.15) & (t < 0.85) & (dist < 6)]
        if len(sel) < 5:
            lines.append((p, d / L))
            continue
        vx, vy, x0, y0 = cv2.fitLine(sel, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    out = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 1e-6:
            out.append(approx[i])
            continue
        t = np.linalg.solve(A, p2 - p1)
        out.append(p1 + t[0] * d1)
    q = np.array(out, np.float32)
    # clockwise on screen (y down) means positive shoelace area
    area = 0.5 * np.sum(q[:, 0] * np.roll(q[:, 1], -1) - np.roll(q[:, 0], -1) * q[:, 1])
    return q if area > 0 else q[::-1].copy()


# Depth foreshortening of the table plane, measured on the square-on dealer
# cards: a 63 mm width spans ~22 px, an 88 mm length ~14 px.
DEPTH_STRETCH = 2.2


def orient(q: np.ndarray) -> np.ndarray:
    """Rotate the clockwise corner list so it starts at the face's top-left.

    The face's top is the card's far short edge. Which image edges are the
    card's short ones depends on how it lies, so the edges are first stretched
    back to table proportions (y scaled by DEPTH_STRETCH) and compared there.
    """
    un = q * np.array([1.0, DEPTH_STRETCH], np.float32)
    edges = [(i, float(np.linalg.norm(un[(i + 1) % 4] - un[i])), float(q[i][1] + q[(i + 1) % 4][1]) / 2)
             for i in range(4)]
    pair_a = edges[0][1] + edges[2][1]
    pair_b = edges[1][1] + edges[3][1]
    short = (edges[0], edges[2]) if pair_a < pair_b else (edges[1], edges[3])
    top = min(short, key=lambda e: e[2])[0]
    return np.roll(q, -top, axis=0)


def fit_template(template: np.ndarray, added: np.ndarray, support: np.ndarray,
                 reach: float = 12, turn: float = 12, scales=(0.94, 0.97, 1.0, 1.03),
                 start: np.ndarray | None = None) -> np.ndarray:
    """Pose search for a card that is partly hidden white-on-white (masks at UP scale)."""
    t_c = template.mean(0)
    rel = template - t_c
    ys, xs = np.nonzero(added > 0.5)
    if len(xs) == 0:
        return template
    if start is None:
        start = np.array([xs.mean(), ys.mean()], np.float32)
    added_b = (added > 0.5).astype(np.uint8)
    support_b = (support > 0.5).astype(np.uint8)
    n_added = float(added_b.sum())
    canvas = np.zeros_like(added_b)

    def score(c, ang, s):
        r = np.deg2rad(ang)
        R = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]], np.float32)
        poly = (rel @ R.T) * s + c
        canvas[:] = 0
        cv2.fillConvexPoly(canvas, poly.round().astype(np.int32), 1)
        area = float(canvas.sum())
        if area == 0:
            return -1e9, poly
        on_card = float((canvas & support_b).sum()) / area
        covered = float((canvas & added_b).sum()) / n_added
        return on_card + 1.5 * covered, poly

    best = (-1e9, None, None)
    step = 2 * UP
    for dx in np.arange(-reach * UP, reach * UP + 1, step):
        for dy in np.arange(-reach * UP, reach * UP + 1, step):
            for ang in np.arange(-turn, turn + 0.1, max(0.5, turn / 4)):
                sc, _ = score(start + (dx, dy), ang, 1.0)
                if sc > best[0]:
                    best = (sc, start + (dx, dy), (ang, 1.0))
    _, c0, (a0, s0) = best
    for dx in np.arange(-step, step + 1, 2):
        for dy in np.arange(-step, step + 1, 2):
            for ang in np.arange(a0 - min(3, turn), a0 + min(3, turn) + 0.1, 0.75):
                for s in scales:
                    sc, poly = score(c0 + (dx, dy), ang, s)
                    if sc > best[0]:
                        best = (sc, c0 + (dx, dy), (ang, s))
    _, c, (ang, s) = best
    return score(c, ang, s)[1]
