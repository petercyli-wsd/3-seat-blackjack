# Build: 3-seat blackjack prototype (video-segment driven)

Build a **standalone browser prototype** of a 3-seat blackjack game whose visuals are
pre-recorded dealer video segments stitched together at runtime, with cards drawn as
overlays. Work only inside `3-seat-blackjack/`. Footage does not exist yet, so the
prototype must run end-to-end on **placeholder segments** and switch to real video
automatically when files appear in `game_assets/`.

The same segment model will later scale to 7 seats, so keep the seat count a
parameter (`SEATS = 3`), never hard-coded in logic.

---

## 0. Assumptions to confirm before running

Edit any of these; everything below follows from them.

| # | Decision | Default |
|---|---|---|
| A1 | Stack | Vite + TypeScript, vanilla DOM + `<canvas>`, Vitest. No UI framework. |
| A2 | Shoe | 8 decks, reshuffle at a cut card 60–80 cards from the back. |
| A3 | Dealer rule | Stands on all 17s (S17). Max 7 cards (stands at the limit). |
| A4 | Dealer hole card | No peek. Dealer blackjack is only revealed in the dealer phase; all player hands play out first. |
| A5 | Payouts | Win 1:1, blackjack 3:2, push returns stake. |
| A6 | 6-card charlie | A player hand reaching 6 cards without busting stands automatically and **wins**, except against dealer blackjack. |
| A7 | Player actions | **Hit and Stand only.** No double, split, surrender or insurance (see §9). |
| A8 | Decision timer | Speed mode 7 s, regular mode 14 s. On timeout, auto-play basic strategy (hit/stand only). |
| A9 | Box order / mask | Box 1 is dealt first (dealer's left). In a mask like `101`, the leftmost digit is box 1. `1` = occupied. |
| A10 | Dealer card count | `dealer.reveal-{2..7}` = **6** variants (the 7-seat guide says "5", which conflicts with 2..7). |

---

## 1. Round flow

```
END (betting loop) → STARTING_HANDS → PLAYER_CARDS (box 1 → box 3) → DEALER_CARDS → DISCARD → END …
```

The dealer is instructed to return to a **neutral pose** at the end of every phase,
so phase boundaries can be joined with a hard cut (optionally smoothed later).

### 1.1 END — `end`
Betting loop between rounds. Players sit/leave and place bets per box. Loops until the
betting timer closes. At least one `end` clip; support several (pick randomly).
If no box is occupied when betting closes, keep looping `end`.

### 1.2 STARTING_HANDS — `starting-hands.{mask}` (7 variants)
Dealer deals 2 cards to every occupied box and 2 to himself (one face down). One
variant per occupancy mask: `001` … `111` (`000` never plays). Each is filmed in
**the same take** as its matching `discard-hands.{mask}`.

### 1.3 PLAYER_CARDS — one long take, split into sub-segments
Recorded as one continuous take dealing cards 3–6 to every box, pausing at the same
spot before each card. Sub-segments (24 total for 3 boxes):

- `box{n}.card-{k}.decision` — the dealer waiting for box *n* to decide on card *k*
  (k = 3..6). **Loops** while the timer runs.
- `box{n}.card-{k}.deal` — dealing card *k* to box *n*.

Contiguous footage order, so these joins are **natural** (no transition):
`box{n}.card-k.decision → box{n}.card-k.deal → box{n}.card-(k+1).decision`, and
`box{n}.card-6.deal → box{n+1}.card-3.decision`.

Each deal is always followed by its own next decision segment, never another one.

**Leaving a box early** (stand, bust, reaching 21, natural blackjack, empty box)
always goes through a decision pose:

| Situation at box *n* | Plays |
|---|---|
| Hit at card *k* | `card-k.decision` loop → `card-k.deal` → `card-(k+1).decision` |
| Stand at card *k* | `card-k.decision` loop → **transition** → next box's `card-3.decision` (or dealer) |
| Bust / reach 21 after `card-k.deal` (k<6) | `card-k.deal` → **transition from `card-(k+1).decision`** (its first frame = the deal's last frame) |
| 6th card dealt (charlie or bust) | `card-6.deal` → natural flow into next box |
| Empty box, or box with blackjack | `card-3.decision` played **once** (no loop) → transition to next box |

Every box is visited in order, even if all later boxes are empty: the dealer walks
box by box to box 3 (one pass of each empty box's `card-3.decision`) and only then goes
to the dealer phase. This keeps "last box → dealer" the only exit into DEALER_CARDS.

### 1.4 DEALER_CARDS — `dealer.reveal-{2..7}` (6 variants)
Dealer flips the hole card and draws to a total of *n* cards. Choose the variant from
the precomputed dealer hand. If every player hand is bust, still play `reveal-2`
(hole card flip only).

### 1.5 DISCARD — `discard-hands.{mask}` (7 variants)
Dealer picks up his cards, then each box's cards. Mask = the round's starting mask.
At runtime, overlays show the **actual** number of cards in each hand (2–6 per box,
2–7 for the dealer), whatever the footage physically holds.

---

## 2. Junctions (edges between segments)

Model every edge explicitly with one of three kinds:

- `natural` — contiguous in the original footage; just play the next segment.
- `neutral` — both sides are at the neutral pose; hard cut now, transition clip optional.
- `transition` — needs a generated bridge clip `transitions/{from}__{to}.mp4`.

If a `transition` (or optional `neutral`) clip is missing, fall back to a hard cut and
record it in the debug panel's "missing" list. Never crash on a missing asset.

Transition targets may be **groups**: if all `dealer.reveal-*` takes start from the
same pose, one clip `box3.card-k.decision__dealer.reveal-*` serves all six. Lookup
order: exact pair → group → hard cut.

| From → To | Kind | Count (3 seats) |
|---|---|---|
| `end` → `starting-hands.{mask}` | neutral | 7 |
| `starting-hands.{mask}` → `box1.card-3.decision` | neutral | 7 |
| `box{1,2}.card-{3..6}.decision` → `box{n+1}.card-3.decision` | transition | 8 |
| `box3.card-{3..6}.decision` → `dealer.reveal-{2..7}` | transition | 24 (or 4 grouped) |
| `dealer.reveal-{2..7}` → `discard-hands.{mask}` | neutral | 42 |
| `discard-hands.{mask}` → `end` | neutral | 7 |

Generated transitions to produce: **32**, or **12** if reveals share a start pose.

> Note vs. the 7-seat guide: it counts 3 stand transitions per box. I count 4
> (stand at card 3, 4, 5 *and* 6). Report shows both so we can settle it.

---

## 3. Decision loops

- A decision segment loops **ping-pong** (forward then backward) so it has no visible
  jump. Browsers can't reverse video reliably, so expect real files to be pre-baked
  boomerangs (`forward + reversed`, one file) and loop that file normally.
- A loop can only be **exited at its anchor frame** (frame 0 of the boomerang), because
  transitions and deals start from that frame. When the player acts mid-loop, finish
  the current cycle, then leave. Show this latency in the debug panel.
- The timer (7 s / 14 s) starts when the decision segment first starts. On timeout,
  auto-play basic strategy:
  - Hard: hit ≤11; hit 12 vs dealer 2–3 and 7–A; hit 13–16 vs 7–A; stand otherwise.
  - Soft: hit ≤17; hit 18 vs 9, 10, A; stand 19+.

---

## 4. What to build

### 4.1 Game rules engine (`src/rules/`), pure TS, no DOM
Shoe with injectable RNG (seedable for tests; `crypto.getRandomValues` otherwise),
hand totals (soft/hard), dealer play, 6-card charlie, settlement, auto-strategy.
Any reference is optional — e.g. `../live-dealer/src/blackjack/deal.py` has a hand-total
and dealer-rule implementation worth reading — but **do not import or depend on it**.

### 4.2 Segment graph (`src/segments/`) — single source of truth
Code that, from `SEATS`, generates every segment name, every edge with its kind, and
the transition list. Everything else (sequencer, reports, asset checks) reads from it.

### 4.3 Round planner + sequencer (`src/sequencer/`)
- Planner: given round state and player input, emit the next segment(s) and the edge
  used. Pure function; no timers inside.
- Player: two stacked `<video>` elements (A/B), preload the next segment while the current
  plays, swap on end (use `requestVideoFrameCallback` where available). Measure and
  display any gap at each swap.
- Placeholder mode: for any segment without a file, render on canvas a labelled card
  with its name, a progress bar, and pose tag (`neutral`, `box2-decision`…), for a
  configured duration (defaults: deal 1.2 s, decision loop 1.5 s, starting-hands 6 s,
  reveal 2 s + 1 s per card, discard 5 s, end 4 s). Real and placeholder segments
  must be interchangeable mid-round.

### 4.4 Card overlays (`src/overlay/`)
Canvas layer above the video draws cards from game state. Each segment may have a
sidecar `{segment}.cards.json`: per card slot, the time it appears and its
`x, y, w, h, rotation`. Placeholders use a default table layout. Discard removes
cards in pickup order. Define and document the JSON format; authoring tools for it
are out of scope.

### 4.5 UI (`index.html`)
- Table view: video + overlays, 3 boxes with seat toggle, bet input, balance,
  Hit/Stand buttons for the active box, countdown, speed/regular switch.
- Debug panel: current segment + edge kind, upcoming queue, timeline of the last
  round, missing assets, hard-cut fallbacks, swap gaps, RNG seed, and a **scenario
  picker** that forces a stacked shoe (e.g. "box 2 busts on card 4", "box 1 charlie",
  "all bust", "dealer 7 cards", "only box 3 seated").

### 4.6 Production reports (`npm run reports`)
Generated from the segment graph into `docs/`:
- `SHOT_LIST.md` — every take to film, its sub-segments, and cards dealt per take.
- `transitions.csv` — `from, to, kind, group, present_in_assets`.
- `ASSET_STATUS.md` — expected vs. found files in `game_assets/`.

### 4.7 RTP simulation (`npm run sim`)
Monte Carlo of N rounds using the auto-strategy, printing RTP/house edge and the
frequency of each segment path (how often each reveal-n, each card-k, each mask is
used). This tells us which footage matters most.

---

## 5. Asset layout

```
game_assets/
  segments/{name}.mp4            # e.g. starting-hands.101.mp4, box2.card-4.decision.mp4
  segments/{name}.cards.json     # optional overlay geometry
  transitions/{from}__{to}.mp4   # e.g. box1.card-3.decision__box2.card-3.decision.mp4
  end/*.mp4                      # one or more betting loops
```

The long PLAYER_CARDS take and the combined starting-hands/discard takes are cut
into these files outside the prototype; a manifest-driven `in/out` timecode
alternative is a nice-to-have, not required.

---

## 6. Tests (Vitest)
- Rules: totals, soft aces, dealer draws, charlie, settlement incl. blackjack vs charlie.
- Graph: counts match §2 for `SEATS=3`, and scale correctly for `SEATS=7`
  (masks 127, sub-segments 56).
- Planner: for thousands of seeded random rounds across all masks, every emitted
  sequence is a valid walk of the graph, starts and ends at `end`, visits boxes in order,
  and never follows a deal with a different box's decision.
- Scenarios from the debug picker each produce the expected segment sequence.

---

## 7. Working approach
- Order: rules engine + tests → segment graph + reports → planner + tests →
  placeholder playback + UI → overlays → real-video playback → sim.
- Run tests at each step. Proceed without waiting for me unless an assumption in §0
  blocks you; then ask.
- Finish with a README: how to run, how to drop in footage, and the open questions below
   with what the prototype currently does about each.

## 8. Open questions (record the chosen default in the README)
- Stand from `card-6.decision`: separate transition, or can footage cover it? (§2 note)
- Do all `dealer.reveal-*` start from one pose (enabling grouped transitions)?
- Which neutral junctions need real transitions once we see footage?
- Is 6-card charlie beaten by dealer blackjack? (A6)
- Peek vs. no peek. (A4)

## 9. Out of scope — do not build
Double, split, surrender, insurance, side bets, multi-hand per player, networking, real
money, RGS integration. Don't add speculative hooks for them; keep the rules engine
and segment graph simple enough that adding them later is a local change.
