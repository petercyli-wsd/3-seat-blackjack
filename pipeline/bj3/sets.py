"""
Sets for the scene swap: a photoreal studio around the dealer, room and table together, generated
with nano-banana-pro (RunningHub) from the app's own render of the empty set, so the camera and the
table's geometry are this take's.

    uv run python -m bj3.sets <input.png> [ids...] [--assets game_assets] [--out raw_dir]

<input.png> is the app's render of the set alone in the dealer framing (1600x900): its painted
table, in Studio Blue felt, over a plain grey backdrop (see app/scripts/set-input.mjs). Each room in
ROOMS restyles that into a studio set, keeping the table where it is; the result is then aligned
back onto the input (a homography fitted on the table's edges, so the table's back edge lands on
the cloth's within a pixel), and written to game_assets/scene/sets/<id>.jpg, with sets.json.

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

# id: (name, room description, rail, apron)
ROOMS: dict[str, tuple[str, str, str, str]] = {
    "lotus": (
        "Lotus Rose",
        "a curved feature wall of carved cream travertine panels shaped like large lotus petals, "
        "washed from below with soft pink and violet light, between deep plum walls with tall "
        "brass-framed vertical light columns; potted tropical plants in brass planters at both "
        "far sides.",
        "black leather", "polished dark walnut apron",
    ),
    "emerald": (
        "Emerald Salon",
        "an art-deco salon: warm gold and walnut raised-panel walls, a band of vertical fluted "
        "wood behind the dealer's position, and tall emerald-green marble pilasters at both sides "
        "with a soft green glow at their edges and slim brass trims.",
        "tan leather", "polished walnut apron",
    ),
    "sapphire": (
        "Sapphire Night",
        "a modern night-time set: rich walnut wall panels alternating with tall backlit screens of "
        "gold metal teardrop lattice glowing royal blue from behind, a dark ceiling, subtle "
        "magenta accent light.",
        "black leather", "dark walnut apron with a slim magenta LED light line along its foot",
    ),
    "golden": (
        "Golden Hall",
        "a luxurious set: a wall of gold quilted metallic panels straight behind the table, with a "
        "row of hanging crystal fins above catching warm light, and warm gold bokeh lights at both "
        "far sides. No machines, no screens.",
        "black leather", "brushed gold apron with a warm white LED line along its foot",
    ),
    "onyx": (
        "Amber Onyx",
        "a feature wall of polished golden onyx marble with dramatic warm veining, lit from "
        "behind, flanked by tall vertical white light bars set in bronze frames, with sculpted "
        "topiary trees in gold planters at both far sides.",
        "black leather", "polished black lacquer apron",
    ),
    "midnight": (
        "Midnight Velvet",
        "deep navy velvet drapes in soft folds, polished black lacquer pilasters with brass "
        "art-deco wall sconces casting warm pools of light, a dark ceiling.",
        "dark brown leather", "polished dark walnut apron",
    ),
}


def prompt(rid: str) -> str:
    _, room, rail, apron = ROOMS[rid]
    return LOOK.format(room=room) + " " + TABLE.format(rail=rail, apron=apron)


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


# a generation whose table won't align this well is asked for again (up to TRIES times, best kept)
GOOD_CC = 0.85
TRIES = 3


def make(rid: str, inp_path: Path, raw: Path, out: Path) -> dict:
    inp = cv2.imread(str(inp_path))
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
    cc, aligned = best
    cv2.imwrite(str(out / f"{rid}.jpg"), aligned, [cv2.IMWRITE_JPEG_QUALITY, 90])
    # the felt's colour as generated, for the app's recolouring
    felt = table_mask(inp).astype(bool) & (aligned[..., 0].astype(int) - np.maximum(aligned[..., 1], aligned[..., 2]) > 40)
    mean = aligned[felt].mean(0)[::-1] / 255 if felt.any() else np.array([0.08, 0.3, 0.7])
    print(rid, "aligned, cc", round(cc, 3))
    return {"id": rid, "name": ROOMS[rid][0], "file": f"scene/sets/{rid}.jpg", "felt": [round(float(v), 4) for v in mean],
            "credit": "Generated with nano-banana-pro (RunningHub) from this take's empty set"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--assets", default=str(Path(__file__).resolve().parents[2] / "game_assets"))
    ap.add_argument("--out", default=None, help="where the raw generations are kept (default: pipeline/work/sets)")
    args = ap.parse_args()
    ids = args.ids or list(ROOMS)
    raw = Path(args.out) if args.out else Path(__file__).resolve().parents[1] / "work" / "sets"
    raw.mkdir(parents=True, exist_ok=True)
    out = Path(args.assets) / "scene" / "sets"
    out.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(3) as pool:
        made = list(pool.map(lambda r: make(r, Path(args.input), raw, out), ids))
    listing_file = out.parent / "sets.json"
    listing = {s["id"]: s for s in (json.loads(listing_file.read_text()) if listing_file.exists() else [])}
    listing.update({s["id"]: s for s in made})
    listing_file.write_text(json.dumps([listing[r] for r in ROOMS if r in listing], indent=2))


if __name__ == "__main__":
    main()
