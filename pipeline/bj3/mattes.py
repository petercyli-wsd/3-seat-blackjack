"""
The dealer's per-frame alpha matte, packed into each clip: MatAnyone (RunningHub) mattes every clip
and loop the table plays, and each is re-encoded with its matte stacked below the picture
(1440x1620: picture on top, matte below as grey), so the browser decodes the two in lockstep.

    uv run python -m bj3.mattes [files...] [--assets game_assets] [--jobs 3] [--bridges]

Writes game_assets/matted/<the clip's own path> and game_assets/scene/mattes.json, which lists each
packed file with the size of the clip it was made from: the app plays the packed file instead of
the clip, and one whose clip has changed since (another size: re-cut, or a bridge generated again)
is left to the colour key until this runs again. Raw mattes are kept in pipeline/work/mattes/.

--bridges mattes the generated bridges (bridges.json) instead. They are many and short (a dozen
frames or so), so they go to MatAnyone strung together, a few hundred frames to a job, each led in
by its first frame held a few times so the matte has settled on her there before she moves; the
matte is then cut back into the bridges.
"""

from __future__ import annotations

import argparse
import hashlib
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


def video_frames(path: Path):
    cap = cv2.VideoCapture(str(path))
    while True:
        ok, f = cap.read()
        if not ok:
            break
        yield f
    cap.release()


def pack(src: Path, matte, dst: Path) -> None:
    """The clip with its matte (a video, or its frames) stacked below the picture."""
    a = cv2.VideoCapture(str(src))
    b = iter(video_frames(matte) if isinstance(matte, Path) else matte)
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
        m = next(b, None)
        if m is not None:
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


# bridges: frames per MatAnyone job, and how many times each bridge's first frame leads it in
CHUNK = 600
LEAD = 4


def bridge_files(assets: Path) -> list[str]:
    rows = json.loads((assets / "bridges.json").read_text())["bridges"]
    return sorted({r["file"] for r in rows if r.get("frames", 0) > 0 and r.get("file")})


def string_together(assets: Path, todo: list[str], out: Path) -> list[tuple[str, int]]:
    """The bridges in one video, each led in by its first frame LEAD times: (file, frames) each."""
    cap = cv2.VideoCapture(str(assets / todo[0]))
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", "24000/1001", "-i", "-", *X264, str(out)]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    index = []
    for f in todo:
        frames = list(video_frames(assets / f))
        for _ in range(LEAD):
            enc.stdin.write(frames[0].tobytes())
        for fr in frames:
            enc.stdin.write(fr.tobytes())
        index.append((f, len(frames)))
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError(f"encode failed for {out}")
    return index


def bridge_chunk(i: int, todo: list[str], assets: Path, work: Path) -> list[tuple[str, int]]:
    """One MatAnyone job for a run of bridges; each is packed with its share of the matte."""
    # kept under a name of what is in it, with the bridges' sizes (one generated again is matted again)
    key = hashlib.sha1(" ".join(f"{f}:{(assets / f).stat().st_size}" for f in todo).encode()).hexdigest()[:12]
    src = work / "bridges" / f"{key}.mp4"
    raw = work / "bridges" / f"{key}.matte.mp4"
    listing = work / "bridges" / f"{key}.json"
    src.parent.mkdir(parents=True, exist_ok=True)
    try:
        if not listing.exists():
            listing.write_text(json.dumps(string_together(assets, todo, src)))
        index = json.loads(listing.read_text())
        if not raw.exists():
            runninghub.matanyone(src, raw)
        mattes = video_frames(raw)
        done = []
        for f, n in index:
            for _ in range(LEAD):
                next(mattes, None)
            pack(assets / f, [next(mattes) for _ in range(n)], assets / "matted" / f)
            done.append((f, (assets / f).stat().st_size))
        print(f"chunk {i}: packed {len(done)} bridges", flush=True)
        return done
    except Exception as e:  # its bridges keep the colour key
        print("FAILED chunk", i, e, flush=True)
        return []


def bridges(assets: Path, work: Path, jobs: int, todo: list[str]) -> list[tuple[str, int]]:
    chunks: list[list[str]] = [[]]
    n = 0
    for f in todo:
        k = int(cv2.VideoCapture(str(assets / f)).get(cv2.CAP_PROP_FRAME_COUNT)) + LEAD
        if chunks[-1] and n + k > CHUNK:
            chunks.append([])
            n = 0
        chunks[-1].append(f)
        n += k
    print(f"{len(todo)} bridges in {len(chunks)} jobs", flush=True)
    with ThreadPoolExecutor(jobs) as pool:
        return [d for r in pool.map(lambda ic: bridge_chunk(ic[0], ic[1], assets, work), enumerate(chunks)) for d in r]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--assets", default=str(ROOT / "game_assets"))
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--bridges", action="store_true", help="matte the generated bridges (the files given, else all)")
    args = ap.parse_args()
    assets = Path(args.assets)
    work = ROOT / "pipeline" / "work" / "mattes"
    if args.bridges:
        todo = args.files or bridge_files(assets)
        done = bridges(assets, work, args.jobs, todo)
    else:
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
