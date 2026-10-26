"""Interpolated bridges for every cut the game makes between clips that were
not filmed back to back.

    python -m bj3.bridges plan   <full_footage.mp4>   # exits, gap scores, stubs, CSVs
    python -m bj3.bridges csvs                        # rewrite the CSVs from plan.json only
    python -m bj3.bridges local  <full_footage.mp4>   # optical-flow stand-ins for every row
    python -m bj3.bridges ingest <folders/files...>   # generated bridges in; a new output replaces the old
    python -m bj3.bridges verdict <name> reject|ok [note]  # drop / restore a generated bridge
    python -m bj3.bridges review                      # bridges/review.html: watch and judge them all
    python -m bj3.bridges resolve                     # rewrite what the game plays

The game leaves the take's order only from a loop (see graph.py) and always
enters a clip at its first frame (which edl.recut_entries has placed on the
pose that best matches its sources). Per (loop, target) pair the planner
picks the exit frame in the loop that is closest to the target's entry:

* every cut gets two exits, the best in each half of the loop, so the dealer
  is never more than about one loop-length (1-3 s) from a way out — about a
  second for the 2 s decision loops a player hits from;
* a cut the take already makes seamlessly (the loop's last frame is followed
  by the target) gets one exit in the first half, so it isn't a full loop away.

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


def exits_for(window: list[int], d: np.ndarray, seamless: bool) -> list[int]:
    """The best-matching exit in each half of the loop (or, for a cut that is seamless at the
    loop's end, in the first half only). The overall best is always one of them, so adding the
    second exit never moves an exit a bridge was already generated for."""
    if len(window) < 12:
        return [] if seamless else [window[int(np.argmin(d))]]
    h = len(window) // 2
    first = window[int(np.argmin(d[:h]))]
    return [first] if seamless else [first, window[h + int(np.argmin(d[h:]))]]


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
            entry = segs[dst]["start"]
            d = G.matrix(window, [entry])[:, 0]
            crit = graph.critical(dst)
            for x in exits_for(window, d, graph.seamless(segs, src, dst)):
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
    print(f"critical (hit) rows: {sum(r['critical'] for r in rows)}; "
          f"to generate: {sum(r['class'] != 'cut' for r in rows)}")


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


def write_todo(rows: list[dict], bdir: Path = BRIDGE_DIR) -> None:
    """bridges_todo.csv: the rows still playing a stand-in, in the one-job format."""
    with open(bdir / "bridges_todo.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["first_half", "second_half", "output", "method", "duration"])
        for r in rows:
            w.writerow([f"exit/{r['exit']}.mp4", f"entry/{r['dst']}.mp4", r["output"],
                        METHOD[r["class"]], f"{r['seconds']:g}"])


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


def read_all(path: Path) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            return out
        out.append(f)


# Where things live. Both kinds of bridge are kept side by side so either can be
# played for any row, and a bad generated one can be dropped without losing it:
#
#   bridges/generated/<name>        the tool's outputs as delivered (stub + bridge + stub; not in git)
#   bridges/state.json              per row: the ingested output's provenance and quality checks
#   bridges/verdicts.json           human verdicts on generated bridges
#   game_assets/bridges/tool/<name> the generated bridge, cut out of the tool's output
#   game_assets/bridges/flow/<name> the optical-flow stand-in
#   game_assets/bridges.json        what the game plays for every row (written by resolve)
GENERATED = BRIDGE_DIR / "generated"
STATE = BRIDGE_DIR / "state.json"
VERDICTS = BRIDGE_DIR / "verdicts.json"
TOOL_DIR = "bridges/tool"
FLOW_DIR = "bridges/flow"


def plan_rows() -> list[dict]:
    return json.load(open(BRIDGE_DIR / "plan.json"))["rows"]


def _load(path: Path, empty):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else empty


def _save(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")


def sha1(path: Path) -> str:
    import hashlib

    return hashlib.sha1(path.read_bytes()).hexdigest()[:16]


def flow_frames(r: dict) -> int:
    # a generated move can't be stood in for by flow; a long flow bridge is the closest stand-in
    return int(round(min(r["seconds"], SECONDS["long"]) * FPS))


def local(video: str, work: str = "work", force: str = "") -> None:
    """Optical-flow stand-ins for every planned row that lacks one (all of them with `force`),
    so every cut has a bridge before (and whenever) a generated one is missing or rejected."""
    rows = plan_rows()
    fr = Frames(video)
    segs = {s["name"]: s for s in json.load(open(Path(work) / "edl.json"))["segments"]}
    clean = SeatCleaner(fr, segs)
    out = ASSETS / FLOW_DIR
    out.mkdir(parents=True, exist_ok=True)
    made = 0
    for r in rows:
        if flow_frames(r) and (force or not (out / r["output"]).exists()):
            a, b = clean(fr.get(r["exit_source_frame"])), clean(fr.get(r["entry_source_frame"]))
            encode(interpolate(a, b, flow_frames(r)), out / r["output"])
            made += 1
    print(f"{made} stand-ins made")
    resolve()


def _outputs(paths: list[str]) -> dict[str, Path]:
    """Tool outputs by file name, from folders (searched recursively) and single files."""
    found: dict[str, Path] = {}
    for p in map(Path, paths):
        for f in ([p] if p.is_file() else sorted(p.rglob("*.mp4"))):
            found[f.name] = f
    return found


def _reports(paths: list[str]) -> dict[str, dict]:
    """The tool's row reports (batch-report*.csv) next to its outputs, by output name."""
    rows: dict[str, dict] = {}
    for p in map(Path, paths):
        for f in ([] if p.is_file() else sorted(p.rglob("batch-report*.csv"))):
            with open(f, encoding="utf-8-sig") as fh:
                for r in csv.DictReader(fh):
                    if r.get("output"):
                        rows[Path(r["output"]).name] = r
    return rows


def cut_out(frames: list[np.ndarray], A: list[np.ndarray], B: list[np.ndarray]):
    """Locate the two stubs in a tool output; the bridge is what lies between them.

    Each stub is aligned as a whole sequence: its frames carry the dealer's own motion, so it
    fits in one place only, where single-frame matching is ambiguous (a bridge between two close
    poses looks like its ends all the way through). A tool that pads or trims around the stubs
    still yields exactly the frames between them. Returns (bridge, exit fit, entry fit); a fit
    is the mean pixel difference of the aligned stub, a few units for a re-encode."""
    # quarter-resolution grey is plenty to place an 8-frame sequence, and fast
    small = lambda f: cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), None, fx=0.25, fy=0.25,
                                 interpolation=cv2.INTER_AREA).astype(np.float32)
    F = [small(f) for f in frames]
    A = [small(f) for f in A]
    B = [small(f) for f in B]
    n = len(F)
    if n < len(A) + len(B) + 1:
        return [], 99.0, 99.0

    def fit(stub, lo, hi):
        costs = [np.mean([np.abs(F[o + k] - stub[k]).mean() for k in range(len(stub))]) for o in range(lo, hi + 1)]
        o = int(np.argmin(costs))
        return lo + o, float(costs[o])

    oa, ca = fit(A, 0, n - len(A) - len(B) - 1)
    ob, cb = fit(B, oa + len(A) + 1, n - len(B))
    return frames[oa + len(A):ob], ca, cb


def ingest(*paths: str) -> None:
    """Bring generated bridges into the game: any folders and/or files of the tool's outputs,
    named as in the CSV. An output for a row that already has one replaces it; rows not given
    are left as they are. Each output is archived in bridges/generated, cut down to its bridge,
    quality-checked (bridgeqa), and what the game plays is re-resolved."""
    import shutil

    from bj3.bridgeqa import assess

    if not paths:
        raise SystemExit("usage: python -m bj3.bridges ingest <folders and/or files>")
    rows = {r["output"]: r for r in plan_rows()}
    outputs = _outputs(list(paths))
    reports = _reports(list(paths))
    state = _load(STATE, {})
    stubs = BRIDGE_DIR / "stubs"
    (ASSETS / TOOL_DIR).mkdir(parents=True, exist_ok=True)
    GENERATED.mkdir(parents=True, exist_ok=True)
    done, bad, unknown = [], [], []
    for name, src in outputs.items():
        r = rows.get(name)
        if r is None:
            unknown.append(name)
            continue
        try:
            A = read_all(stubs / "exit" / f"{r['exit']}.mp4")
            B = read_all(stubs / "entry" / f"{r['dst']}.mp4")
            bridge, ca, cb = cut_out(read_all(src), A, B)
            if not bridge or ca > 8 or cb > 8:
                bad.append(f"{name}: stubs not found (exit {ca:.1f}, entry {cb:.1f})")
                continue
            q = assess(A, bridge, B)
            if src.resolve() != (GENERATED / name).resolve():
                shutil.copyfile(src, GENERATED / name)
            encode(bridge, ASSETS / TOOL_DIR / name)
        except Exception as e:  # one bad file (wrong size, truncated) mustn't stop the rest
            bad.append(f"{name}: {type(e).__name__}: {e}")
            continue
        rep = reports.get(name, {})
        state[name] = {
            "frames": len(bridge), "sha1": sha1(GENERATED / name),
            # the frames it joins: a re-plan that moves either makes this bridge stale
            "exit_source_frame": r["exit_source_frame"], "entry_source_frame": r["entry_source_frame"],
            "method": rep.get("method") or METHOD[r["class"]], "duration": rep.get("duration") or r["seconds"],
            "request_id": rep.get("provider_request_id") or None,
            "quality": {k: v for k, v in q.__dict__.items() if k != "flags"}, "flags": q.flags,
        }
        # saved row by row, so files on disk and their record never disagree if a run stops
        _save(STATE, dict(sorted(state.items())))
        done.append(name)
    for line in bad:
        print("  !", line)
    if unknown:
        print(f"  ({len(unknown)} files not in the plan, ignored: {', '.join(unknown[:5])}{' ...' if len(unknown) > 5 else ''})")
    flagged = [n for n in done if state[n]["flags"]]
    print(f"ingested {len(done)}; unreadable {len(bad)}; flagged by the checks {len(flagged)}")
    for n in flagged:
        print(f"  ? {n}: {', '.join(state[n]['flags'])}")
    resolve()


def verdict(name: str, value: str, *note: str) -> None:
    """Record a verdict on a generated bridge: `reject` (the game plays its stand-in instead)
    or `ok`. The verdict holds for this exact output; ingesting a new one for the row clears it."""
    if value not in ("ok", "reject"):
        raise SystemExit("verdict is ok or reject")
    state = _load(STATE, {})
    if name not in state:
        raise SystemExit(f"{name}: no generated bridge ingested for this row")
    v = _load(VERDICTS, {})
    import datetime

    v[name] = {"verdict": value, "note": " ".join(note), "sha1": state[name]["sha1"],
               "t": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    _save(VERDICTS, dict(sorted(v.items())))
    resolve()


def resolve() -> None:
    """Decide what the game plays for every planned row and write game_assets/bridges.json:
    the generated bridge unless it is missing, rejected or stale, else the optical-flow stand-in.
    A rejected exit whose transition has another exit playing a good generated bridge is left
    out instead: waiting a little longer for that one beats a stand-in."""
    rows = plan_rows()
    state = _load(STATE, {})
    verdicts = _load(VERDICTS, {})
    stale = [n for n, v in verdicts.items() if n in state and v.get("sha1") != state[n]["sha1"]]
    for n in stale:
        print(f"  verdict on {n} was for a previous output; cleared")
        del verdicts[n]
    if stale:
        _save(VERDICTS, dict(sorted(verdicts.items())))
    out = []
    counts = {"tool": 0, "flow": 0, "cut": 0, "rejected": 0}
    for r in rows:
        name = r["output"]
        entry = {"name": name, "from": r["src"], "at": r["frame"], "to": r["dst"],
                 "class": r["class"], "critical": r["critical"]}
        tool = state.get(name)
        rejected = verdicts.get(name, {}).get("verdict") == "reject"
        if tool and (tool.get("exit_source_frame"), tool.get("entry_source_frame")) != (
                r["exit_source_frame"], r["entry_source_frame"]):
            print(f"  {name}: generated for frames the plan has since moved; playing its stand-in")
            tool = None
        if tool and not rejected and (ASSETS / TOOL_DIR / name).exists():
            entry.update(file=f"{TOOL_DIR}/{name}", frames=tool["frames"], source="tool")
        elif not flow_frames(r):
            entry.update(file=None, frames=0, source="flow")
        else:
            entry.update(file=f"{FLOW_DIR}/{name}", frames=flow_frames(r), source="flow")
        if rejected:
            entry["rejected"] = verdicts[name].get("note") or True
            counts["rejected"] += 1
        counts["cut" if entry["frames"] == 0 else entry["source"]] += 1
        out.append(entry)
    good = {(e["from"], e["to"]) for e in out if e["source"] == "tool"}
    dropped = [e for e in out if e.get("rejected") and (e["from"], e["to"]) in good]
    if dropped:
        out = [e for e in out if e not in dropped]
        counts["flow"] -= len(dropped)
        print(f"  {len(dropped)} rejected exit(s) left out; their transitions use another exit's generated bridge")
    missing = [e["file"] for e in out if e["file"] and not (ASSETS / e["file"]).exists()]
    if missing:
        raise SystemExit(f"{len(missing)} bridge files missing, e.g. {missing[0]} (run `bridges local` first)")
    _save(registry_path(), {"fps": FPS, "bridges": out})
    # what is still to generate (never generated, rejected, or stale), ready to run as one job
    todo = {e["name"] for e in out if e["source"] != "tool" and e["file"]} | {e["name"] for e in dropped}
    write_todo([r for r in rows if r["output"] in todo])
    print(f"bridges.json: {counts['tool']} generated, {counts['flow']} stand-ins, {counts['cut']} matched cuts "
          f"({counts['rejected']} rejected, {len(dropped)} of them left out)")


def registry_path() -> Path:
    return ASSETS / "bridges.json"


def review() -> None:
    from bj3.review_page import build

    build()


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"plan": plan, "csvs": csvs, "local": local, "ingest": ingest, "verdict": verdict,
     "resolve": resolve, "review": review}[cmd](*args)
