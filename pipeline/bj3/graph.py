"""Which clip the round script can cut to from which loop — the one source of
truth for re-cutting entries (edl) and planning bridges (bridges).

The game only leaves the take's order from a loop: a betting idle, a
decision wait, or (never, it only runs on) a hold. Everything else plays on
into the clip that followed it in the take.
"""

from bj3.geometry import PLAY_ORDER

WAIT_LOOP_S = 2.0  # a decision wait loops over its first this-many seconds (see edl.wait_windows)


def seats_in(mask: str) -> list[str]:
    return [f"seat{i + 1}" for i, b in enumerate(mask) if b == "1"]


def masks(segs: dict[str, dict]) -> list[str]:
    return sorted({s["mask"] for s in segs.values() if s.get("part") == 1})


def transitions(segs: dict[str, dict]) -> dict[str, set[str]]:
    """loop -> the clips the round script can cut to from it."""
    ms = masks(segs)
    out: dict[str, set[str]] = {}
    # betting: any idle loop -> any combination's deal
    for name in ["opening_idle"] + [f"{m}_idle" for m in ms]:
        out[name] = {f"{m}_deal" for m in ms}
    # first decision on the part-1 wait: a seat's first hit, or (all stood) the reveal
    for m in ms:
        out[f"{m}_wait"] = {f"{s}_card3_deal" for s in seats_in(m)} | {f"{m}_reveal"}
    # after a seat has hit (part-2 wait loops): its next hit, a later seat's first hit, or the reveal
    for s in PLAY_ORDER:
        later = PLAY_ORDER[PLAY_ORDER.index(s) + 1:]
        for k in range(3, 7):
            t = {f"{x}_card3_deal" for x in later}
            t |= {f"{m}_reveal" for m in ms if s in seats_in(m)}
            if k < 6:
                t.add(f"{s}_card{k + 1}_deal")
            out[f"{s}_card{k}_wait"] = t
    return out


def sources(segs: dict[str, dict]) -> dict[str, set[str]]:
    """clip -> the loops that can cut to it."""
    out: dict[str, set[str]] = {}
    for src, ts in transitions(segs).items():
        for t in ts:
            out.setdefault(t, set()).add(src)
    return out


def critical(target: str) -> bool:
    """A cut a player is waiting on (they pressed Hit): it must be quick."""
    return "_card" in target and target.endswith("_deal")


def loop_window(seg: dict) -> tuple[int, int]:
    """Source frames [a, b) a loop plays."""
    if "loop_in" in seg:
        return seg["loop_in"], seg["loop_out"]
    return seg["start"], seg["end"]


def predecessor(segs: dict[str, dict], name: str) -> str | None:
    st = segs[name]["start"]
    return next((k for k, s in segs.items() if s["end"] == st), None)


def natural_next(segs: dict[str, dict], name: str) -> str | None:
    end = segs[name]["end"]
    return next((k for k, s in segs.items() if s["start"] == end), None)


def seamless(segs: dict[str, dict], src: str, dst: str) -> bool:
    """Leaving `src`'s loop at its last frame lands exactly on `dst`'s first."""
    return natural_next(segs, src) == dst and loop_window(segs[src])[1] == segs[src]["end"]
