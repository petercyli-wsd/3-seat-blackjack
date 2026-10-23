"""Pass 4: write the trimmed clips.

The source is decoded once (the same OpenCV decode every analysis pass used,
so frame N here is frame N there) and piped segment by segment into x264.
Static segments (wait, hold, idle) also get a ping-pong loop file —
forward then reversed, without repeating either end frame — because a
browser can't play video backwards, and a ping-pong loop has no visible jump
however long the player takes to decide.
"""

import json
import subprocess
import sys
from pathlib import Path

import cv2
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
RATE = "24000/1001"
X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
        "-g", "24", "-bf", "2", "-movflags", "+faststart", "-an"]
STATIC = {"wait", "hold", "idle"}


def folder(seg: dict) -> str:
    if seg["kind"] == "hit" or seg.get("seat"):
        return "hits"
    if seg.get("part") == 2:
        return "full_table"
    return "starting_hands"


def clip_path(seg: dict) -> str:
    return f"clips/{folder(seg)}/{seg['name']}.mp4"


def loop_path(seg: dict) -> str:
    return f"loops/{seg['name']}_loop.mp4"


def encoder(path: Path, w: int, h: int) -> subprocess.Popen:
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{w}x{h}", "-r", RATE, "-i", "-", *X264, str(path)]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def pingpong(src: Path, dst: Path, frames: int) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    graph = (f"[0:v]split[f][r];[r]reverse,trim=start_frame=1:end_frame={frames - 1},setpts=PTS-STARTPTS[b];"
             f"[f][b]concat=n=2:v=1[out]")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-filter_complex", graph,
                    "-map", "[out]", "-r", RATE, *X264, str(dst)], check=True)


def run(video: str, edl: str, out_dir: str) -> None:
    out = Path(out_dir)
    segs = json.load(open(edl))["segments"]
    cap = cv2.VideoCapture(video)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    i = 0
    for s in segs:
        enc = encoder(out / clip_path(s), w, h)
        while i < s["end"]:
            ok, f = cap.read()
            if not ok:
                break
            if i >= s["start"]:
                enc.stdin.write(f.tobytes())
            i += 1
        enc.stdin.close()
        enc.wait()
        print(f"{clip_path(s)}  {s['frames']} frames", flush=True)
    for s in segs:
        if s["kind"] in STATIC and s["frames"] >= 3:
            pingpong(out / clip_path(s), out / loop_path(s), s["frames"])
            print(f"{loop_path(s)}  {2 * s['frames'] - 2} frames", flush=True)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3])
