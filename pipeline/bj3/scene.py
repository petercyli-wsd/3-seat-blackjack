"""
Scene swap inputs: what the app needs to keep the dealer and replace the set around her.

    uv run python -m bj3.scene [game_assets dir] [--debug out_dir]

Reads every clip in the manifest (a sample of frames from each) and writes to game_assets/scene/:

  reference.png  the set without her: the wall behind her inpainted from around her, the felt as
                 it looks when nothing is on it, and every static prop as it always looks
  masks.png      R: 0-0.6 where she ever is above the table (her envelope, feathered), with the
                    shoe and discard holder where they stand up past the cloth; 0.6-1 her core,
                    where she is in nearly every frame
                 G: the cloth (the table surface, its drape, and the shoe and discard holder on it)
                 B: the cloth within her reach, where her arms, the cards and the props ever move
  clutter.png    R: clutter on the cloth to erase (clamps, pens, bet markers...): anything lying
                    still (all take, or between her moving it) that isn't felt, a card, the shoe
                    or the discard holder. 1 on the open felt, a half by the shoe and the
                    discard holder (there, only where it looks as it always does)
                 G: the shoe and the discard holder, and a few pixels round them
                 B: the shoe and the discard holder, crisp (anti-aliased, a little inside their
                    soft edges in the footage): kept as filmed, whatever is around them
  scene.json     the cloth's corners in the frame and the table plane they span, in cm

The app keys her out against reference.png (wall above, felt below) inside those masks, so her
hands, the cards, the shoe and the discard holder stay, and lays a new table and room in.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

STEP = 9  # every 9th frame of every clip (~1100 frames over the take)
MEDIAN_EVERY = 6  # of those, every 6th goes into the per-pixel medians
# clutter she moves (the bet marker by seat 1 is knocked askew partway through) is still only
# between moves: it is also looked for in each of this many stretches of the take on its own
STILL_SPANS = 4
# and never where a card lies, nor this close (px): a card lying still a while is no clutter;
# nor in specks smaller than this (px)
CARD_CLEAR = 6
SPAN_MIN = 30
# clutter this far (px) from the shoe and the discard holder lies on the open felt, where the app
# can erase all of it but her and the cards; nearer, cards come out of the shoe and go into the
# holder before and after their faces are drawn
PROP_CLEAR = 10
# and grown this much (px) there: a marker's bright edge would otherwise spread past the mask as the
# app enlarges the footage (it is felt round it, which is replaced anyway)
OPEN_GROW = 3
CARD_CM = (6.35, 8.89)


def frames(path: Path, step: int):
    cap = cv2.VideoCapture(str(path))
    i = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, f = cap.retrieve()
            if ok:
                yield f
        i += 1
    cap.release()


def feltness(f: np.ndarray) -> np.ndarray:
    """Same key as the app's shaders: felt is strongly blue (B - max(R, G))."""
    x = f.astype(np.float32) / 255
    d = x[..., 0] - np.maximum(x[..., 1], x[..., 2])
    return np.clip((d - 0.03) / 0.09, 0, 1)


def wallish(f: np.ndarray) -> np.ndarray:
    """Bright and neutral: the grey wall. Her top and hair are dark, her skin warm."""
    x = f.astype(np.float32) / 255
    lum = x @ np.array([0.114, 0.587, 0.299], np.float32)
    warm = x[..., 2] - x[..., 0]
    return (lum > 0.3) & (np.abs(warm) < 0.06)


def biggest(mask: np.ndarray) -> np.ndarray:
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n <= 1:
        return mask.astype(bool)
    return lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))


def fill_holes(mask: np.ndarray) -> np.ndarray:
    m = mask.astype(np.uint8)
    flood = m.copy()
    h, w = m.shape
    cv2.floodFill(flood, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    return m.astype(bool) | (flood == 0)


# The cloth's left side is behind the softbox and its front hangs over the table's edge as a
# drape, so only the back edge is found from the footage. The sides run through the clamps on
# them (right: (1082, 383)-(1157, 517); left: one clamp at (35, 510), mirrored), and the front
# is the fold the clamps sit on. Measured on a frame of the take; re-measure for a new set.
RIGHT_EDGE = ((1082.0, 383.0), (1157.0, 517.0))
LEFT_EDGE = ((35.0, 510.0), (35.0 + 75.0, 510.0 - 134.0))
FRONT_EDGE = ((0.0, 591.0), (1212.0, 598.0))


def line(p, q):
    """Homogeneous line through two points."""
    return np.cross([*p, 1.0], [*q, 1.0])


def meet(l1, l2):
    x = np.cross(l1, l2)
    return x[:2] / x[2]


def cloth_corners(top: np.ndarray) -> np.ndarray:
    """Back-left, back-right, front-right, front-left of the cloth's top."""
    xs = np.arange(330, 1000, 5)
    ys = np.array([np.argmax(top[:, x]) for x in xs], np.float64)
    keep = np.abs(ys - np.median(ys)) < 6  # her arms and the props break the edge in places
    a, b = np.polyfit(xs[keep], ys[keep], 1)
    back = line((0.0, b), (1000.0, a * 1000 + b))
    left, right, front = line(*LEFT_EDGE), line(*RIGHT_EDGE), line(*FRONT_EDGE)
    return np.array([meet(back, left), meet(back, right), meet(front, right), meet(front, left)])


def plane_depth(corners: np.ndarray, cards: list[np.ndarray], width_cm: float) -> float:
    """Depth (cm) of the cloth that makes the cards measured in the take come out card-shaped."""
    def aspect(depth: float) -> float:
        dst = np.array([[0, 0], [width_cm, 0], [width_cm, depth], [0, depth]], np.float64)
        H = cv2.getPerspectiveTransform(corners.astype(np.float32), dst.astype(np.float32))
        out = []
        for q in cards:
            p = cv2.perspectiveTransform(q.reshape(-1, 1, 2).astype(np.float32), H).reshape(-1, 2)
            w = (np.linalg.norm(p[1] - p[0]) + np.linalg.norm(p[2] - p[3])) / 2
            h = (np.linalg.norm(p[3] - p[0]) + np.linalg.norm(p[2] - p[1])) / 2
            out.append(min(w, h) / max(w, h))
        return float(np.median(out))
    want = CARD_CM[0] / CARD_CM[1]
    depths = np.linspace(width_cm * 0.2, width_cm * 1.2, 400)
    return float(depths[np.argmin([abs(aspect(d) - want) for d in depths])])


def card_width_px(m: dict) -> float:
    q = np.array(m["dealer"]["up"])
    return float(np.linalg.norm(q[1] - q[0]))


# the props' outlines are drawn this many times finer, then averaged down: an anti-aliased edge
PROP_SS = 8
# and pulled in this far (source px), past the half-felt pixels of the footage's own soft edge
PROP_CHOKE = 0.6


def prop_mattes(median: np.ndarray, ref: np.ndarray, near: np.ndarray) -> np.ndarray:
    """The shoe and the discard holder, crisp: 0-1, anti-aliased over one pixel.

    Each stands still all take, so its outline is found once, in the median frame: where that frame
    is more like the prop (its darkest tenth) than like the set without it (`ref`), at sub-pixel
    accuracy (the share is interpolated 8x before it is cut at a half), and its convex hull taken
    (a box seen from anywhere is convex; that also takes in its glossy sides, which mirror the felt).
    """
    H, W = median.shape[:2]
    out = np.zeros((H, W), np.float32)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(near.astype(np.uint8), 8)
    for i in range(1, n):
        x, y, w, h = stats[i, :4]
        x0, y0, x1, y1 = max(x - 4, 0), max(y - 4, 0), min(x + w + 4, W), min(y + h + 4, H)
        c = median[y0:y1, x0:x1].astype(np.float32)
        r = ref[y0:y1, x0:x1].astype(np.float32)
        inside = lab[y0:y1, x0:x1] == i
        dark = c[inside].sum(-1)
        prop = c[inside][dark <= np.percentile(dark, 10)].mean(0)
        # each pixel's share of the prop, on the line from the set's colour there to the prop's
        d = prop - r
        share = ((c - r) * d).sum(-1) / np.maximum((d * d).sum(-1), 1.0) * inside
        big = cv2.resize(share, ((x1 - x0) * PROP_SS, (y1 - y0) * PROP_SS), interpolation=cv2.INTER_LINEAR)
        solid = (big > 0.5).astype(np.uint8)
        cs, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cs:
            continue
        hull = cv2.convexHull(max(cs, key=cv2.contourArea))
        fine = np.zeros_like(solid)
        cv2.fillConvexPoly(fine, hull, 1)
        k = 2 * round(PROP_CHOKE * PROP_SS) + 1
        fine = cv2.erode(fine, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        # the resize put pixel centres at (i + 0.5) * SS - 0.5: area-averaging back lands on them
        small = cv2.resize(fine.astype(np.float32), (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA)
        out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], small)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("assets", nargs="?", default=str(Path(__file__).resolve().parents[2] / "game_assets"))
    ap.add_argument("--debug", default=None)
    args = ap.parse_args()
    root = Path(args.assets)
    m = json.loads((root / "manifest.json").read_text())
    W, H = m["width"], m["height"]

    felt_count = np.zeros((H, W), np.float32)
    felt_sum = np.zeros((H, W, 3), np.float32)
    person = np.zeros((H, W), np.uint16)
    stack: list[np.ndarray] = []
    when: list[int] = []
    n = 0
    files = sorted({c["file"] for c in m["clips"].values()})
    start = {c["file"]: c["sourceStart"] for c in m["clips"].values()}
    for name in files:
        for i, f in enumerate(frames(root / name, STEP)):
            k = feltness(f)
            fe = k > 0.5
            # bare felt only, well clear of anything on it (a card's edge blends into the felt)
            bare_felt = cv2.erode((k > 0.9).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
            felt_count += bare_felt
            felt_sum += f * bare_felt[..., None]
            person += ~wallish(f) & ~fe
            if n % MEDIAN_EVERY == 0:
                stack.append(f)
                when.append(start[name] + i * STEP)
            n += 1
    print(f"{n} frames from {len(files)} clips, {len(stack)} in the median")
    stack = np.stack(stack)
    median = np.median(stack, axis=0).astype(np.uint8)

    def unlike(frames: np.ndarray, med: np.ndarray) -> np.ndarray:
        """How often each pixel looks unlike its median: props lying still almost never do."""
        out = np.zeros((H, W), np.float32)
        for f in frames:
            out += np.abs(f.astype(np.int16) - med).max(axis=2) > 24
        return out / len(frames)

    changed = unlike(stack, median)
    # and each stretch of the take on its own, in take order
    spans = []
    for part in np.array_split(np.argsort(when), STILL_SPANS):
        med = np.median(stack[part], axis=0).astype(np.uint8)
        spans.append((med, unlike(stack[part], med)))
    del stack
    felt_frac = felt_count / n

    # the cloth's top: felt in at least some frames, one region, holes (props, cards) filled
    top = biggest(felt_frac > 0.01)
    top = fill_holes(cv2.morphologyEx(top.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)))
    corners = cloth_corners(top)
    back_y = float(min(corners[0][1], corners[1][1]))

    # her envelope: above the cloth, not-wall often enough, the component in the middle of the frame
    above = ~top
    above[int(max(corners[0][1], corners[1][1])) + 8:, :] = False
    env = (person > n * 0.03) & above
    env = cv2.morphologyEx(env.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)).astype(bool)
    n_lab, lab, stats, cents = cv2.connectedComponentsWithStats(env.astype(np.uint8), 8)
    dealer_x = (m["dealer"]["up"][0][0] + m["dealer"]["hole"][1][0]) / 2
    best, best_score = 0, -1.0
    for i in range(1, n_lab):
        x0, y0, w, h, a = stats[i]
        # her silhouette touches the cloth and spans the dealer's position
        if x0 <= dealer_x <= x0 + w and y0 + h >= back_y - 12 and a > best_score:
            best, best_score = i, a
    env = fill_holes(lab == best)
    # her core: where she is in nearly every frame (her shaded neck reads wall-grey to a colour
    # key, so the core is filled in and always kept)
    core = fill_holes((person > n * 0.85) & env)
    core = cv2.erode(core.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    core_soft = cv2.GaussianBlur(core.astype(np.float32), (0, 0), 3)
    body = env.copy()
    env = cv2.dilate(env.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))).astype(bool) & above
    # and a band above the cloth's back edge from the discard holder to the shoe: her hands rise
    # past the edge there, carrying cards, too rarely to count above
    x0 = int(m["dealer"]["discardTray"][0]) - 60
    x1 = int(m["dealer"]["shoe"][0]) + 80
    band = np.zeros_like(env)
    band[int(back_y) - 50:, x0:x1] = True
    near_her = env.copy()
    env |= band & above
    # feathered at its sides, not where it meets the cloth: there it runs on past the cloth's edge
    # before the blur (a fade there would cut her arms where they cross onto the table)
    (bx0, by0), (bx1, by1) = corners[0], corners[1]
    yy, xx = np.mgrid[0:H, 0:W]
    below = (bx1 - bx0) * (yy - by0) - (by1 - by0) * (xx - bx0) > 0
    down = cv2.dilate(env.astype(np.uint8), np.ones((41, 1), np.uint8)).astype(bool) & below
    # and it overlaps the cloth (and her reach on it, below) by a few pixels: the app blends the two
    # across the edge, and two masks both ending there would filter to half on its row
    well_below = (bx1 - bx0) * (yy - by0 - 4) - (by1 - by0) * (xx - bx0) > 0
    env_soft = cv2.GaussianBlur((env | down).astype(np.float32), (0, 0), 4) * ~well_below

    # the cloth as the app keys it: a few pixels past the felt, so its edge is decided here too
    cloth = cv2.dilate(top.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)

    # felt as it looks bare (its mean over the frames it was bare there), filled in under the
    # props and anything else always on it; clutter, below, as it always looks
    seen = felt_count >= 3
    bare = (felt_sum / np.maximum(felt_count, 1)[..., None]).astype(np.uint8)
    bare = cv2.inpaint(bare, (~seen).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    bare = cv2.medianBlur(bare, 5)
    ref = bare

    # clutter: on the cloth and lying still. That is anything not felt in the median, and the clear
    # bet markers, which are felt through their middles but leave rims unlike the felt around
    # them. The cards and her resting hands change far too often to count. Clutter she moves lies
    # still between moves: anything lying still through a stretch of the take counts too, away from
    # where the cards lie. The shoe and the discard holder are kept as filmed, including the parts
    # that stand up past the cloth's edge.
    def lying_still(med: np.ndarray, unlike_med: np.ndarray) -> np.ndarray:
        local = np.abs(med.astype(np.int16) - cv2.medianBlur(med, 21)).max(axis=2) > 18
        return cloth & (unlike_med < 0.12) & ((feltness(med) < 0.5) | local)

    still = lying_still(median, changed)
    cards_lie = np.zeros((H, W), np.uint8)
    for clip in m["clips"].values():
        for v in clip["cards"]:
            for q in [v["quad"]] + [r["quad"] for r in v.get("rests", [])]:
                cv2.fillConvexPoly(cards_lie, np.array(q, np.float32).round().astype(np.int32), 1)
    for p in (p for s in m["seats"] for p in m["plates"][s].values()):
        for q in p["cards"]:
            cv2.fillConvexPoly(cards_lie, np.array(q, np.float32).round().astype(np.int32), 1)
    k = 2 * CARD_CLEAR + 1
    cards_lie = cv2.dilate(cards_lie, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))).astype(bool)
    for med, unlike_med in spans:
        found = (lying_still(med, unlike_med) & ~cards_lie).astype(np.uint8)
        n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(found, 8)
        still |= np.isin(lab, 1 + np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] >= SPAN_MIN))
    still = cv2.dilate(still.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & cloth
    solid = (feltness(median) < 0.5) & ~wallish(median)
    n_lab, lab, stats, _ = cv2.connectedComponentsWithStats(solid.astype(np.uint8), 8)
    props = np.zeros_like(still)
    for name in ("shoe", "discardTray"):
        x, y = m["dealer"][name]
        r = 12
        one = np.zeros_like(still)
        for i in set(np.unique(lab[y - r:y + r, x - r:x + r])) - {0}:
            one |= lab == i
        # its whole outline: the shoe's glossy side reflects the felt and keys as felt in places
        hull = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(hull, cv2.convexHull(np.c_[np.nonzero(one)[::-1]].astype(np.int32)), 1)
        props |= hull.astype(bool)
    props = cv2.dilate(props.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    # they stand on the cloth (touching its edge, they were never holes in it): below its back
    # edge they are keyed against the felt, like a card, not against the wall
    cloth |= props & below
    # and the cloth stops at its back edge: past it is wall, keyed as wall
    cloth &= below
    # never where she meets the table: her resting arms are in the median there, and would be
    # erased as clutter (a line through her where the table's edge shows)
    leaning = cv2.dilate(body.astype(np.uint8), np.ones((41, 25), np.uint8)).astype(bool)
    clutter = still & ~props & ~leaning
    clutter = cv2.dilate(clutter.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~props & ~leaning
    # each piece on the open felt, clear of the props
    k = 2 * PROP_CLEAR + 1
    by_props = cv2.dilate(props.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))).astype(bool)
    n_lab, lab = cv2.connectedComponents(clutter.astype(np.uint8), connectivity=8)
    open_felt = clutter & ~np.isin(lab, np.unique(lab[by_props & clutter]))
    k = 2 * OPEN_GROW + 1
    open_felt = cv2.dilate(open_felt.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))).astype(bool) & cloth & ~props & ~leaning

    # her reach: the stretch of cloth where anything ever moves that her arms or the cards are
    # part of. Past it (the softbox's flickering edge, the drape) the cloth is always replaced.
    moving = cloth & (changed > 0.12)
    moving = cv2.morphologyEx(moving.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8))
    n_lab, lab = cv2.connectedComponents(moving, connectivity=8)
    seeds = cv2.dilate(env.astype(np.uint8), np.ones((25, 25), np.uint8)).astype(bool) | props
    reach = np.zeros_like(cloth)
    for i in set(np.unique(lab[seeds])) - {0}:
        reach |= lab == i
    card_pts = [pt for q in [m["dealer"]["up"], m["dealer"]["hole"]] + [q for s in m["seats"] for p in m["plates"][s].values() for q in p["cards"]] for pt in q]
    for x, y in np.array(card_pts).astype(int):
        if lab[y, x]:
            reach |= lab == lab[y, x]
    # and everything between: she carries cards from the shoe and to the discard holder quickly
    ys, xs = np.nonzero(env & (np.arange(H)[:, None] > back_y - 30))
    py, px = np.nonzero(props)
    hull = cv2.convexHull(np.vstack([np.array(card_pts), np.c_[xs, ys], np.c_[px, py]]).astype(np.int32))
    span = np.zeros((H, W), np.uint8)
    cv2.fillConvexPoly(span, hull, 1)
    reach |= span.astype(bool)
    reach = cv2.dilate(reach.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))).astype(bool) & cloth
    # above the cloth the app keeps whatever isn't wall inside her envelope; the props stand there too
    env_soft = np.maximum(env_soft, cv2.GaussianBlur((props & ~top).astype(np.float32), (0, 0), 1.5))

    ref = np.where(clutter[..., None], median, ref)

    # the wall behind her and the props, inpainted from the wall around them (not from the felt)
    hole = (cv2.dilate(env.astype(np.uint8), np.ones((15, 15), np.uint8)) | cv2.dilate(top.astype(np.uint8), np.ones((9, 9), np.uint8))
            | cv2.dilate(props.astype(np.uint8), np.ones((15, 15), np.uint8)))
    wall = cv2.inpaint(median, hole * 255, 12, cv2.INPAINT_TELEA)
    # only where she (or a prop) nearly always is: elsewhere the median is the wall as it is,
    # down to the table edge's shadow on it
    seen_wall = ~cv2.dilate((near_her | props).astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    hole = hole.astype(bool) & ~seen_wall
    wall = np.where(hole[..., None], cv2.GaussianBlur(wall, (0, 0), 6), median)
    ref = np.where(cloth[..., None], ref, wall)

    out = root / "scene"
    out.mkdir(exist_ok=True)
    cv2.imwrite(str(out / "reference.png"), ref)
    # R packs two masks: 0-0.6 her envelope, 0.6-1 her core. Each other mask has a channel of its
    # own: packed, a boundary between two of them filters through the value of a third.
    r = env_soft * 0.6 + core_soft * 0.4
    reach_over = reach | (cv2.dilate(reach.astype(np.uint8), np.ones((9, 1), np.uint8)).astype(bool) & ~below)
    masks = np.round(np.dstack([reach_over, cloth, r]).astype(np.float32) * 255).astype(np.uint8)  # BGR
    cv2.imwrite(str(out / "masks.png"), masks)
    crisp = np.round(prop_mattes(median, ref, props) * 255).astype(np.uint8)
    erase = np.where(open_felt, 255, np.where(clutter, 128, 0)).astype(np.uint8)
    cv2.imwrite(str(out / "clutter.png"), np.dstack([crisp, props.astype(np.uint8) * 255, erase]))

    cards = [np.array(m["dealer"]["up"]), np.array(m["dealer"]["hole"])]
    for seat in m["seats"]:
        for p in m["plates"][seat].values():
            cards += [np.array(q) for q in p["cards"]]
    # the true width: the dealer's up card is 6.35 cm across at the back edge
    back_px = float(np.linalg.norm(corners[1] - corners[0]))
    width_cm = round(back_px / card_width_px(m) * CARD_CM[0], 1)
    depth_cm = plane_depth(corners, cards, width_cm)
    scene = {
        "corners": np.round(corners, 1).tolist(),
        "planeCm": [width_cm, round(depth_cm, 1)],
        "reference": "scene/reference.png",
        "masks": "scene/masks.png",
        "clutter": "scene/clutter.png",
        "frames": n,
    }
    (out / "scene.json").write_text(json.dumps(scene, indent=2))
    print(json.dumps(scene))

    if args.debug:
        d = Path(args.debug)
        d.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(d / "median.png"), median)
        cv2.imwrite(str(d / "felt_frac.png"), (felt_frac * 255).astype(np.uint8))
        cv2.imwrite(str(d / "changed.png"), (changed * 255).astype(np.uint8))
        cv2.imwrite(str(d / "person.png"), np.clip(person / n * 255 * 4, 0, 255).astype(np.uint8))
        vis = ref.copy()
        vis[clutter] = (0, 0, 255)
        vis[props] = (0, 255, 0)
        vis[reach & ~clutter & ~props] = (vis[reach & ~clutter & ~props] * 0.6 + np.array([0, 160, 255]) * 0.4).astype(np.uint8)
        vis = cv2.addWeighted(vis, 0.7, np.dstack([r * 255] * 3).astype(np.uint8), 0.3, 0)
        cv2.polylines(vis, [corners.astype(np.int32)], True, (0, 255, 255), 2)
        cv2.imwrite(str(d / "masks_vis.png"), vis)


if __name__ == "__main__":
    main()
