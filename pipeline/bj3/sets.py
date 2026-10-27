"""
Sets for the scene swap: a photoreal studio around the dealer, room and table together, generated
with nano-banana-pro (RunningHub) from the app's own render of the empty set, so the camera and the
table's geometry are this take's.

    uv run python -m bj3.sets <input.png> [ids...] [--assets game_assets] [--out raw_dir] [--keep-rooms] [--style photo ...]
                              [--pick id=raw_file ...]

<input.png> is the app's render of the set alone in the dealer framing (1600x900): its painted
table, in Studio Blue felt, over a plain grey backdrop (see app/scripts/set-input.mjs). It is made in
two edits. First each room in ROOMS restyles that into a studio set, keeping the table where it is
(the generator keeps the painted table near enough as it is, flat). Then the table alone is
re-made as a photographed one (felt, padded armrest, trim and apron, lit by that room), the room
left as it is. Each result is aligned back onto the input (a homography fitted on the table's edges,
then on its felt, so the felt lies on the cloth and its back edge on the cloth's within a pixel),
and written to game_assets/scene/sets/<id>.jpg, with sets.json. --keep-rooms starts the second
edit from the sets as they are in game_assets. --style gives the table edit photos of real casino
tables (crops of a felt, of a padded armrest) to match in realism; without one the generator tends to keep
the painted table's flat look. --pick names, for a room, which kept generation to use instead
(chosen by eye; the generator varies a lot from one to the next).

The felt is kept blue in every set: the app recolours it per table, by its own blue.
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

from . import runninghub

OUT = (1600, 900)

TABLE = (
    "Keep the blackjack table exactly where and how it is in the image: the same half-round shape, "
    "size, position and perspective, its straight back edge in exactly the same place, the same "
    "royal-blue felt colour, the same printed text and the three numbered betting boxes in the same "
    "places. Make it a real premium casino table: fine wool felt with a subtle texture, a padded "
    "{rail} armrest with a thin polished gold trim on its inner edge, and below it a {apron}. Nothing "
    "on the table: no cards, chips, card shoe, discard holder, people or hands."
)
LOOK = (
    "Photorealistic broadcast still of a live-casino blackjack studio, from exactly the same camera "
    "as the input image: same framing, same horizon, same perspective. Replace the plain grey "
    "backdrop with {room} It is the wall and space directly behind the dealer's position, about "
    "two metres behind the table. Soft, flattering studio key light from the front and above, "
    "warm practical lights in the set; the set slightly soft, as a cinema camera at f/2.8 focused "
    "on the table would see it; the table crisp. No people anywhere. No text, logos or signage "
    "anywhere except the print on the felt."
)
# the second edit: the table alone, made real (the first keeps the painted one, flat)
REAL_TABLE = (
    "Edit this photo of a live-casino blackjack studio. Keep the room exactly as it is: every wall, "
    "light, plant, the floor, the light and every colour unchanged, and the same camera, framing "
    "and perspective.\n\n"
    "Replace only the blackjack table, which looks like flat computer graphics, with a real, "
    "photographed premium casino blackjack table filling exactly the same outline: the same "
    "half-round shape, size, position and perspective, its straight back edge in exactly the same "
    "place, the armrest and the base following the same curves.\n\n"
    "The table must be indistinguishable from a photograph: real royal-blue casino baize (fine wool "
    "felt) with a visible fibre texture, lit from above by the studio's key light so it is brightest "
    "in the middle and falls off gently toward the rail, with soft natural vignetting and a faint "
    "cast from {light}. Printed on the felt in crisp cream-gold ink, along the same arcs as now: "
    '"BLACKJACK PAYS 3 TO 2" in elegant bold serif capitals, and under it smaller "Dealer stands on '
    'all 17s · Six cards win"; the three numbered card boxes as fine printed outlines in the same '
    "places. A thick padded {rail} armrest with fine stitching and soft highlights from the room's "
    "lights, a slim polished brass trim between the felt and the armrest, and below it a curved "
    "{apron} that catches {light}. Nothing on the table: no cards, chips, card shoe, people or "
    "hands. No logos."
)
# with photos of real tables given after the room (--style)
STYLE_NOTE = (
    "\n\nThe other images are photographs of real casino tables, for reference only: match their "
    "photographic realism (the felt's fibre and the way light falls off across it, the crisp print, "
    "the grain, sheen and stitched seams of the padded leather armrest), but keep the first image's "
    "colours, materials, print and layout as described above. Use nothing else from them."
)

# id: (name, room description, rail, apron, the room's light as it falls on the table)
ROOMS: dict[str, tuple[str, str, str, str, str]] = {
    "lotus": (
        "Lotus Rose",
        "a curved feature wall of carved cream travertine panels shaped like large lotus petals, "
        "washed from below with soft pink and violet light, between deep plum walls with tall "
        "brass-framed vertical light columns; potted tropical plants in brass planters at both "
        "far sides.",
        "plump black grained leather", "polished dark walnut apron",
        "the warm pink and violet glow of the room",
    ),
    "emerald": (
        "Emerald Salon",
        "an art-deco salon: warm gold and walnut raised-panel walls, a band of vertical fluted "
        "wood behind the dealer's position, and tall emerald-green marble pilasters at both sides "
        "with a soft green glow at their edges and slim brass trims.",
        "tan leather", "polished walnut apron",
        "the warm gold light and soft green glow of the room",
    ),
    "sapphire": (
        "Sapphire Night",
        "a modern night-time set: rich walnut wall panels alternating with tall backlit screens of "
        "gold metal teardrop lattice glowing royal blue from behind, a dark ceiling, subtle "
        "magenta accent light.",
        "black leather", "dark walnut apron with a slim magenta LED light line along its foot",
        "the royal-blue and magenta glow of the room",
    ),
    "golden": (
        "Golden Hall",
        "a luxurious set: a wall of gold quilted metallic panels straight behind the table, with a "
        "row of hanging crystal fins above catching warm light, and warm gold bokeh lights at both "
        "far sides. No machines, no screens.",
        "black leather", "brushed gold apron with a warm white LED line along its foot",
        "the warm gold light of the room",
    ),
    "onyx": (
        "Amber Onyx",
        "a feature wall of polished golden onyx marble with dramatic warm veining, lit from "
        "behind, flanked by tall vertical white light bars set in bronze frames, with sculpted "
        "topiary trees in gold planters at both far sides.",
        "black leather", "polished black lacquer apron",
        "the warm amber glow of the onyx wall",
    ),
    "midnight": (
        "Midnight Velvet",
        "deep navy velvet drapes in soft folds, polished black lacquer pilasters with brass "
        "art-deco wall sconces casting warm pools of light, a dark ceiling.",
        "dark brown leather", "polished dark walnut apron",
        "the warm pools of light from the brass sconces",
    ),
}


def prompt(rid: str) -> str:
    _, room, rail, apron, _ = ROOMS[rid]
    return LOOK.format(room=room) + " " + TABLE.format(rail=rail, apron=apron)


def table_prompt(rid: str, style: bool) -> str:
    _, _, rail, apron, light = ROOMS[rid]
    return REAL_TABLE.format(rail=rail, apron=apron, light=light) + (STYLE_NOTE if style else "")


def table_mask(inp: np.ndarray) -> np.ndarray:
    """The painted table in the input: everything unlike the plain grey backdrop."""
    x = inp.astype(np.float32) / 255
    sat = x.max(-1) - x.min(-1)
    m = (sat > 0.06).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    return m


def align(gen: np.ndarray, inp: np.ndarray) -> tuple[np.ndarray, float]:
    """Warp the generated set so its table lies on the input's: ECC on edge maps around the table."""
    def edges(im: np.ndarray) -> np.ndarray:
        g = cv2.GaussianBlur(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, (0, 0), 2)
        return cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    m = cv2.dilate(table_mask(inp), np.ones((41, 41), np.uint8))
    warp = np.eye(3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6)
    try:
        cc, warp = cv2.findTransformECC(edges(inp), edges(gen), warp, cv2.MOTION_HOMOGRAPHY, crit, m, 5)
    except cv2.error:
        cc = 0.0
    out = cv2.warpPerspective(gen, warp, OUT, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return out, float(cc)


def felt_mask(im: np.ndarray, near: np.ndarray) -> np.ndarray:
    """The table's felt: strongly blue (B - max(R, G)), the one region of it on the table (`near`),
    its print filled in."""
    blue = (im[..., 0].astype(int) - np.maximum(im[..., 1], im[..., 2]) > 30) & near.astype(bool)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(blue.astype(np.uint8), 8)
    if n <= 1:
        return blue.astype(np.uint8)
    m = (lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    flood = m.copy()
    cv2.floodFill(flood, np.zeros((m.shape[0] + 2, m.shape[1] + 2), np.uint8), (0, 0), 1)
    return m | (flood == 0).astype(np.uint8)


def align_felt(gen: np.ndarray, inp: np.ndarray) -> tuple[np.ndarray, float]:
    """Warp a set already near the input so its felt lies on the input's: ECC on the two felts'
    outlines, blurred, so the back edge (where she leans) and the felt's curve both pull."""
    near = cv2.dilate(table_mask(inp), np.ones((61, 61), np.uint8))
    a = cv2.GaussianBlur(felt_mask(inp, near).astype(np.float32), (0, 0), 3)
    b = cv2.GaussianBlur(felt_mask(gen, near).astype(np.float32), (0, 0), 3)
    warp = np.eye(3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 400, 1e-7)
    try:
        cc, warp = cv2.findTransformECC(a, b, warp, cv2.MOTION_HOMOGRAPHY, crit, None, 5)
    except cv2.error:
        cc = 0.0
    out = cv2.warpPerspective(gen, warp, OUT, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return out, float(cc)


# a generation whose table won't align this well is asked for again (up to TRIES times, best kept)
GOOD_CC = 0.85
# the share of the felt (intersection over union) where the input has it, before aligning
GOOD_FELT = 0.95
TRIES = 3


def room(rid: str, inp_path: Path, inp: np.ndarray, raw: Path) -> np.ndarray:
    """The first edit: the room around the painted table, aligned onto the input."""
    best: tuple[float, np.ndarray] | None = None
    for attempt in range(TRIES):
        raw_file = raw / (f"{rid}.png" if attempt == 0 else f"{rid}.{attempt}.png")
        if not raw_file.exists():
            runninghub.download(runninghub.nano_banana_edit([inp_path], prompt(rid)), raw_file)
        aligned, cc = align(cv2.resize(cv2.imread(str(raw_file)), OUT, interpolation=cv2.INTER_AREA), inp)
        if best is None or cc > best[0]:
            best = (cc, aligned)
        if cc >= GOOD_CC:
            break
    print(rid, "room aligned, cc", round(best[0], 3))
    return best[1]


def real_table(rid: str, room_file: Path, inp: np.ndarray, raw: Path, style: list[Path], pick: str | None = None) -> np.ndarray:
    """The second edit: the room's table made real, aligned onto the input by its felt. A table whose
    felt came out another size (the armrest grown into it) would be aligned only by scaling the
    whole picture, the room with it: it is asked for again."""
    near = cv2.dilate(table_mask(inp), np.ones((61, 61), np.uint8))
    want = felt_mask(inp, near).astype(bool)
    best: tuple[float, np.ndarray] | None = None
    for attempt in range(0 if pick else TRIES):
        stem = f"{rid}.real" if style else f"{rid}.table"
        raw_file = raw / (f"{stem}.png" if attempt == 0 else f"{stem}.{attempt}.png")
        if not raw_file.exists():
            runninghub.download(runninghub.nano_banana_edit([room_file, *style], table_prompt(rid, bool(style))), raw_file)
        gen = cv2.resize(cv2.imread(str(raw_file)), OUT, interpolation=cv2.INTER_AREA)
        got = felt_mask(gen, near).astype(bool)
        fit = float((want & got).sum() / max((want | got).sum(), 1))
        if best is None or fit > best[0]:
            best = (fit, gen)
        if fit >= GOOD_FELT:
            break
    if pick:
        # a generation chosen by eye (--pick), from those kept in raw
        gen = cv2.resize(cv2.imread(str(raw / pick)), OUT, interpolation=cv2.INTER_AREA)
        got = felt_mask(gen, near).astype(bool)
        best = (float((want & got).sum() / max((want | got).sum(), 1)), gen)
    aligned, cc = align_felt(best[1], inp)
    print(rid, "table: felt as generated", round(best[0], 3), "aligned, cc", round(cc, 4))
    return aligned


def make(rid: str, inp_path: Path, raw: Path, out: Path, keep_rooms: bool, style: list[Path], pick: str | None) -> dict:
    inp = cv2.imread(str(inp_path))
    room_file = raw / f"{rid}.room.jpg"
    if not room_file.exists():
        # --keep-rooms: the set as it is in game_assets is the room (its table still the painted one)
        aligned = cv2.imread(str(out / f"{rid}.jpg")) if keep_rooms else room(rid, inp_path, inp, raw)
        cv2.imwrite(str(room_file), aligned, [cv2.IMWRITE_JPEG_QUALITY, 95])
    aligned = real_table(rid, room_file, inp, raw, style, pick)
    cv2.imwrite(str(out / f"{rid}.jpg"), aligned, [cv2.IMWRITE_JPEG_QUALITY, 92])
    # the felt's colour as generated, for the app's recolouring
    felt = felt_mask(aligned, cv2.dilate(table_mask(inp), np.ones((61, 61), np.uint8))).astype(bool)
    felt &= aligned[..., 0].astype(int) - np.maximum(aligned[..., 1], aligned[..., 2]) > 40
    mean = aligned[felt].mean(0)[::-1] / 255 if felt.any() else np.array([0.08, 0.3, 0.7])
    return {"id": rid, "name": ROOMS[rid][0], "file": f"scene/sets/{rid}.jpg", "felt": [round(float(v), 4) for v in mean],
            "credit": "Generated with nano-banana-pro (RunningHub) from this take's empty set"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--assets", default=str(Path(__file__).resolve().parents[2] / "game_assets"))
    ap.add_argument("--out", default=None, help="where the raw generations are kept (default: pipeline/work/sets)")
    ap.add_argument("--keep-rooms", action="store_true", help="re-make only the tables, in the sets as they are")
    ap.add_argument("--style", nargs="*", default=[], help="photos of real casino tables, for the table edit to match in realism")
    ap.add_argument("--pick", nargs="*", default=[], help="id=file: the raw table generation to use for a room")
    args = ap.parse_args()
    picks = dict(p.split("=", 1) for p in args.pick)
    ids = args.ids or list(ROOMS)
    raw = Path(args.out) if args.out else Path(__file__).resolve().parents[1] / "work" / "sets"
    raw.mkdir(parents=True, exist_ok=True)
    out = Path(args.assets) / "scene" / "sets"
    out.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(3) as pool:
        made = list(pool.map(lambda r: make(r, Path(args.input), raw, out, args.keep_rooms, [Path(x) for x in args.style], picks.get(r)), ids))
    listing_file = out.parent / "sets.json"
    listing = {s["id"]: s for s in (json.loads(listing_file.read_text()) if listing_file.exists() else [])}
    listing.update({s["id"]: s for s in made})
    listing_file.write_text(json.dumps([listing[r] for r in ROOMS if r in listing], indent=2))


if __name__ == "__main__":
    main()
