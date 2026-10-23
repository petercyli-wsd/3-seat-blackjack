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


def loop_window(seg: dict) -> tuple[int, int]:
    """Clip frames [a, b) the seg's loop plays: an idle's calm stretch (see edl.calm_loops), else all of it."""
    if "loop_in" in seg:
        return seg["loop_in"] - seg["start"], seg["loop_out"] - seg["start"]
    return 0, seg["frames"]


def pingpong(src: Path, dst: Path, window: tuple[int, int]) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    a, b = window
    graph = (f"[0:v]trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS,split[f][r];"
             f"[r]reverse,trim=start_frame=1:end_frame={b - a - 1},setpts=PTS-STARTPTS[b];"
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
            a, b = loop_window(s)
            pingpong(out / clip_path(s), out / loop_path(s), (a, b))
            print(f"{loop_path(s)}  {2 * (b - a) - 2} frames", flush=True)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3])
