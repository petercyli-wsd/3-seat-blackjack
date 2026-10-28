"""Bridges for the no-discard ending: from each take's hold loop straight back to its betting loop.

    python -m bj3.bridges_nodiscard plan  <full_footage.mp4>   # exits, classes, stubs, CSV, plan_nodiscard.json
    python -m bj3.bridges_nodiscard local <full_footage.mp4> [force]  # flow stand-ins, then resolve

In the no-discard ending (the app's Director.clearWithoutDiscard) the dealer rests in the hold
loop `<mask>_hold` while the game clears the table, then the footage goes back to the betting loop
`<mask>_idle` of the same take. In the take the discard lies between the two, so they need a
bridge, one per mask (7). These rows are planned here, on their own, and kept in their own plan
(bridges/plan_nodiscard.json) so the main plan's 280 rows, stubs and CSVs are never touched;
`bridges.py` reads both plans for everything after planning (ingest, verdict, review, resolve),
so a generated version goes in with the usual `python -m bj3.bridges ingest`.

Same conventions as the main plan (bridges.py), with two differences:

* **The landing.** The game cuts to the idle as a loop (`cutTo(idle, {loop: true})`), and a loop
  file starts on the first frame of its window (`loopFrom`, the idle's calm stretch), not on the
  clip's first frame. A bridge hands over to whatever the target deck plays first, so these
  bridges land on the window's first frame: no change to the game, and no jump into the window.
* **The dealer's cards.** The hold has her two cards on the table, the idle has none, and in this
  ending the game erases them before the cut. Stubs with the cards on one side only would make the
  interpolator morph them away, and card handling must never be generated. So the stubs have the
  dealer's card area cleared to bare felt too (DealerCleaner), on top of the seats (SeatCleaner).

Exits: the best pose match for the landing in each half of the hold loop (two per transition).
Classes from FlowGap, measured on the cleaned frames that are actually bridged. Stubs: 8 frames,
under bridges/stubs/nodiscard/ so their names can't collide with the main plan's (whose `plan`
clears bridges/stubs/exit and /entry, not this folder).
"""

import csv
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from bj3 import graph
from bj3.bridges import (ASSETS, BRIDGE_DIR, FLOW_DIR, FPS, METHOD, SECONDS, STUB, _smooth, classify,
                         encode, exits_for, flow_frames, interpolate, resolve, write_stub)
from bj3.gaps import FlowGap, Gaps
from bj3.video import Frames

SET = "nodiscard"
PLAN = BRIDGE_DIR / "plan_nodiscard.json"
CSV = BRIDGE_DIR / "bridges_nodiscard.csv"
STUB_DIR = "nodiscard"  # under bridges/stubs/
MAX_SECONDS = 4.0  # nobody is waiting on these: the table is being cleared


def holds(segs: dict) -> list[str]:
    """The hold loop of each part-1 take: where the no-discard ending leaves from."""
    return [f"{m}_hold" for m in graph.masks(segs)]


def calm(seg: dict) -> bool:
    """An idle whose loop is a calm stretch of it (a window), not the whole clip from the end of
    the discard, mid-reach (010, 011; 010's window is set but spans the whole clip)."""
    return seg.get("loop_in", seg["start"]) > seg["start"]


def candidates(segs: dict, src: str) -> list[str]:
    """The betting loops a hold may go back to: its take's own idle if that has a calm window;
    else any other betting idle that has one. Every betting idle has idle -> deal bridges for every
    mask, and the game returns to whichever idle the hold's bridges lead to (the app's
    Director.bettingAfterHold)."""
    own = src.replace("_hold", "_idle")
    if calm(segs[own]):
        return [own]
    betting = [n for n in graph.transitions(segs) if segs[n]["kind"] == "idle"]
    return [n for n in betting if n != own and calm(segs[n])]


def landing(seg: dict) -> int:
    """Source frame a loop file starts on: its window's first frame."""
    return graph.loop_window(seg)[0]


def ping_pong(i: int, a: int, b: int) -> int:
    """The source frame a ping-pong loop over [a, b) shows `i` frames from its window: frames
    before the window are its first frames played back (as the game shows them), not the take's."""
    n = b - a
    period = 2 * n - 2
    k = (i - a) % period
    return a + (k if k < n else period - k)


def _hand(n: np.ndarray) -> np.ndarray:
    """Her hands and sleeves in a frame (BGR, 0..1): skin (red well over blue; the cards are bluish
    white, red 0.07 under blue, skin 0.16 over) or dark (sleeve, the seats' metal card stands)."""
    return np.maximum(_smooth(0.04, 0.10, n[..., 2] - n[..., 0]), 1 - _smooth(0.12, 0.25, n.max(axis=2)))


def _felt(n: np.ndarray) -> np.ndarray:
    return n[..., 0] - np.maximum(n[..., 1], n[..., 2]) > 0.10


def _skin(n: np.ndarray) -> np.ndarray:
    return _smooth(0.04, 0.10, n[..., 2] - n[..., 0]) > 0.2


class Patch:
    """One patch of the table taken back to bare felt in any frame, keeping her hands.

    `mask` (feathered, 0..1) is where. The still that replaces it is the bare table there: the
    median of the frames of the idle the bridge lands in where her hands are nowhere near the
    patch (nor their shadows, which no colour key can tell from felt). An idle she reaches over
    for most of its length (010, 011) has too few; then the next idle with enough is used. The
    camera's exposure drifts over the take (the 111 hold is ~9 % brighter than its idle), so in
    each frame the still is gained to the felt in a ring around the patch: no visible patch at
    either end of a bridge. Anything skin-toned or dark stays as filmed (with a pixel of margin);
    felt, card stock and the cards' grey edges and shadows are replaced."""

    RING = 14
    MIN_CLEAN = 5  # hand-free frames a still is the median of

    def __init__(self, mask: np.ndarray, sources: list):
        h, w = mask.shape
        x, y, bw, bh = cv2.boundingRect((mask > 0.002).astype(np.uint8))
        g = self.RING + 4
        self.box = x0, y0, x1, y1 = max(0, x - g), max(0, y - g), min(w, x + bw + g), min(h, y + bh + g)
        self.mask = mask[y0:y1, x0:x1, None]
        core = (self.mask[..., 0] > 0.002).astype(np.uint8)
        ring = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * self.RING + 1,) * 2))
        self.ring = (ring > 0) & (core == 0)
        # a hand on the patch, or within 10 px of it (its shadow falls a little way off)
        near = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))) > 0
        self.source = None
        for name, frames in sources:  # frames: callables, read only when needed
            crops = [f[y0:y1, x0:x1] for f in frames()]
            clean = [c for c in crops if not (_skin(c.astype(np.float32) / 255) & near).any()]
            if len(clean) >= self.MIN_CLEAN:
                self.plate = np.median(np.stack(clean).astype(np.float32), axis=0)
                self.source = name
                return
        raise ValueError(f"no idle shows the table bare at {self.box}")

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        x0, y0, x1, y1 = self.box
        f = frame[y0:y1, x0:x1].astype(np.float32)
        n = f / 255
        hand = cv2.dilate(_hand(n), np.ones((3, 3), np.uint8))
        ring = self.ring & (hand < 0.05) & _felt(n) & _felt(self.plate / 255)
        gain = np.clip(np.median(f[ring], 0) / np.maximum(np.median(self.plate[ring], 0), 1), 0.8, 1.25) \
            if ring.sum() > 50 else np.ones(3, np.float32)
        wgt = self.mask * (1 - hand)[..., None]
        out = frame.copy()
        out[y0:y1, x0:x1] = (f * (1 - wgt) + self.plate * gain * wgt).round().clip(0, 255).astype(np.uint8)
        return out


def dealer_mask(clip_hold: dict, dealer: dict, shape: tuple[int, int], grow: int = 9, feather: float = 3.5) -> np.ndarray:
    """Everywhere the hold has her up and hole cards (the manifest's quads, and where they were
    nudged to), grown over their edges and shadow, feathered."""
    quads = [dealer["up"], dealer["hole"]]
    for c in clip_hold["cards"]:
        if c["slot"] in ("up", "hole"):
            quads += [c["quad"], *[r["quad"] for r in c.get("rests", [])]]
    m = np.zeros(shape, np.uint8)
    for q in quads:
        cv2.fillPoly(m, [np.round(np.asarray(q)).astype(np.int32)], 255)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1,) * 2))
    return cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), feather)


def seat_masks(shape: tuple[int, int]) -> list[np.ndarray]:
    """The seats as SeatCleaner covers them (seats.png grown 7 px), one feathered mask per seat."""
    m = cv2.imread(str(ASSETS / "masks" / "seats.png")).max(axis=2)
    m = cv2.resize(m, shape[::-1], interpolation=cv2.INTER_NEAREST) if m.shape != shape else m
    m = cv2.dilate((m > 127).astype(np.uint8), np.ones((15, 15), np.uint8))
    n, lab = cv2.connectedComponents(m)
    return [cv2.GaussianBlur((lab == i).astype(np.float32), (0, 0), 2.0) for i in range(1, n)]


class Cleaner:
    """A frame of one hold -> idle transition with the seats and the dealer's cards taken back to
    bare felt, from stills of the idle it lands in."""

    def __init__(self, patches: list[Patch]):
        self.patches = patches

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        for p in self.patches:
            frame = p(frame)
        return frame




def _manifest() -> dict:
    return json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))


class Cleaners:
    """The Cleaner for each (hold, idle it lands in): the stills come from that idle first, then
    from the takes nearest it in time (closest in light)."""

    def __init__(self, fr: Frames, segs: dict):
        self.fr, self.segs, self.m = fr, segs, _manifest()
        self.shape = (self.m["height"], self.m["width"])
        self.seats = seat_masks(self.shape)
        self.idles = [n for n, s in segs.items() if s["kind"] == "idle" and n != "opening_idle"]
        self.frames: dict[str, list[np.ndarray]] = {}
        self.made: dict[tuple[str, str], Cleaner] = {}

    def _source(self, name: str):
        def get():
            if name not in self.frames:  # the whole clip, ~40 frames of it
                s, e = self.segs[name]["start"], self.segs[name]["end"]
                self.frames[name] = [self.fr.get(f).copy() for f in range(s, e, max(1, (e - s) // 40))]
            return self.frames[name]
        return name, get

    def __call__(self, src: str, dst: str) -> Cleaner:
        if (src, dst) not in self.made:
            start = self.segs[dst]["start"]
            others = sorted((n for n in self.idles if n != dst), key=lambda n: abs(self.segs[n]["start"] - start))
            sources = [self._source(dst), *map(self._source, others)]
            patches = [Patch(mk, sources) for mk in self.seats] + [
                Patch(dealer_mask(self.m["clips"][src], self.m["dealer"], self.shape), sources)]
            used = sorted({p.source for p in patches} - {dst})
            if used:
                print(f"  {src} -> {dst}: bare table partly from {', '.join(used)} ({dst} has her hands over it)")
            self.made[src, dst] = Cleaner(patches)
        return self.made[src, dst]


def stub_names(r: dict) -> tuple[str, str]:
    """The two halves' paths under bridges/stubs/ (the CSV's first_half and second_half). An entry
    stub into another take's idle names the hold too: it is cleaned for that hold's cards, and must
    not overwrite the stub of the idle's own hold."""
    own = r["src"].replace("_hold", "_idle") == r["dst"]
    entry = f"{r['dst']}@{r['land']:04d}" + ("" if own else f"_for_{r['src']}")
    return f"{STUB_DIR}/exit/{r['exit']}.mp4", f"{STUB_DIR}/entry/{entry}.mp4"


class Planner:
    def __init__(self, video: str, work: str):
        self.segs = {s["name"]: s for s in json.load(open(Path(work) / "edl.json"))["segments"]}
        self.G = Gaps(str(Path(work) / "pose.npz"))
        self.flow = FlowGap()
        self.fr = Frames(video)
        self.clean = Cleaners(self.fr, self.segs)

    def rows(self, src: str, dst: str) -> list[dict]:
        """Two exits from `src`'s hold loop (the best pose match in each half) into `dst`'s loop."""
        segs, fr = self.segs, self.fr
        a, b = graph.loop_window(segs[src])
        window = list(range(a, b))
        entry = landing(segs[dst])
        d = self.G.matrix(window, [entry])[:, 0]
        c = self.clean(src, dst)
        e = c(fr.get(entry))
        out = []
        for x in exits_for(window, d, seamless=False):
            motion, resid = self.flow(c(fr.get(x)), e)
            cls = classify(motion, resid)
            exit_id = f"{src}@{x - segs[src]['start']:04d}"
            r = {
                "set": SET, "src": src, "frame": x - segs[src]["start"], "dst": dst,
                "land": entry - segs[dst]["start"], "exit": exit_id,
                "output": f"{exit_id}__{dst}.mp4", "critical": False, "max_seconds": MAX_SECONDS,
                "class": cls, "method": METHOD[cls], "seconds": SECONDS[cls],
                "flow_px": round(motion, 1), "unexplained_pct": round(resid, 2), "pose_gap": round(float(d[x - a]), 2),
                "exit_source_frame": x, "entry_source_frame": entry,
            }
            r["exit_stub"], r["entry_stub"] = stub_names(r)
            out.append(r)
        return out

    def hold(self, src: str) -> list[dict]:
        """The hold's rows into its betting loop. With a choice of loops (its own idle has no calm
        window), the one with the best pose match whose bridges all stay flow (short / long)."""
        options = {dst: self.rows(src, dst) for dst in candidates(self.segs, src)}
        if len(options) == 1:
            return next(iter(options.values()))
        score = lambda rs: float(np.mean([r["pose_gap"] for r in rs]))
        print(f"  {src}: choosing its betting loop")
        for dst, rs in sorted(options.items(), key=lambda kv: score(kv[1])):
            print(f"    {dst:14s} pose gap {score(rs):5.2f}  " + "  ".join(
                f"@{r['frame']:02d} {r['class']} {r['flow_px']} px / {r['unexplained_pct']} %" for r in rs))
        flowable = {k: v for k, v in options.items() if all(r["class"] != "generative" for r in v)}
        pool = flowable or options
        best = min(pool, key=lambda k: score(pool[k]) if flowable else max(r["flow_px"] for r in pool[k]))
        print(f"    -> {best}")
        return options[best]

    def stubs(self, rows: list[dict]) -> None:
        """The 8 frames the hold loop shows running into the exit, and the idle loop's first 8."""
        stubs, fr, segs = BRIDGE_DIR / "stubs", self.fr, self.segs
        for r in rows:
            c = self.clean(r["src"], r["dst"])
            a, b = graph.loop_window(segs[r["src"]])
            x = r["exit_source_frame"]
            write_stub([c(fr.get(ping_pong(i, a, b))) for i in range(x - STUB + 1, x + 1)], stubs / r["exit_stub"])
            a, b = graph.loop_window(segs[r["dst"]])
            s = r["entry_source_frame"]
            write_stub([c(fr.get(ping_pong(i, a, b))) for i in range(s, s + STUB)], stubs / r["entry_stub"])


def _report(rows: list[dict]) -> None:
    for r in rows:
        print(f"  {r['output']:36s} {r['class']:10s} flow {r['flow_px']:5.1f} px  unexplained {r['unexplained_pct']:5.2f} %"
              f"  lands on {r['dst']} frame {r['land']}")
    count = {c: sum(r["class"] == c for r in rows) for c in ("cut", "short", "long", "generative")}
    print(f"{len(rows)} exits over {len({r['src'] for r in rows})} holds: {count}")


def _save_plan(rows: list[dict]) -> None:
    write_csv(rows)
    PLAN.write_text(json.dumps({"set": SET, "stub": STUB, "fps": FPS, "rows": rows}, indent=1) + "\n", encoding="utf-8")


def plan(video: str, work: str = "work") -> None:
    """Plan every hold afresh: rows, stubs (this set's folder cleared first), CSV, plan."""
    P = Planner(video, work)
    rows = [r for src in holds(P.segs) for r in P.hold(src)]
    for sub in ("exit", "entry"):
        for f in (BRIDGE_DIR / "stubs" / STUB_DIR / sub).glob("*.mp4"):
            f.unlink()
    P.stubs(rows)
    _save_plan(rows)
    _report(rows)


def replan(video: str, *srcs: str, work: str = "work") -> None:
    """Plan only the given holds again (e.g. `010_hold 011_hold`); every other row, its stubs and
    its stand-in are left exactly as they are. The holds' old stubs and stand-ins are removed;
    run `local` next for the new stand-ins."""
    if not srcs:
        raise SystemExit("usage: python -m bj3.bridges_nodiscard replan <video> <hold> [<hold> ...]")
    old = json.loads(PLAN.read_text(encoding="utf-8"))["rows"]
    P = Planner(video, work)
    unknown = set(srcs) - set(holds(P.segs))
    if unknown:
        raise SystemExit(f"not a hold: {', '.join(sorted(unknown))}")
    new = {src: P.hold(src) for src in srcs}
    rows, done = [], set()
    for r in old:  # in place, in the plan's order
        if r["src"] not in new:
            rows.append(r)
        elif r["src"] not in done:
            rows += new[r["src"]]
            done.add(r["src"])
    rows += [r for src in srcs if src not in done for r in new[src]]
    keep = {p for r in rows if r["src"] not in new for p in (r["exit_stub"], r["entry_stub"])}
    outputs = {x["output"] for x in rows}
    for r in old:
        if r["src"] in new:
            for p in (r["exit_stub"], r["entry_stub"]):
                if p not in keep:
                    (BRIDGE_DIR / "stubs" / p).unlink(missing_ok=True)
            if r["output"] not in outputs:
                (ASSETS / FLOW_DIR / r["output"]).unlink(missing_ok=True)
    P.stubs([r for src in srcs for r in new[src]])
    _save_plan(rows)
    _report([r for src in srcs for r in new[src]])


def write_csv(rows: list[dict]) -> None:
    """bridges_nodiscard.csv: the rows to generate, in the one-job format (bridges_todo.csv's)."""
    with open(CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["first_half", "second_half", "output", "method", "duration"])
        for r in rows:
            if r["class"] != "cut":
                w.writerow([r["exit_stub"], r["entry_stub"], r["output"], METHOD[r["class"]], f"{r['seconds']:g}"])


def local(video: str, work: str = "work", force: str = "") -> None:
    """Optical-flow stand-ins for these rows that lack one (all with `force`), from the same cleaned
    frames as the stubs (seats and the dealer's cards cleared), then resolve what the game plays."""
    rows = json.loads(PLAN.read_text(encoding="utf-8"))["rows"]
    out = ASSETS / FLOW_DIR
    todo = [r for r in rows if flow_frames(r) and (force or not (out / r["output"]).exists())]
    if todo:
        fr = Frames(video)
        segs = {s["name"]: s for s in json.load(open(Path(work) / "edl.json"))["segments"]}
        clean = Cleaners(fr, segs)
        out.mkdir(parents=True, exist_ok=True)
        for r in todo:
            c = clean(r["src"], r["dst"])
            a, b = c(fr.get(r["exit_source_frame"])), c(fr.get(r["entry_source_frame"]))
            encode(interpolate(a, b, flow_frames(r)), out / r["output"])
    print(f"{len(todo)} stand-ins made")
    resolve()


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"plan": plan, "replan": replan, "local": local}[cmd](*args)
