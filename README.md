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

## Hosting (Render Web Service, password-protected)

`app/server.mjs` serves the built app with HTTP Basic auth. It uses Node built-ins only.

1. Go to **New → Web Service** and connect the repo.
2. Set the service up:
   - **Root Directory:** `app`
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm start`
3. Add the environment variable `SITE_PASSWORD`. The server refuses to start without it.
4. Set **Health Check Path** to `/health`.

Visitors sign in with any username and that password. Each visit downloads the full ~200 MB of
footage. Locally: `npm run build` then `SITE_PASSWORD=… npm start`, which serves on port 10000.

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

**Entries are re-cut for the jumps between clips** (`edl.recut_entries`). The dealer's resting
pose drifts through the take, and before every deal she leans into a ready pose with her hand
parked on the shoe.
- Each clip the game cuts into (a deal, hit or reveal) starts on the resting frame that best
  matches every loop it can be entered from.
- A deal starts inside its idle's calm stretch, so the lean becomes the opening of the real deal.
- A hit moves earlier only when that buys a lot. `seat1_card6` now opens before a brief hair touch.
- The worst entry gaps fell from about 15 to 5–8 on the pose fingerprint.

**Decision waits loop over their first 2 s**, just after she comes back to rest from dealing.
Exits from there keep a Hit quick.

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
   - `bj3/settle.py` then refits every card's resting outline on ~24 frames of its stay, from
     edge contrast (card stock just inside each side, none just outside), and keeps the median
     pose. One frame with a hand beside the card can no longer put its face off the card.
   - `bj3/flight.py` follows each face-up card backward from where it lands, frame by frame,
     while she slides it in under her fingers. Poses are rigid moves of the card's own outline,
     turned in table space (`bj3/rigid.py`), at the scale its height in the image gives it, and
     pinned to its edges with a pull toward the predicted pose. Only frames that see most of the
     card say where it is: a card lying still is waited for through her arm passing over it (the
     dealer's up card often lies a moment before she squares it up), and a half-hidden fit
     between two clear ones is interpolated rather than trusted. Stretches where it lies still
     are drawn at one pose and the moving frames are smoothed, so the face doesn't wobble on its
     card. Where it stops lying flat, a few more frames are fitted with the card swung up about
     one edge, as it comes down out of her hand; it stops where the card is face down or edge on.
   - The hole card's flip is traced the same way, back from the frame it lies face up: its face
     shows as it turns over and while she squares it, not only once it is back in its slot.
   - At the reveal she lifts the up card to scoop the hole card over. `settle` finds such trips
     (the card's edges go and felt shows where it lay; under a passing hand skin would), and
     `flight` follows the card while it is flat on the table; lifted in her hand it is blank.
   - At the discard, `settle` finds the frame each card starts to move, and `flight` follows
     it forward from there while it moves flat and on its own. Once she has gathered a hand
     into a pile, the pile is fitted as one card (a card-shaped blob of moving card stock, its
     corners taken as they look, tilted or not) and the hand's top card rides on it to the tray:
     a seat's last-dealt card, slid over the rest, or the dealer's up card, laid on the hole card.
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
   - The face takes on the blank card's own luminance, so it keeps the real lighting, down
     into the shade of her arm.
   - It only shows where the pixel really is card stock, so a hand passing over hides the face.
     Card stock is told by colour, not brightness: not felt blue, not skin warm, not her dark
     sleeve. A card in shade keeps its face.
   - Faces appear on the first frame the card shows face up in her hand and ride along its
     slide-in path (`path` in the manifest), motion-blurred along its movement. The hole card's
     face rides its flip the same way. At the reveal the up card's face follows it (`trips`),
     and at the discard a face follows its card off its resting place (`away`) and fades as the
     card goes into the pile; the top card's face then rides on the pile in her hand (`pile`).
     The HUD reveals a card only once it has landed.

   `node app/scripts/frames.mjs <clip> <from> <to> [step] [x,y,w,h]` renders chosen frames of a
   clip exactly as the table draws them (dev server running), for checking faces frame by frame.

Clips that follow each other in the take hand over on the exact frame. A cut between clips that
weren't filmed back to back goes through a **bridge**: a short generated move from an exit frame
of the loop on screen to the target's first frame. See [`bridges/README.md`](bridges/README.md).

- **Choosing the bridge:** the director takes the soonest way out: the take's own seamless
  continuation, or a bridge's exit frame. Every transition has two exits per loop, so a Hit leaves
  within about a second.
  - A bridge only starts when its clip is ready to play on that exact frame; otherwise it waits for
    the next time round.
  - A bridge that can't play (a failed download) is skipped for another way.
- **The seats during a bridge:** bridges are generated from frames with the players' seats cleared
  to bare felt, and during one every seat shows a plate of its real hand. No interpolated card is
  ever seen morphing.
- **Where they come from:** 280 rows, generated by FILM and Kling (Kling only for betting → deal).
  - 277 generated bridges play, plus 1 matched cut.
  - 2 Kling second exits were rejected on review. Their transitions use the other exit's bridge.
  - Optical-flow stand-ins (`bridges.py local`) exist for every row as a fallback, but none is
    needed now.
- **Replacing them:** run `ingest` on the new outputs; any subset replaces just those rows.
  `review` builds a page to watch and judge them all. See
  [`bridges/README.md`](bridges/README.md#replacing-a-bridge).
- **Fallbacks:** a clip with no bridge to the target waits for the loop it's heading into, for
  example a Deal pressed during the discard. Only when no bridge exists at all does the table
  hard-cut.

The table opens once the opening idle and the plate clips are in memory (~22 MB). The rest of
the footage it plays (~160 MB in all; part 2's own deal, reveal and discard are never used) loads behind
it, in the order a round needs it, and the LIVE badge shows the progress.

## Framing, studios and tables

The table opens cropped to the dealer, framed like a live studio table. Her head is near the top,
the table's back edge is just past halfway down, and the seats' cards are in the lower third.
**Room** picks a studio set and **Table** picks its felt; either can be "As filmed". **Full take**
shows the whole frame as filmed. Her footage never changes: she is put in the set in the
compositor's last pass (`STAGE_FS`).

- **Studio sets** come from `bj3/sets.py` (needs `RUNNINGHUB_API_KEY` in `.env`), using
  nano-banana-pro on RunningHub.
  - Its input is the app's own render of the empty set: the painted table on a grey backdrop,
    made with `node app/scripts/set-input.mjs`.
  - So each set's camera, perspective and table geometry are this take's.
  - Each result is aligned back onto the input (a homography on the table's edges), so the
    table's back edge lands on the real cloth's.
  - `ROOMS` holds the prompts.
  - The felt is always generated blue. A table choice recolours only the felt's share of each
    pixel, by its blue, so the print and the light stay.
- **Her matte** comes from `bj3/mattes.py`, which runs MatAnyone 2 on RunningHub over every clip
  and loop.
  - Each file is re-encoded with its matte stacked below the picture, as 1440×1620 in
    `game_assets/matted/`, so the browser decodes picture and matte in lockstep.
  - It is listed in `scene/mattes.json`, and the loader plays the packed file instead.
  - Re-run it after re-cutting clips. A clip without a packed version falls back to the colour
    key below, as the generated bridges always do.
- **Masks** come from `bj3/scene.py`; run it once per take.
  - It builds the set as filmed without her (`reference.png`).
  - It writes her envelope, the cloth, her reach on it, the clutter on it to erase, and the shoe
    and discard holder.
- **Keying, per pixel:** coverage `a` is computed, and her colour is unmixed from the reference,
  `F = (C − (1 − a)·ref) / a`, before being laid over the set.
  - Above the cloth, `a` is her matte, plus cards she carries (far brighter than the wall) and
    the tops of the props.
  - Without a matte, `a` is how unlike the wall she is.
  - On the cloth, `a` is the share of the bare felt's blue that is missing (cards, her hands,
    her shadows), plus her matte.
  - Her shadow, which is the felt darkened, becomes the new felt darkened alike.
- **Browser checks:** `capture`, `probe` and `frames` read the canvas in source pixels, so they
  open `?framing=studio&background=studio&table=studio`. Use `BACKGROUND=lotus TABLE=emerald
  node scripts/frames.mjs …` to render frames in a set; those frames play the unpacked clips.

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
  - At the first bridge of a round (a part 1 wait into a part 2 hit), the seats switch to their
    plates, and the first two cards move by those pixels.
  - Re-filming part 1 with the cards placed on part 2's spots would remove this.
- **The dealer's posture drifts between parts of the take.** That's why most bridges are "long"
  (0.67 s). In the next shoot, a consistent neutral pose (hands on the table edge, back straight)
  at every pause would make most of them short, or plain cuts.
- **Holds are short** (1.6–2 s). Settling runs over the hold's ping-pong loop, which shows on
  long dealer draws. A longer post-reveal pause in the next shoot would help.
- The pipeline's thresholds (felt hue, card whiteness, rest pose) are tuned to this set and
  lighting. A new set needs a quick check with the review sheets.
