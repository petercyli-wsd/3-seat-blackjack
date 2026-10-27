"""Pass 9, with the manifest: each hit card's exact outline as it comes down onto the hand.

    uv run --extra sam python -m bj3.landing <full_footage.mp4> [game_assets]
    uv run python -m bj3.landing rederive <full_footage.mp4> [game_assets]   (from the saved tracking)

A hit is filmed in the full-table round, whose first two cards in a seat sit a few pixels from
where a round's own deal put them. At the seat being dealt to, the game lays the round's first two
cards in over the footage's wherever the frame shows the table as the take's own still does, and
keeps the rest as filmed: her hand, the cards from the third on (they lie where the round has them
too), and the card she brings in. Where that card slides over the footage's second card, white on
white, only its outline can say which is which, and the slide-in trace (`path`, fitted for its face)
is loose by up to 15 px.

So the card is tracked with SAM 2 (a video segmenter) back through its landing, from its resting
outline after her finger has left it, with the cards already lying there marked as not it. While
it is still tilted coming down, it casts a shadow line onto the card below, and the mask has it
right there; tilted, it also shows shorter than it lies. Once it lies flat on that card (white on
white: no edge to see) the mask cuts off the corner lying there, the face's bottom-left, often
the whole triangle to the corners either side. That corner then comes from the card's own shape:
the affine map from its resting outline's other three corners onto the tracked ones. Which of the
two holds is told by the shadow line: how much darker the card below is just outside the mask's
edge than a few pixels further out, between the two corners; in between, they are blended. Per frame:
`faces`, those corners (TL, TR, BR, BL), for laying its face on as it comes down tilted under her
finger, and `outlines`, the hull of the mask and the face together (none before it is in view).
`rest`: the clip frame from which the card stops moving; there it lies on its resting outline, where
the take's own still of the seat with this card in it takes over, and the frames before are shifted
by what the tracking was off from that outline there, so the card runs on into it unbroken. Stored
on the card in its hit clip as `land`.

SAM 2 runs on the CPU here (about a minute and a half a hit); its checkpoint is fetched into work/ once.
"""

import json
import sys
import tempfile
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from bj3.video import Frames

BACK, AFTER = 8, 14  # frames tracked before and after it lands
HALF, ZOOM = 56, 4  # the crop around the card, and how much it is enlarged for SAM 2
STILL = 0.6  # px a frame its centre moves at most, three frames running, once it has stopped
SHADOW = (3, 15)  # grey levels of shadow line on the card below: lying flat at most, tilted at least
CHECKPOINT = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"
CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"


def predictor(work: Path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    ckpt = work / "sam2.1_hiera_small.pt"
    if not ckpt.exists():
        print(f"  fetching {CHECKPOINT}")
        urllib.request.urlretrieve(CHECKPOINT, ckpt)
    torch.set_grad_enabled(False)
    return build_sam2_video_predictor(CONFIG, str(ckpt), device="cpu")


def corners(poly: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """A convex outline's four corners, ordered like `ref` (a quad of the same card: TL, TR, BR, BL)."""
    hull = cv2.convexHull(poly.astype(np.float32))
    quad = None
    for eps in np.linspace(0.5, 12, 48):
        a = cv2.approxPolyDP(hull, eps, True)[:, 0]
        if len(a) == 4:
            quad = a
            break
    if quad is None:
        quad = cv2.boxPoints(cv2.minAreaRect(hull))
    orders = [np.roll(q, -r, axis=0) for q in (quad, quad[::-1]) for r in range(4)]
    return min(orders, key=lambda c: np.linalg.norm(c - ref, axis=1).sum())


def shadow(grey: np.ndarray, hull: np.ndarray, shaped: np.ndarray, below: np.ndarray) -> float | None:
    """How much darker the card below is just outside the mask (up to 2 px) than further out (3-7 px),
    inside the card's resting shape `shaped`: the shadow line a tilted card casts. None if the mask's
    edge doesn't run over that card there."""
    x0, y0 = np.floor(np.vstack([hull, shaped]).min(0)).astype(int) - 8
    x1, y1 = np.ceil(np.vstack([hull, shaped]).max(0)).astype(int) + 8
    x0, y0 = max(x0, 0), max(y0, 0)
    img = grey[y0:y1, x0:x1].astype(np.float32)
    fill = lambda poly: cv2.fillPoly(np.zeros(img.shape, np.uint8), [np.round(np.asarray(poly) - [x0, y0]).astype(np.int32)], 1)
    mask, within = fill(hull), fill(shaped) & fill(below)
    grow = lambda r: cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    near, far = (grow(2) - mask) & within, (grow(7) - grow(3)) & within
    if near.sum() < 5 or far.sum() < 5:
        return None
    return float(img[far > 0].mean() - img[near > 0].mean())


def trace(card: dict, f: int) -> np.ndarray:
    p = card.get("path")
    if p and 0 <= f - p["from"] < len(p["quads"]):
        return np.array(p["quads"][f - p["from"]])
    return np.array(card["quad"])


def track(sam, fr: Frames, clip: dict, card: dict, lying: list[dict], height: int) -> tuple[int, list]:
    rest = np.array(card["quad"], np.float64)
    first, last = max(0, card["in"] - BACK), min(clip["frames"] - 1, card["in"] + AFTER)
    cx, cy = np.vstack([rest] + [np.array(c["quad"]) for c in lying[-2:]]).mean(0)
    x0, y0 = int(cx - HALF), int(cy - HALF)
    to_crop = lambda p: (np.asarray(p, np.float64) - [x0, y0] + 0.5) * ZOOM
    to_src = lambda p: np.asarray(p, np.float64) / ZOOM - 0.5 + [x0, y0]
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(range(first, last + 1)):
            crop = fr.get(clip["sourceStart"] + f)[:height][y0:y0 + 2 * HALF, x0:x0 + 2 * HALF]
            cv2.imwrite(str(Path(tmp) / f"{i:05d}.jpg"), cv2.resize(crop, None, fx=ZOOM, fy=ZOOM, interpolation=cv2.INTER_CUBIC),
                        [cv2.IMWRITE_JPEG_QUALITY, 97])
        state = sam.init_state(video_path=tmp)
        li = last - first
        box = np.concatenate([to_crop(rest).min(0), to_crop(rest).max(0)]).astype(np.float32)
        points = [to_crop(rest.mean(0))] + [to_crop(np.array(c["quad"]).mean(0)) for c in lying[-2:]]
        sam.add_new_points_or_box(state, frame_idx=li, obj_id=1, box=box, points=np.array(points, np.float32),
                                  labels=np.array([1] + [0] * len(lying[-2:]), np.int32))
        masks = {fi: (logits[0, 0] > 0).cpu().numpy().astype(np.uint8)
                 for fi, _, logits in sam.propagate_in_video(state, start_frame_idx=li, reverse=True)}
        sam.reset_state(state)
    hulls = []
    for i in range(li + 1):
        mk = masks.get(i)
        if mk is None or not mk.any():
            hulls.append(None)
            continue
        cs, _ = cv2.findContours(mk, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        hulls.append(to_src(cv2.approxPolyDP(cv2.convexHull(max(cs, key=cv2.contourArea)), 1.0 * ZOOM, True)[:, 0]))
    return first, hulls


def settle_on(card: dict, under: dict, first: int, hulls: list, grey) -> dict:
    """The tracked hulls as face corners and cut-out outlines, run on into the resting outline (see
    above). grey(f): the clip's frame f in grey."""
    rest = np.array(card["quad"], np.float64)
    below = np.array(under["quad"], np.float64)
    faces, hidden = [], []
    for i, hull in enumerate(hulls):
        if hull is None:
            faces.append(None)
            hidden.append(False)
            continue
        hull = np.asarray(hull)
        q = corners(hull, trace(card, first + i))
        a = cv2.getAffineTransform(rest[:3].astype(np.float32), q[:3].astype(np.float32))
        shaped = a @ [*rest[3], 1.0]
        # its bottom-left corner over the card below, where the mask can't see it once it lies flat
        over = cv2.pointPolygonTest(below.astype(np.float32).reshape(-1, 1, 2), (float(shaped[0]), float(shaped[1])), True) > -2
        if over:
            line = shadow(grey(first + i), hull, np.vstack([q[:3], shaped]), below)
            tilted = 1.0 if line is None else float(np.clip((line - SHADOW[0]) / (SHADOW[1] - SHADOW[0]), 0, 1))
            q[3] = shaped + tilted * (q[3] - shaped)
        faces.append(q)
        hidden.append(over)
    centres = [None if q is None else q.mean(0) for q in faces]
    moves = [np.inf] + [np.linalg.norm(centres[i] - centres[i - 1]) if centres[i] is not None and centres[i - 1] is not None else np.inf
                        for i in range(1, len(faces))]
    stop = next((i for i in range(len(faces) - 2) if first + i >= card["in"] and max(moves[i:i + 3]) < STILL), len(faces))
    shift = (rest - faces[stop]).mean(0) if stop < len(faces) else np.zeros(2)
    outlines = []
    for i, (hull, q) in enumerate(zip(hulls, faces)):
        if q is None:
            outlines.append(None)
            continue
        faces[i] = q + shift
        pts = np.vstack([np.asarray(hull), q]) if hidden[i] else np.asarray(hull)
        outline = cv2.convexHull(pts.astype(np.float32))[:, 0] + shift
        outlines.append(np.round(outline, 2).tolist())
    return {"from": first, "outlines": outlines[:stop], "faces": [None if q is None else np.round(q, 2).tolist() for q in faces[:stop]],
            "rest": first + stop}


def grey(fr: Frames, clip: dict, height: int):
    return lambda f: cv2.cvtColor(fr.get(clip["sourceStart"] + f)[:height], cv2.COLOR_BGR2GRAY)


def run(video: str, assets: str = "../game_assets", work: str = "work") -> None:
    path = Path(assets) / "manifest.json"
    m = json.loads(path.read_text())
    fr = Frames(video)
    sam = predictor(Path(work))
    raw = {}
    for name, clip in sorted(m["clips"].items()):
        if clip["kind"] != "hit":
            continue
        seat, k = clip["seat"], clip["card"]
        card = next(c for c in clip["cards"] if c["slot"] == seat and c["index"] == k)
        lying = sorted((c for c in clip["cards"] if c["slot"] == seat and c["index"] < k), key=lambda c: c["index"])
        first, hulls = track(sam, fr, clip, card, lying, m["height"])
        land = card["land"] = settle_on(card, lying[-1], first, hulls, grey(fr, clip, m["height"]))
        raw[name] = {"from": land["from"], "hulls": [None if h is None else np.round(h, 2).tolist() for h in hulls]}
        print(f"  {name}: tracked from {land['from'] - card['in']}, at rest from {land['rest'] - card['in']} (landing at {card['in']})", flush=True)
    path.write_text(json.dumps(m, indent=1))
    # what SAM 2 saw, so the outlines can be re-derived (rederive) without tracking again
    (Path(work) / "landing_hulls.json").write_text(json.dumps(raw))
    print(f"hit cards' landing outlines -> {path}")


def rederive(video: str, assets: str = "../game_assets", work: str = "work") -> None:
    """Faces, outlines and rest again from the hulls a run saved (after a change to settle_on)."""
    path = Path(assets) / "manifest.json"
    m = json.loads(path.read_text())
    fr = Frames(video)
    raw = json.loads((Path(work) / "landing_hulls.json").read_text())
    for name, r in raw.items():
        clip = m["clips"][name]
        seat, k = clip["seat"], clip["card"]
        card = next(c for c in clip["cards"] if c["slot"] == seat and c["index"] == k)
        under = next(c for c in clip["cards"] if c["slot"] == seat and c["index"] == k - 1)
        card["land"] = settle_on(card, under, r["from"], [None if h is None else np.array(h) for h in r["hulls"]], grey(fr, clip, m["height"]))
    path.write_text(json.dumps(m, indent=1))
    print(f"hit cards' landing outlines re-derived -> {path}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["rederive"]:
        rederive(*sys.argv[2:])
    else:
        run(*sys.argv[1:])
