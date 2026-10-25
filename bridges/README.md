# Bridges: generated moves between clips

The game cuts between clips that weren't filmed back to back: betting → any deal, a decision
pause → a hit or the reveal. A **bridge** is a short generated move that joins them. It starts
on an exit frame of the clip on screen and lands on the first frame of the next.

Everything here is produced by `pipeline/bj3/bridges.py`:

```bash
cd pipeline
uv run python -m bj3.bridges plan  "<full_footage.mp4>"        # this folder: stubs + CSVs
uv run python -m bj3.bridges local "<full_footage.mp4>"        # flow stand-ins (already done)
uv run python -m bj3.bridges ingest "<folders and/or files>"   # generated bridges into the game
uv run python -m bj3.bridges review                            # review.html: watch and judge them
uv run python -m bj3.bridges verdict "<name>.mp4" reject "why" # drop one (or `ok` to restore)
uv run python -m bj3.bridges resolve                           # rewrite what the game plays
```

## Status

There are **280 rows** over 144 transitions. Each transition has two exit points, so the dealer
is never more than about one loop from a way out.

- **165 play generated bridges.** These are all from the second batch, which covered the first 168 rows.
- **114 rows are to generate:** the 111 new rows plus the 3 rejects. They're listed in
  **`bridges_todo.csv`** (29 × FILM 0.33 s, 77 × FILM 0.67 s, 8 × Kling 3 s), ready to run as one
  job. Until then they play optical-flow stand-ins.
- **1 row needs nothing generated.** Its two frames already match, so it's a plain cut.

From the second batch:

- **3 rejected Kling bridges** play their optical-flow stand-ins until they're regenerated:

  | Bridge | Problem |
  |---|---|
  | `011_idle@0044__010_deal` | Arms jump mid-move |
  | `111_idle@0098__100_deal` | Mimes dealing a card that appears from nowhere |
  | `opening_idle@0068__100_deal` | Hands jump |

- **The fourth Kling bridge (`101_idle@0064__100_deal`) is kept.** It's flagged by the checks only
  because Kling re-renders her sweater's texture at the seams.
- **All 164 FILM bridges pass every check.**

Verdicts and their reasons are in `verdicts.json`.

## The numbers

There are **280 rows** over 144 (loop → clip) transitions.

| Class | Rows | Suggested | Notes |
|---|---:|---|---|
| cut | 1 | none | The frames already match |
| short | 70 | FILM / RIFE, 0.33 s | Same shot or slight sway |
| long | 200 | FILM / RIFE, 0.67 s | Posture differs: sway, head tilt, hand placement |
| generative | 9 | Kling (or Seedance), ~3 s | All betting → deal, where nobody is waiting |

- **65 rows are time-critical.** A player pressed Hit, so none of them may run longer than 0.75 s,
  and none needs to.
- **Every transition has two exit frames,** the best match in each half of the dealer's loop.
  - For a Hit, from the 2 s decision loops, that means she's never more than about a second from a
    way out.
  - The 8 transitions the take already makes seamlessly, at the loop's last frame, get one more
    exit in the first half.
- **Classes come from optical flow, measured on the pixels that change.** How far the dealer
  moves, and what share of the frame warping can't explain:

  | Example | Flow | Unexplained |
  |---|---:|---:|
  | Consecutive frames | 0.9 px | 0.01 % |
  | Body sway between parts of the take | ~15 px | 1.3 % |
  | A lean or reach | 30–45 px | 2–2.5 % |
  | Your first batch (mid-gesture at the tray) | 70 px | 8 % |

  Those discard-tail exits are gone. The table now waits for the dealer's calm betting loop.

## Files

| File | Use |
|---|---|
| `bridges_todo.csv` | **The rows still to generate** (never generated, rejected, or stale), with per-row `method` and `duration`. Rewritten by every `ingest` / `verdict` / `resolve`. |
| `bridges_onejob.csv` | All 279 rows to generate with per-row `method` (`film` / `kling-fal`) and `duration`, to run as **one job** |
| `bridges.csv` | The same rows, in the tool's three-column format |
| `bridges_short.csv`, `bridges_long.csv`, `bridges_generative.csv` | The same rows split by suggested method, so each can be one batch with one setting |
| `bridges_full.csv` | The one-job columns plus the planning ones: `max_seconds`, `critical`, `class`, `flow_px`, `unexplained_pct`, `src`, `dst` |
| `stubs/exit/*.mp4`, `stubs/entry/*.mp4` | The 8-frame first and second halves; select `stubs/` as the source folder |
| `plan.json` | Everything above, for the pipeline |

The stubs have the **players' seats cleared to bare felt**. The two clips a bridge joins hold
different cards there, and interpolating them would show cards morphing and drifting. During a
bridge, the game lays its own picture of each seat's real hand over the felt, so leave the empty
seats as they are.

## Generating

1. **Source folder:** `bridges\stubs`. Leave the root fields blank, because the paths are relative.
2. **Short and long batches:** FILM or RIFE, at 0.33 s and 0.67 s respectively.
   - 23.976 fps, or 24 if the API needs an integer. Ingest re-times by frame count, so either is fine.
   - Audio off.
3. **Generative batch:** Kling first/last frame, 3 s (or Seedance, 4 s).
   - These are betting → deal moves, where length doesn't matter.
   - Check that her face, hair and the dealer's cards stay consistent.
4. **Output folder:** `bridges\generated`, or anywhere you like. It's ignored by git.

Then point me at the output folder, or run `ingest` yourself.

## Replacing a bridge

1. **Regenerate the rows** you want to replace, with the same output names. Any subset works: one
   file, a folder, several folders.
2. **Run `ingest` on them.** A new output for a row replaces the old one, and rows you don't give
   are left alone. A verdict on the old output is cleared automatically, since a verdict is tied
   to the exact file it judged (its `sha1`).
3. **Check the result.** Run `review`, open `bridges/review.html`, filter to *Flagged* or by kind,
   and watch each output (the footage it leaves, the bridge, the footage it lands in) at full
   speed or a quarter.
   - Mark **Reject** or **OK** on any card, with a note, then **Download verdicts.json**.
   - Save it over `bridges/verdicts.json` and run `resolve`, or use `verdict` from the command line.
4. **Commit `game_assets/`, `bridges/state.json` and `bridges/verdicts.json`.**

**What ingest does with each output:**
- Finds the bridge by aligning the two 8-frame stubs as whole sequences, so padding or trimming
  by the tool can't shift it.
- Writes the bridge-only clip to `game_assets/bridges/tool/`.
- Archives the delivered file in `bridges/generated/` (not in git).
- Records its provenance (method, length, provider request id from the tool's `batch-report.csv`)
  and quality checks in `state.json`.

**What the checks look for:**
- a pop at either seam, measured against how much the dealer moves per frame;
- a glitch frame or lurch mid-bridge;
- held frames;
- a brightness drift.

They flag; the verdict is a person's.

**What the game plays:** the generated bridge for every row, unless it's missing or rejected.
Then it plays the optical-flow stand-in from `game_assets/bridges/flow/`. Nothing is ever without
a bridge, and the Director panel shows *N generated · M stand-in (K rejected)*.

## Suggestions for the interpolation tool

The game knows each transition's **time budget**. The tool can see the **frames**. So the split
that works best:

- **CSV columns:** keep the three required columns, and accept optional extra ones.
  - **`max_seconds`:** a hard cap from the game. 0.75 for a Hit, more for betting → deal or the
    reveal.
  - **`method`:** an optional override (`FILM`, `RIFE`, `Kling`, `Seedance`, `none`). When it's
    absent, the tool decides.
- **Choosing the method:** the tool measures the two end frames itself, using flow over the
  changed pixels as above.
  - Small motion → FILM at its natural length.
  - Large motion within the budget → a longer FILM.
  - Large motion over the budget → generative, only if `max_seconds` allows its minimum length,
    otherwise the longest FILM allowed, flagged for review.
- **Report:** write the chosen method, length and the two scores back into the row report, so
  failures can be re-run with a different method.

`bridges_onejob.csv` carries a `method` (the app's own method ids) and `duration` for every row,
so a tool that reads those columns runs the whole set as one job. `bridges_full.csv` adds
`max_seconds` and the scores. `python -m bj3.bridges csvs` rewrites all the CSVs from
`plan.json`.
