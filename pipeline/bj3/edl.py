"""Pass 3: cut the take into named segments (an edit decision list).

The take has two parts, both found from the tracked cards rather than from
hard-coded timecodes:

* Part 1 — one cycle per seat combination (mask). Each cycle runs
  deal -> wait -> reveal (hole card flipped) -> hold -> discard -> idle.
* Part 2 — a full-table deal, then each seat hit up to six cards (seat 3,
  then 2, then 1), a wait after every card, then reveal, hold and discard.

Cut points sit on the edges of "quiet" runs: frames where nothing moves on
the felt or over the dealer's cards. The dealer's resting hands and body
still breathe inside a quiet run, which is what makes the loops look alive.
Consecutive segments share their boundary frame, so playing them back to
back is exactly the original footage.
"""

import json
import sys
from pathlib import Path

import numpy as np

from bj3.geometry import SEATS

QUIET_MIN_S = 0.4


def quiet_runs(d) -> list[tuple[int, int]]:
    k = 5
    sm = lambda x: np.convolve(x, np.ones(k) / k, "same")
    act = (sm(d["table_motion"]) > 0.6) | (sm(d["dealer_motion"]) > 1.2)
    runs, s = [], None
    for i, a in enumerate(act):
        if not a and s is None:
            s = i
        elif a and s is not None:
            runs.append([s, i])
            s = None
    if s is not None:
        runs.append([s, len(act)])
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= 2:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    fps = float(d["fps"])
    return [(a, b) for a, b in merged if (b - a) / fps >= QUIET_MIN_S]


class Cuts:
    def __init__(self, runs):
        self.runs = runs

    def settle_after(self, f: int) -> int:
        """First frame at or after f where the table is quiet."""
        for a, b in self.runs:
            if a <= f < b:
                return f
            if a >= f:
                return a
        raise ValueError(f"no quiet after {f}")

    def move_before(self, f: int) -> int:
        """Last quiet frame before the motion that leads to f."""
        best = None
        for a, b in self.runs:
            if b <= f:
                best = b
            elif a <= f < b:
                return f
        if best is None:
            raise ValueError(f"no quiet before {f}")
        return best


def clusters(cards: list[dict]) -> list[list[dict]]:
    """Groups of cards that share the table: a new group starts once the table has been cleared."""
    out: list[list[dict]] = []
    for c in sorted(cards, key=lambda c: c["birth"]):
        if out and c["birth"] < max(x["death"] for x in out[-1]):
            out[-1].append(c)
        else:
            out.append([c])
    return out


STATIC = {"wait", "hold", "idle"}


REST = 0.55  # pose motion (mean |dI| of the quarter-res fingerprint) below which she is at rest
REST_RUN = 4


def snap_to_rest(segs: list[dict], pose_npz: str, fps: float) -> None:
    """Move static/action boundaries to where the dealer actually starts moving or comes to rest.

    The felt only moves once a card does; her arm leaves for the shoe ~0.5 s
    earlier and comes back from the discard tray well after. A boundary
    leaving a loop goes back to the last resting frame before she moves; a
    boundary entering a loop goes forward to the first frame she is at rest
    again. Loops stay as long as possible and action clips stay tight.
    Contiguity is kept, so natural playback is untouched.
    """
    z = np.load(pose_npz)
    P = z["pose"].astype(np.float32)
    keep = z["keep"]
    m = np.zeros(len(P), np.float32)
    m[1:] = np.abs(P[1:] - P[:-1])[:, keep].mean(1)
    m = np.convolve(m, np.ones(5) / 5, "same")
    rest = m < REST
    min_loop = int(1.5 * fps)
    for a, b in zip(segs, segs[1:]):
        f = b["start"]
        if a["kind"] in STATIC and b["kind"] not in STATIC:
            lo = max(a["start"] + min_loop, f - int(2.5 * fps))
            g = next((x for x in range(f, lo - 1, -1) if rest[x - REST_RUN + 1:x + 1].all()), None)
        elif a["kind"] not in STATIC and b["kind"] in STATIC:
            hi = min(b["end"] - min_loop, f + int(4.0 * fps))
            g = next((x for x in range(f, hi + 1) if rest[x:x + REST_RUN].all()), None)
        else:
            continue
        if g is not None:
            a["end"] = b["start"] = g


def build(cards_json: str, signals: str, out: str, pose_npz: str | None = None) -> None:
    d = np.load(signals)
    fps = float(d["fps"])
    total = int(len(d["table_motion"]))
    cards = json.load(open(cards_json))["cards"]
    cut = Cuts(quiet_runs(d))
    groups = clusters(cards)
    segs: list[dict] = []

    def seg(name, kind, a, b, **meta):
        assert b > a, (name, a, b)
        segs.append({"name": name, "kind": kind, "start": int(a), "end": int(b), **meta})

    deal_starts = [cut.move_before(min(c["birth"] for c in g)) for g in groups]
    seg("opening_idle", "idle", 0, deal_starts[0], part=0)

    for gi, g in enumerate(groups):
        hole = next(c for c in g if c["face_down"])
        dealer = [c for c in g if c["region"] in ("up", "hole")]
        seat_cards = {s: sorted([c for c in g if c["region"] == s], key=lambda c: c["birth"]) for s in SEATS}
        mask = "".join("1" if seat_cards[s] else "0" for s in SEATS)
        full = len(groups) - 1 == gi
        prefix = "full_table" if full else mask
        part = 2 if full else 1
        deal_a = deal_starts[gi]
        wait_a = cut.settle_after(max(hole["birth"], max(c["birth"] for c in g if c["birth"] <= hole["birth"])))
        seg(f"{prefix}_deal", "deal", deal_a, wait_a, mask=mask, part=part)

        cursor = wait_a
        cursor_name = f"{prefix}_wait"
        cursor_meta = {"mask": mask, "part": part}
        if full:
            # hits: every seat card dealt after the hole card
            hits = sorted([c for c in g if c["region"] in SEATS and c["birth"] > hole["birth"]], key=lambda c: c["birth"])
            for h in hits:
                k = seat_cards[h["region"]].index(h) + 1
                hit_a = cut.move_before(h["birth"])
                seg(cursor_name, "wait", cursor, hit_a, **cursor_meta)
                nxt = cut.settle_after(h["birth"])
                seg(f"{h['region']}_card{k}_deal", "hit", hit_a, nxt, seat=h["region"], card=k, part=2)
                cursor, cursor_name = nxt, f"{h['region']}_card{k}_wait"
                cursor_meta = {"seat": h["region"], "card": k, "part": 2}
        reveal_a = cut.move_before(hole["flip"])
        seg(cursor_name, "wait", cursor, reveal_a, **cursor_meta)
        hold_a = cut.settle_after(hole["flip"])
        seg(f"{prefix}_reveal", "reveal", reveal_a, hold_a, mask=mask, part=part)
        discard_a = cut.move_before(min(c["death"] for c in dealer))
        seg(f"{prefix}_hold", "hold", hold_a, discard_a, mask=mask, part=part)
        idle_a = cut.settle_after(max(c["death"] for c in g))
        seg(f"{prefix}_discard", "discard", discard_a, idle_a, mask=mask, part=part)
        idle_b = deal_starts[gi + 1] if gi + 1 < len(groups) else total
        seg(f"{prefix}_idle", "idle", idle_a, idle_b, mask=mask, part=part)

    if pose_npz:
        snap_to_rest(segs, pose_npz, fps)
    for s in segs:
        s["frames"] = s["end"] - s["start"]
        s["seconds"] = round(s["frames"] / fps, 3)
    Path(out).write_text(json.dumps({"fps": fps, "total_frames": total, "segments": segs}, indent=1))
    ts = lambda f: f"{int(f / fps // 60)}:{f / fps % 60:05.2f}"
    for s in segs:
        print(f"{s['name']:<22} {s['kind']:<8} {ts(s['start'])} -> {ts(s['end'])}  {s['seconds']:6.2f}s")


if __name__ == "__main__":
    build(*sys.argv[1:])
