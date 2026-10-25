"""Interpolated bridges for every cut the game makes between clips that were
not filmed back to back.

    python -m bj3.bridges plan   <full_footage.mp4>   # exits, gap scores, stubs, CSVs
    python -m bj3.bridges csvs                        # rewrite the CSVs from plan.json only
    python -m bj3.bridges local  <full_footage.mp4>   # stand-in bridges by optical flow, into game_assets
    python -m bj3.bridges ingest <tool output dir>    # the interpolation tool's bridges, into game_assets

The game leaves the take's order only from a loop (see graph.py) and always
enters a clip at its first frame (which edl.recut_entries has placed on the
pose that best matches its sources). Per (loop, target) pair the planner
picks the exit frame in the loop that is closest to the target's entry:

* a cut a player waits on (a hit) gets two exits, the best in each half of
  the loop, so the dealer is never more than about a second from one;
* any other cut gets the single best exit (the loop comes round to it).

Each exit is scored by optical flow (how far the dealer moves, and what
warping can't explain) into a class that sets the method and length:
cut (no bridge), short / long flow bridge (FILM, RIFE), or generative
(Kling / Seedance) where the poses differ too much for flow — only where a
long bridge doesn't hold a player up.

Rows go out in the tool's three-column CSV, all together and split by
suggested method, plus a full CSV with the planning columns.
"""

import csv
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3 import graph
from bj3.export import FFMPEG, RATE, X264
from bj3.gaps import FlowGap, Gaps
from bj3.video import Frames

STUB = 8  # frames per stub: enough context, small uploads
HERE = Path(__file__).resolve().parents[1]
BRIDGE_DIR = HERE.parent / "bridges"
ASSETS = HERE.parent / "game_assets"
FPS = 24000 / 1001

# Flow classes: (max motion px, max % unexplained) -> class; see gaps.FlowGap for the calibration.
CLASSES = [
    ("cut", 2.0, 0.1),
    ("short", 12.0, 1.0),
    ("long", 40.0, 3.0),
]
# seconds of bridge per class; a generative bridge is as long as the models allow
SECONDS = {"cut": 0.0, "short": 0.33, "long": 0.67, "generative": 3.0}
# method ids as the interpolation app names them (its src/models.js)
METHOD = {"cut": "none", "short": "film", "long": "film", "generative": "kling-fal"}
# the longest a bridge may be where a player is waiting on it
CRITICAL_MAX_S = 0.75


def classify(motion: float, resid: float) -> str:
    for name, m, r in CLASSES:
        if motion <= m and resid <= r:
            return name
    return "generative"


def exits_for(window: list[int], d: np.ndarray, critical: bool) -> list[int]:
    if not critical or len(window) < 12:
        return [window[int(np.argmin(d))]]
    h = len(window) // 2
    return [window[int(np.argmin(d[:h]))], window[h + int(np.argmin(d[h:]))]]


def _smooth(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


class SeatCleaner:
    """Takes the cards off the players' seats in a frame, leaving bare felt.

    A bridge is generated between frames of two different clips whose seats hold different
    cards (part 1's two-card hands, part 2's six-card stacks). Interpolated, those cards
    morph and drift — anywhere, not only where a plate can cover them. So bridges are made
    from frames with the seats cleared to an empty table, and during a bridge the game lays
    a plate of each seat's real hand over every seat. Keyed exactly as the app's compositor
    keys plates (felt or card stock is replaced, anything else — her arm — stays).
    """

    def __init__(self, fr: Frames, segs: dict):
        idle = segs["full_table_idle"]
        a, b = idle.get("loop_in", idle["start"]), idle.get("loop_out", idle["end"])
        self.empty = np.median(np.stack([fr.get(f) for f in range(a, b, max(1, (b - a) // 7))]), axis=0).astype(np.uint8)
        m = cv2.imread(str(ASSETS / "masks" / "seats.png")).astype(np.float32) / 255
        self.mask = cv2.dilate(m.max(axis=2), np.ones((15, 15), np.uint8))[..., None]

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        f = frame.astype(np.float32) / 255
        b_, g_, r_ = f[..., 0], f[..., 1], f[..., 2]
        felt = _smooth(0.03, 0.12, b_ - np.maximum(r_, g_))
        card = _smooth(0.55, 0.70, f.min(axis=2)) * (1 - _smooth(0.02, 0.06, r_ - b_))
        key = cv2.dilate(np.maximum(felt, card), np.ones((3, 3), np.uint8))[..., None]
        w = self.mask * key
        return (frame * (1 - w) + self.empty * w).round().astype(np.uint8)


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
    G = Gaps(str(work_p / "pose.npz"))
    flow = FlowGap()
    fr = Frames(video)

    rows = []
    for src, targets in sorted(graph.transitions(segs).items()):
        a, b = graph.loop_window(segs[src])
        window = list(range(a, b))
        for dst in sorted(targets):
            if graph.seamless(segs, src, dst):
                continue
            entry = segs[dst]["start"]
            d = G.matrix(window, [entry])[:, 0]
            crit = graph.critical(dst)
            for x in exits_for(window, d, crit):
                motion, resid = flow(fr.get(x), fr.get(entry))
                cls = classify(motion, resid)
                if crit and cls == "generative":
                    cls = "long"  # a player is waiting: the longest flow bridge we can afford, flagged
                seconds = min(SECONDS[cls], CRITICAL_MAX_S) if crit else SECONDS[cls]
                exit_id = f"{src}@{x - segs[src]['start']:04d}"
                rows.append({
                    "src": src, "frame": x - segs[src]["start"], "dst": dst, "exit": exit_id,
                    "output": f"{exit_id}__{dst}.mp4", "critical": crit,
                    "max_seconds": CRITICAL_MAX_S if crit else 4.0,
                    "class": cls, "method": METHOD[cls], "seconds": seconds,
                    "flow_px": round(motion, 1), "unexplained_pct": round(resid, 2), "pose_gap": round(float(d[x - a]), 2),
                    "exit_source_frame": x, "entry_source_frame": entry,
                })

    # stubs: the frames running into the exit, and the target's first frames
    stubs = bdir / "stubs"
    for sub in ("exit", "entry"):
        for f in (stubs / sub).glob("*.mp4"):
            f.unlink()
    clean = SeatCleaner(fr, segs)
    for exit_id in sorted({r["exit"] for r in rows}):
        r = next(r for r in rows if r["exit"] == exit_id)
        x = r["exit_source_frame"]
        write_stub([clean(fr.get(i)) for i in range(x - STUB + 1, x + 1)], stubs / "exit" / f"{exit_id}.mp4")
    for dst in sorted({r["dst"] for r in rows}):
        s = segs[dst]["start"]
        write_stub([clean(fr.get(i)) for i in range(s, s + STUB)], stubs / "entry" / f"{dst}.mp4")

    write_csvs(rows, bdir)
    (bdir / "plan.json").write_text(json.dumps({"stub": STUB, "fps": FPS, "rows": rows}, indent=1))
    for old in ("plan.prev.json",):
        (bdir / old).unlink(missing_ok=True)
    count = {c: sum(r["class"] == c for r in rows) for c in ("cut", "short", "long", "generative")}
    print(f"{len(rows)} exits over {len({(r['src'], r['dst']) for r in rows})} loop->clip pairs: {count}")
    print(f"critical (hit) rows: {sum(r['critical'] for r in rows)}; to generate: {len(gen)}")


def write_csvs(rows: list[dict], bdir: Path = BRIDGE_DIR) -> None:
    """The interpolation app's batch CSVs.

    * bridges.csv and bridges_{short,long,generative}.csv: the plain three columns, one
      method and length per batch;
    * bridges_onejob.csv: adds the optional per-row `method` and `duration` columns, so
      every row runs in one job with its own method and length;
    * bridges_full.csv: the same plus the planning columns, for reading.
    """
    gen = [r for r in rows if r["class"] != "cut"]
    bdir.mkdir(parents=True, exist_ok=True)
    halves = lambda r: [f"exit/{r['exit']}.mp4", f"entry/{r['dst']}.mp4", r["output"]]

    def write(path: Path, header: list[str], rs, extra=lambda r: []):
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(header)
            for r in rs:
                w.writerow(halves(r) + extra(r))

    base = ["first_half", "second_half", "output"]
    write(bdir / "bridges.csv", base, gen)
    for cls in ("short", "long", "generative"):
        write(bdir / f"bridges_{cls}.csv", base, [r for r in gen if r["class"] == cls])
    write(bdir / "bridges_onejob.csv", base + ["method", "duration"], gen,
          lambda r: [METHOD[r["class"]], f"{r['seconds']:g}"])
    write(bdir / "bridges_full.csv",
          base + ["method", "duration", "max_seconds", "critical", "class", "flow_px", "unexplained_pct", "src", "dst"],
          rows, lambda r: [METHOD[r["class"]], f"{r['seconds']:g}", r["max_seconds"], int(r["critical"]), r["class"],
                           r["flow_px"], r["unexplained_pct"], r["src"], r["dst"]])


def csvs() -> None:
    """Rewrite the CSVs from plan.json, without re-planning or re-writing stubs."""
    rows = json.load(open(BRIDGE_DIR / "plan.json"))["rows"]
    for r in rows:
        r["method"] = METHOD[r["class"]]
    write_csvs(rows)
    print(f"CSVs rewritten for {len(rows)} rows")


# ---------------------------------------------------------------- bridges into the game


def interpolate(a: np.ndarray, b: np.ndarray, n: int) -> list[np.ndarray]:
    """n in-between frames by bidirectional optical flow — a stand-in until the tool's bridges arrive."""
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)  # full-resolution detail: fingers and card edges
    dis.setGradientDescentIterations(25)
    fab = dis.calc(ga, gb, None)
    fba = dis.calc(gb, ga, None)
    h, w = ga.shape
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    out = []
    for i in range(1, n + 1):
        t = i / (n + 1)
        # sample each end where the pixel now at x came from / is going to
        wa = cv2.remap(a, gx - t * fab[..., 0], gy - t * fab[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        wb = cv2.remap(b, gx - (1 - t) * fba[..., 0], gy - (1 - t) * fba[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        e = t * t * (3 - 2 * t)
        out.append(cv2.addWeighted(wa, 1 - e, wb, e, 0))
    return out


def encode(frames: list[np.ndarray], path: Path) -> None:
    write_stub(frames, path)


def registry_path() -> Path:
    return ASSETS / "bridges.json"


def load_registry() -> dict:
    p = registry_path()
    return json.loads(p.read_text()) if p.exists() else {"fps": FPS, "bridges": []}


def save_registry(reg: dict, rows: list[dict]) -> None:
    order = {r["output"]: i for i, r in enumerate(rows)}
    reg["bridges"].sort(key=lambda b: order.get(b["name"], 1 << 30))
    registry_path().write_text(json.dumps(reg, indent=1))


def put(reg: dict, row: dict, frames: int, source: str) -> None:
    reg["bridges"] = [b for b in reg["bridges"] if b["name"] != row["output"]]
    reg["bridges"].append({
        "name": row["output"], "from": row["src"], "at": row["frame"], "to": row["dst"],
        "file": f"bridges/{row['output']}" if frames else None, "frames": frames,
        "class": row["class"], "critical": row["critical"], "source": source,
    })


def local(video: str, work: str = "work") -> None:
    """Stand-in bridges for every planned row, so the game plays bridges before the tool's arrive.
    A row already filled from the tool is left alone."""
    rows = json.load(open(BRIDGE_DIR / "plan.json"))["rows"]
    reg = load_registry()
    have_tool = {b["name"] for b in reg["bridges"] if b["source"] == "tool"}
    fr = Frames(video)
    segs = {s["name"]: s for s in json.load(open(Path(work) / "edl.json"))["segments"]}
    clean = SeatCleaner(fr, segs)
    out = ASSETS / "bridges"
    out.mkdir(parents=True, exist_ok=True)
    for r in rows:
        if r["output"] in have_tool:
            continue
        # a generated move can't be stood in for by flow; a long flow bridge is the closest stand-in
        seconds = min(r["seconds"], SECONDS["long"])
        n = int(round(seconds * FPS))
        if n:
            frames = interpolate(clean(fr.get(r["exit_source_frame"])), clean(fr.get(r["entry_source_frame"])), n)
            encode(frames, out / r["output"])
        put(reg, r, n, "local")
    save_registry(reg, rows)
    print(f"{len(rows)} bridges registered ({sum(1 for b in reg['bridges'] if b['source'] == 'local')} stand-ins)")


def read_all(path: Path) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            return out
        out.append(f)


def ingest(tool_dir: str, video: str | None = None) -> None:
    """The tool's outputs (exit stub + bridge + entry stub) -> just the bridge, into the game.

    The bridge is found by locating the two known stubs in the output, not by counting, so a
    tool that pads or trims around them still yields exactly the frames between them."""
    rows = json.load(open(BRIDGE_DIR / "plan.json"))["rows"]
    reg = load_registry()
    out = ASSETS / "bridges"
    out.mkdir(parents=True, exist_ok=True)
    stubs = BRIDGE_DIR / "stubs"
    done = missing = bad = 0
    for r in rows:
        if r["class"] == "cut":
            put(reg, r, 0, "tool")
            continue
        src = Path(tool_dir) / r["output"]
        if not src.exists():
            hits = list(Path(tool_dir).rglob(r["output"]))
            src = hits[0] if hits else src
        if not src.exists():
            missing += 1
            continue
        frames = [f.astype(np.float32) for f in read_all(src)]
        A = [f.astype(np.float32) for f in read_all(stubs / "exit" / f"{r['exit']}.mp4")]
        Bs = [f.astype(np.float32) for f in read_all(stubs / "entry" / f"{r['dst']}.mp4")]
        # Align each stub as a whole sequence (its frames carry the dealer's own motion, so it
        # fits in one place only); the bridge is what lies between them. Single-frame matching
        # is ambiguous: a bridge between two close poses looks like its ends all the way through.
        n = len(frames)

        def fit(stub, lo, hi):
            costs = [np.mean([np.abs(frames[o + k] - stub[k]).mean() for k in range(len(stub))])
                     for o in range(lo, hi + 1)]
            o = int(np.argmin(costs))
            return lo + o, costs[o]

        oa, ca = fit(A, 0, max(0, n - len(A) - len(Bs)))
        ob, cb = fit(Bs, oa + len(A), n - len(Bs))
        bridge = [f.round().astype(np.uint8) for f in frames[oa + len(A):ob]]
        if not bridge or ca > 8 or cb > 8:
            print(f"  ! {r['output']}: stubs not found (exit {ca:.1f}, entry {cb:.1f}, {len(bridge)} frames between)")
            bad += 1
            continue
        encode(bridge, out / r["output"])
        put(reg, r, len(bridge), "tool")
        done += 1
    save_registry(reg, rows)
    print(f"ingested {done}; missing {missing}; unreadable {bad}")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"plan": plan, "csvs": csvs, "local": local, "ingest": ingest}[cmd](*args)
