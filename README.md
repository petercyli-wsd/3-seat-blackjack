# Blackjack · Three Seat — prototype

A playable 3-seat live-dealer blackjack table built from one take of real dealer footage. A
CV pipeline cuts the take into named clips and measures every physical card in it. A React +
WebGL app then plays those clips back as a live game. The player controls all three seats,
and every seat combination and hand size works, from the footage that was filmed.

```
3-seat-blackjack/
  pipeline/      Python: footage analysis, card tracking, trimming, manifest   (uv)
  game_assets/   output: clips/, loops/, masks/, manifest.json, CLIPS.md      (~200 MB)
  app/           Vite + React + TypeScript + WebGL2 table                      (npm)
  PROMPT.md      the earlier planning prompt (superseded by this build)
```

## Run it

```bash
# 1. footage -> game_assets (≈10 min the first time; every pass is cached in pipeline/work/)
cd pipeline
uv sync
uv run python -m bj3 "C:/Users/<you>/Desktop/3 seat blackjack proto/full_footage.mp4"

# 2. the table
cd ../app
npm install
npm run dev          # http://localhost:5183
```

`game_assets/` is already populated, so step 1 is only needed for new footage. Use `--force` to
redo every pass.

**Keys:** `1` `2` `3` take/leave a seat · `Space` deal · `H` hit · `S` stand · `C` clear bets.
The **Director** button opens a panel showing the clip on screen, the frame, which seats are
plated, a stacked-shoe picker for demoing specific paths, and round history.

**Checks:** `npm test` runs the rules engine unit tests. With the dev server running,
`npm run soak -- 6` plays 6 random rounds in headless Edge, and
`npm run capture -- splitTable 1,3 "d u.decision h w2000 cmid"` saves native-resolution
composites to `app/shots/`.

## What's in the footage

The take (6:45, 1440×810, 23.976 fps) has two parts, both found automatically from the tracked
cards rather than from hand-typed timecodes:

| Part | Content | Clips |
|---|---|---|
| 1 (0:00–4:10) | One cycle per seat combination: deal → **wait** → reveal hole card → **hold** → discard → **idle** | `clips/starting_hands/{xxx}_{deal,wait,reveal,hold,discard,idle}.mp4` |
| 2 (4:10–6:45) | Full table: deal, then each seat hit to 6 cards (seat 3, then 2, then 1) with a **wait** after every card, then reveal / hold / discard | `clips/hits/seat{n}_card{k}_{deal,wait}.mp4`, `clips/full_table/*` |

- `xxx` reads left to right as on screen. `101` means seats 1 and 3 are taken.
- Seat numbers run left to right, and the dealer plays them right to left, as filmed. Seat 3 is
  the dealer's left (first base).
- Part 1 has **7** combinations (`001`–`111`). `000` isn't in the take and is never needed.
- Every **bold** pause also gets a ping-pong loop in `loops/`: forward then reversed, with no
  repeated end frames. It can run the full 7 s / 14 s decision time with no visible jump.
  An idle's loop covers only its longest stretch of rest (`loopFrom`–`loopTo` in the manifest).
  After a discard she squares the tray and reaches across the table, and over a whole betting
  phase that repeating reads as fidgeting.
- [`game_assets/CLIPS.md`](game_assets/CLIPS.md) lists all 73 clips with their source timecodes.
- Contact sheets of every cut are in `pipeline/work/review/`.

Cut points are not just "when the cards stop moving". Felt-motion tells when a card moves, but
she reaches for the shoe about half a second earlier, and is still at the discard tray well
after. So the boundaries are moved onto her resting pose using a per-frame fingerprint of her
arms. The result is loops that start and end at rest, and hit clips about 3–5 s long.

## How any seat combination works from one full-table take

Part 2 was filmed with all three seats playing. If the game has seat 3 on 3 cards, seat 2 empty
and seat 1 on 5 cards, the footage at that moment is showing different hands. Three pieces of CV
make it consistent:

1. **Card tracking** (`bj3/tracker.py`, `cardfit.py`). This finds all 58 physical cards in the
   take: their sub-pixel outline (each is a parallelogram in perspective), the frame each one
   lands, the frame the hole card flips, and the frame each one is picked up.
   - Isolated cards are measured directly from line-fitted edges.
   - Hit cards overlap the card before them, so they are fitted as that seat's template card,
     searched over position, rotation and scale.
2. **Seat plates.** For each seat and each hand size (0, 2–6) there is a still of that seat from
   the take. The browser grabs it from the clips at load time with the same decoder that plays
   the footage, so the colours match exactly.
   - Whenever a seat in the footage shows a different hand from the game, the WebGL compositor
     lays that seat's plate into the frame.
   - It does this only where the live pixel is felt or card, so the dealer's arm and hand always
     stay in front.
   - Example: during seat 1's hits, seat 3's six filmed cards become the 3-card plate and
     seat 2 becomes bare felt.
3. **Card faces.** The cards in the take are blank white stock. Each card's face is projected
   onto its outline through a homography.
   - The face takes on the blank card's own luminance, so it keeps the real lighting.
   - It only shows where the pixel really is card stock, so a hand passing over hides the face.
   - Faces appear on the frame the card lands, and the hole card's face appears on the frame it
     flips. The HUD reveals a card only once the footage has shown it.

Clips that follow each other in the take hand over on the exact frame. Cuts between clips that
weren't filmed back to back (for example, any idle into a different combination's deal, or a
wait into a hit) use a 6-frame crossfade between two resting poses.

## Round flow

```
idle loop (betting) ──Deal──▶ {xxx}_deal ─▶ {xxx}_wait loop
   ▲                                          │ seat's turn (right → left): Hit
   │                                          ▼
   │                         seat{n}_card{k}_deal ─▶ seat{n}_card{k}_wait loop ─▶ … (up to 6 cards)
   │                                          │ all seats done
   │                                          ▼
   └─ {xxx}_idle ◀─ {xxx}_discard ◀─ {xxx}_hold loop ◀─ {xxx}_reveal
                                       (dealer draws, settle)
```

**Rules:**
- 8-deck CSPRNG shoe, with the cut card 60–80 cards from the back.
- Dealer stands on all 17s and stops at 7 cards.
- Blackjack pays 3:2.
- A **six-card charlie** stands automatically and wins, unless the dealer has blackjack.
- Reaching 21 or busting ends that seat's turn.
- Hit and stand only: no double, split, surrender or insurance.

**Decisions:** 7 s in Speed mode, 14 s in Regular. On timeout the table plays hit/stand basic
strategy for the seat.

**Seats** can be changed between rounds, and lock once the cards are out. **Reset** clears the
seats, balance and shoe, and returns to the opening idle.

## Known gaps / what to film next

- **Dealer drawing cards: not in the take.**
  - The dealer's real hole-card reveal plays.
  - Any further dealer cards are rendered cards that slide from the shoe into a row in front of
    her two real ones, in table perspective with contact shadows. Her hands still occlude them.
  - This is all in `Director.round()` (the `while (dealerDraws…)` loop) and
    `Scene` (`dealerExtraQuad`), so new dealer-draw clips slot in there. The card tracker will
    measure them like any other card.
- **Card positions shift slightly between the parts.**
  - Part 1 and part 2 cards sit a few pixels apart.
  - On the first hit of a round (a part 1 wait into a part 2 hit), the hitting seat's first two
    cards jump slightly under the crossfade.
  - Re-filming part 1 with the cards placed on part 2's spots, or generating plates for it,
    would remove this.
- **Natural successor vs. responsiveness.** A wait loop is followed in the take by its seat's
  next hit. When the player hits right away, the table crossfades rather than wait up to the
  whole loop for the seamless point.
- **Holds are short** (1.6–2 s). Settling runs over the hold's ping-pong loop, which shows on
  long dealer draws. A longer post-reveal pause in the next shoot would help.
- The pipeline's thresholds (felt hue, card whiteness, rest pose) are tuned to this set and
  lighting. A new set needs a quick check with the review sheets.
