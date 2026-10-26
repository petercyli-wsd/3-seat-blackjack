"""
Materials for the painted table (the input the sets pass restyles): Poly Haven's CC0 texture scans
(https://polyhaven.com/textures; 1k diffuse JPGs, named <id>_Diffuse.jpg).

    uv run python -m bj3.materials <textures dir> [game_assets dir]

Felt and leather become tileable grey detail maps (their grain, centred on mid-grey, for the app
to tint); wood keeps its colour. Writes game_assets/scene/materials/.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

# app name: (Poly Haven id, keep colour, detail contrast)
MATERIALS = {
    "felt": ("scuba_suede", False, 2.2),
    "leather": ("leather_white", False, 1.6),
    "wood": ("smoked_walnut_veneer", True, 1.0),
}


def materials(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, (tid, colour, contrast) in MATERIALS.items():
        im = cv2.imread(str(src / f"{tid}_Diffuse.jpg"))
        if not colour:
            g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32)
            # grain only: the scan's own shading taken out (blurred as tiled, so it stays tileable)
            h, w = g.shape
            low = cv2.GaussianBlur(np.tile(g, (3, 3)), (0, 0), 24)[h:2 * h, w:2 * w]
            im = np.clip(128 + (g - low) * contrast, 0, 255).astype(np.uint8)
        cv2.imwrite(str(out / f"{name}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(name, tid, im.shape)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("textures")
    ap.add_argument("assets", nargs="?", default=str(Path(__file__).resolve().parents[2] / "game_assets"))
    args = ap.parse_args()
    materials(Path(args.textures), Path(args.assets) / "scene" / "materials")


if __name__ == "__main__":
    main()
