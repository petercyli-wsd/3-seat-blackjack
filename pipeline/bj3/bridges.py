"""Interpolated bridges for every cut the game can make between clips that
were not filmed back to back.

    python -m bj3.bridges plan  <full_footage.mp4>   # stubs + CSV for the interpolation tool
    python -m bj3.bridges ingest <tool output dir>   # (after generation) cut bridges into game_assets

The game only ever leaves a clip from a loop (wait / idle) — the dealer at
rest — and enters the first frame of an action clip (deal / hit / reveal).
A pre-rendered bridge needs a fixed exit frame, so each source loop gets
exit *anchors*: both ends of the clip plus interior frames about a second
apart (at the stillest frame near each grid point). The player then never
waits more than ~1 s for the next anchor after hitting or dealing.

Cuts that are contiguous in the take (a loop's last frame -> the clip that
followed it) are already seamless and get no bridge. Hold loops only ever
lead to their own discard, so the game waits for that seamless anchor.

The interpolation tool joins "entire first video -> bridge -> entire second
video". Each row's first video is a short stub ending exactly on the exit
frame, its second a short stub starting exactly on the entry frame; ingest
finds the bridge between them by matching those two frames.
"""

import csv
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3.export import FFMPEG, RATE, X264
from bj3.geometry import PLAY_ORDER

STUB = 8  # frames per stub: enough context, small uploads
ANCHOR_SPACING = 24  # ~1 s at 23.976 fps
ANCHOR_SEARCH = 6  # look this many frames either side of a grid point for the stillest frame
HERE = Path(__file__).resolve().parents[1]
BRIDGE_DIR = HERE.parent / "bridges"


def seats_in(mask: str) -> list[str]:
    return [f"seat{i + 1}" for i, b in enumerate(mask) if b == "1"]


def transitions(segs: dict[str, dict]) -> dict[str, set[str]]:
    """Every (loop -> action clip) cut the round script can make."""
    masks = sorted({s["mask"] for s in segs.values() if s.get("part") == 1})
    deals = [f"{m}_deal" for m in masks]
    out: dict[str, set[str]] = {}
    # betting: any idle loop -> any combination's deal
    for name in ["opening_idle"] + [f"{m}_idle" for m in masks]:
        out[name] = set(deals)
    # first decision on the part-1 wait: a seat's first hit, or (all stood) the reveal
    for m in masks:
        out[f"{m}_wait"] = {f"{s}_card3_deal" for s in seats_in(m)} | {f"{m}_reveal"}
    # after a seat has hit (part-2 wait loops): its next hit, a later seat's first hit, or the reveal
    for s in PLAY_ORDER:
        later = PLAY_ORDER[PLAY_ORDER.index(s) + 1:]
        for k in range(3, 7):
            t = {f"{x}_card3_deal" for x in later}
            t |= {f"{m}_reveal" for m in masks if s in seats_in(m)}
            if k < 6:
                t.add(f"{s}_card{k + 1}_deal")
            out[f"{s}_card{k}_wait"] = t
    return out


def natural_next(segs: dict[str, dict], name: str) -> str | None:
    end = segs[name]["end"]
    return next((k for k, s in segs.items() if s["start"] == end), None)


def anchors(seg: dict, motion: np.ndarray) -> list[int]:
    """Exit frames (clip-relative): both ends plus the stillest frame near every ~1 s grid point."""
    n = seg["end"] - seg["start"]
    out = {0, n - 1}
    for g in range(ANCHOR_SPACING, n - ANCHOR_SPACING // 2, ANCHOR_SPACING):
        lo, hi = max(1, g - ANCHOR_SEARCH), min(n - 2, g + ANCHOR_SEARCH)
        if hi > lo:
            out.add(lo + int(np.argmin(motion[seg["start"] + lo:seg["start"] + hi + 1])))
    return sorted(out)


def write_stub(frames: list[np.ndarray], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = frames[0].shape[:2]
    p = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                          "-s", f"{w}x{h}", "-r", RATE, "-i", "-", *X264, str(path)], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()


def plan(video: str, work: str = "work", out_dir: str | None = None) -> None:
    work_p = Path(work)
    bdir = Path(out_dir) if out_dir else BRIDGE_DIR
    segs = {s["name"]: s for s in json.load(open(work_p / "edl.json"))["segments"]}
    z = np.load(work_p / "pose.npz")
    P = z["pose"].astype(np.float32)
    keep = z["keep"]
    motion = np.zeros(len(P), np.float32)
    motion[1:] = np.abs(P[1:] - P[:-1])[:, keep].mean(1)
    motion = np.convolve(motion, np.ones(5) / 5, "same")

    rows, exits, entries = [], {}, set()
    for src, targets in sorted(transitions(segs).items()):
        seg = segs[src]
        nat = natural_next(segs, src)
        last = seg["end"] - seg["start"] - 1
        for f in anchors(seg, motion):
            for dst in sorted(targets):
                if dst == nat and f == last:
                    continue  # already seamless in the take
                exit_id = f"{src}@{f:04d}"
                exits[exit_id] = (src, f, f == 0)
                entries.add(dst)
                rows.append({"src": src, "frame": f, "dst": dst, "exit": exit_id, "output": f"{exit_id}__{dst}.mp4"})

    # stubs: frames read in one pass over the take
    need: dict[int, None] = {}
    exit_frames = {}
    for exit_id, (src, f, at_start) in exits.items():
        a = segs[src]["start"] + f
        # the stub runs in the direction of travel into the anchor: the start anchor is reached going backwards
        idx = list(range(a + STUB - 1, a - 1, -1)) if at_start else list(range(a - STUB + 1, a + 1))
        exit_frames[exit_id] = idx
        need.update(dict.fromkeys(idx))
    entry_frames = {dst: list(range(segs[dst]["start"], segs[dst]["start"] + STUB)) for dst in entries}
    for idx in entry_frames.values():
        need.update(dict.fromkeys(idx))
    cache = {}
    cap = cv2.VideoCapture(video)
    hi = max(need)
    i = 0
    while i <= hi:
        ok, fr = cap.read()
        if not ok:
            break
        if i in need:
            cache[i] = fr
        i += 1
    stubs = bdir / "stubs"
    for exit_id, idx in exit_frames.items():
        write_stub([cache[j] for j in idx], stubs / "exit" / f"{exit_id}.mp4")
    for dst, idx in entry_frames.items():
        write_stub([cache[j] for j in idx], stubs / "entry" / f"{dst}.mp4")

    with open(bdir / "bridges.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["first_half", "second_half", "output"])
        for r in rows:
            w.writerow([f"exit/{r['exit']}.mp4", f"entry/{r['dst']}.mp4", r["output"]])
    (bdir / "plan.json").write_text(json.dumps({"stub": STUB, "fps": 24000 / 1001, "rows": rows}, indent=1))
    per_src = {}
    for r in rows:
        per_src[r["src"]] = per_src.get(r["src"], 0) + 1
    print(f"{len(rows)} bridges from {len(exits)} exit anchors into {len(entries)} entry clips")
    for k, v in sorted(per_src.items()):
        print(f"  {k:<20} {v:4d}")
    print(f"CSV: {bdir / 'bridges.csv'}  (source folder to select: {stubs})")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"plan": plan}[cmd](*args)
