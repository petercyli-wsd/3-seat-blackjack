"""Run the whole footage pipeline: python -m bj3 <full_footage.mp4> [--out ../game_assets] [--force]

Passes (each cached in work/ and skipped when its output exists, unless --force):
  1. signals   per-frame card / motion signals over table regions
  2. pose      per-frame fingerprint of the dealer's arms and the discard tray
  3. tracker   every physical card: outline, land / flip / pickup frames
  4. edl       the take cut into named segments
  5. review    contact sheets of every cut (work/review/)
  6. export    trimmed clips + ping-pong loops into game_assets/
  7. manifest  manifest.json, seat masks and CLIPS.md
"""

import argparse
import time
from pathlib import Path

from bj3 import edl, export, manifest, pose, review, signals, tracker


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m bj3")
    ap.add_argument("video")
    ap.add_argument("--out", default="../game_assets")
    ap.add_argument("--work", default="work")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    work = Path(a.work)
    work.mkdir(exist_ok=True)
    out = Path(a.out)

    def step(name, target: Path, fn):
        if target.exists() and not a.force:
            print(f"[skip] {name} ({target} exists)")
            return
        t = time.time()
        print(f"[run ] {name}")
        fn()
        print(f"[done] {name} in {time.time() - t:.0f}s")

    step("signals", work / "signals.npz", lambda: signals.run(a.video, work / "signals.npz"))
    step("pose", work / "pose.npz", lambda: pose.run(a.video, str(work / "pose.npz")))
    step("tracker", work / "cards.json", lambda: tracker.track(a.video, str(work / "signals.npz"), str(work / "cards.json")))
    step("edl", work / "edl.json", lambda: edl.build(str(work / "cards.json"), str(work / "signals.npz"), str(work / "edl.json"), str(work / "pose.npz")))
    step("review", work / "review" / "edl_00.jpg", lambda: review.main(a.video, str(work / "edl.json"), str(work / "review")))
    step("export", out / "clips", lambda: export.run(a.video, str(work / "edl.json"), str(out)))
    step("manifest", out / "manifest.json", lambda: manifest.build(str(work / "cards.json"), str(work / "edl.json"), str(work / "pose.npz"), str(out)))


if __name__ == "__main__":
    main()
