# Bridges: generated moves between clips

The game cuts between clips that weren't filmed back to back: betting → any deal, a decision
pause → a hit or the reveal. A **bridge** is a short generated move that joins them. It starts
on an exit frame of the clip on screen and lands on the first frame of the next.

Everything here is produced by `pipeline/bj3/bridges.py`:

```bash
cd pipeline
uv run python -m bj3.bridges plan  "<full_footage.mp4>"   # this folder: stubs + CSVs
uv run python -m bj3.bridges local "<full_footage.mp4>"   # flow stand-ins into game_assets (already done)
uv run python -m bj3.bridges ingest "<tool output folder>" # your generated bridges into the game
```

## The numbers

There are **168 rows**, over 136 (loop → clip) transitions.

| Class | Rows | Suggested | Notes |
|---|---:|---|---|
| short | 41 | FILM / RIFE, 0.33 s | Same shot or slight sway |
| long | 123 | FILM / RIFE, 0.67 s | Posture differs: sway, head tilt, hand placement |
| generative | 4 | Kling (or Seedance), ~3 s | All four are betting → deal, where nobody is waiting |

- **64 rows are time-critical.** A player pressed Hit, so none of them may run longer than 0.75 s,
  and none needs to.
- **Hit transitions get two exit frames.** One is the best match in each half of the dealer's
  pause loop, so she is never more than about a second from a way out. Every other transition
  has one exit frame, the best match in the loop.
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
| `bridges_onejob.csv` | All 168 rows with per-row `method` (`film` / `kling-fal`) and `duration`, to run as **one job** once the app reads those columns |
| `bridges.csv` | All 168 rows, in the tool's three-column format |
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

Then point me at the output folder, or run `ingest` yourself:

- **Ingest checks each output.** It finds the bridge by matching the two known end frames, so a
  tool that re-times or pads its output still lands exactly. It then writes the bridge-only clip to
  `game_assets/bridges/` and swaps it in for the stand-in.
- **The Director panel shows the switch** under "Bridges": *N generated · M stand-in*.
- **Rows still missing** keep their optical-flow stand-in, so a partial batch is always safe to
  ingest.

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
