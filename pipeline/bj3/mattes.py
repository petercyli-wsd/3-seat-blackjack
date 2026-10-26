"""
The dealer's per-frame alpha matte, packed into each clip: MatAnyone (RunningHub) mattes every clip
and loop the table plays, and each is re-encoded with its matte stacked below the picture
(1440x1620: picture on top, matte below as grey), so the browser decodes the two in lockstep.

    uv run python -m bj3.mattes [files...] [--assets game_assets] [--jobs 3]

Writes game_assets/matted/<the clip's own path> and game_assets/scene/mattes.json, which lists each
packed file with the size of the clip it was made from: the app plays the packed file instead of
the clip, and a clip re-cut since (another size) is left to the colour key until this runs again.
Raw mattes are kept in pipeline/work/mattes/. Bridges are generated footage and are not matted:
they keep the colour key.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np

from . import runninghub
from .export import X264

ROOT = Path(__file__).resolve().parents[2]


def files(assets: Path) -> list[str]:
    m = json.loads((assets / "manifest.json").read_text())
    out = []
    for c in m["clips"].values():
        if c.get("bridge"):
            continue
        for f in (c["file"], c.get("loop")):
            if f and f not in out:
                out.append(f)
    return out


def pack(src: Path, matte: Path, dst: Path) -> None:
    a, b = cv2.VideoCapture(str(src)), cv2.VideoCapture(str(matte))
    w, h = int(a.get(cv2.CAP_PROP_FRAME_WIDTH)), int(a.get(cv2.CAP_PROP_FRAME_HEIGHT))
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.mp4")
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h * 2}", "-r", "24000/1001", "-i", "-", *X264, str(tmp)]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = 0
    last = np.zeros((h, w, 3), np.uint8)
    while True:
        ok, f = a.read()
        if not ok:
            break
        ok, m = b.read()
        if ok:
            last = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR) if m.shape[:2] != (h, w) else m
        # MatAnyone's matte is grey already; one channel, spread to all three
        g = last[..., 1:2]
        enc.stdin.write(np.vstack([f, np.repeat(g, 3, axis=2)]).tobytes())
        n += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError(f"encode failed for {src}")
    tmp.replace(dst)


def one(f: str, assets: Path, work: Path) -> tuple[str, int] | None:
    src = assets / f
    raw = work / (f + ".matte.mp4")
    try:
        if not raw.exists():
            runninghub.matanyone(src, raw)
        pack(src, raw, assets / "matted" / f)
        print("packed", f, flush=True)
        return f, src.stat().st_size
    except Exception as e:  # one clip failing leaves it to the colour key
        print("FAILED", f, e, flush=True)
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--assets", default=str(ROOT / "game_assets"))
    ap.add_argument("--jobs", type=int, default=3)
    args = ap.parse_args()
    assets = Path(args.assets)
    work = ROOT / "pipeline" / "work" / "mattes"
    todo = args.files or files(assets)
    with ThreadPoolExecutor(args.jobs) as pool:
        done = [r for r in pool.map(lambda f: one(f, assets, work), todo) if r]
    listing_file = assets / "scene" / "mattes.json"
    listing = json.loads(listing_file.read_text()) if listing_file.exists() else {}
    listing.update({f: {"file": f"matted/{f}", "sourceSize": size} for f, size in done})
    listing_file.write_text(json.dumps(dict(sorted(listing.items())), indent=1))
    print(f"{len(done)}/{len(todo)} packed")


if __name__ == "__main__":
    main()
