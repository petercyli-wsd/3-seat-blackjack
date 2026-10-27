import { type Card, faceIndex } from "../engine/cards";
import type { PlayingState } from "../media/ClipPlayer";
import { type ClipInfo, type FootageCard, type Manifest, type Pt, type Quad, type SeatId, cardsAt, clipName, faceFrom, faceQuadAt, faceUntil } from "../media/manifest";
import type { PlateSet, PlateTexture, RoundPlates, SeatPlate } from "../media/plates";
import type { CardDraw, PlateDraw } from "./Compositor";
import {
  IDENTITY, type Similarity, centre, fitSimilarity, lerpQuad, lerpSimilarity, moveQuad, rotateQuad, scaleQuad, translateQuad,
} from "./homography";

/** What the game says is on the table; the scene decides how to show it on the current frame. */
export interface TableView {
  seats: Record<SeatId, Card[]>;
  dealer: Card[];
  /** performance.now() at which each graphic dealer card (3rd onwards) left the shoe. */
  dealerDrawAt: number[];
  /**
   * The take the round was dealt in (its seat mask). Its dealer put each seat's first two cards in
   * that take's own spots, and the cards stay there all round, whatever footage is on screen.
   */
  home?: string;
}

export interface SceneResult {
  plates: (PlateDraw | null)[];
  cards: CardDraw[];
  /** Cards each hand visibly shows right now — what the HUD may reveal. */
  visible: Record<SeatId | "dealer", number>;
  /** For the director panel. */
  plateUse: Record<SeatId, number | null>;
}

/** Each plate's still and matte, as textures. */
export type PlateTextures = Record<SeatId, Record<number, PlateTexture>>;

/** A hand to lay in: a plate, its textures, and where it goes. */
interface Held {
  plate: SeatPlate;
  tex: PlateTexture;
  place: Similarity;
}

const LAND_FADE = 3;
const DRAW_MS = 520;
const DISCARD_FADE = 5;
/** Frames after a hit card lands that it is taken to be settling, where the pipeline's landing pass hasn't tracked it. */
const SETTLE = 6;
/** Frames a laid-in card takes to fade out of a discard, ending as her hand comes over its hand. */
const EXTRAS_FADE = 6;

/** Graphic dealer cards go in a second row just in front of the two real ones (the pipeline's discard.dealer_draw_quad). */
export function dealerExtraQuad(m: Manifest, i: number): Quad {
  const up = m.dealer.up;
  const c = centre(up);
  return scaleQuad(translateQuad(up, 735 + i * 26 - c[0], 402 - c[1]), 1.03);
}

export class Scene {
  constructor(
    private m: Manifest,
    private plates: PlateSet,
    private plateTex: PlateTextures,
    private round?: RoundPlates,
  ) {}

  /**
   * A hand laid in over another take than the round's, wherever that take (its own still of the
   * seat, holding `shown` cards) or the hand has a card and the frame shows table there, darkened
   * by her shadow; her hand and the card she is `dealing` stay as filmed. At the seat being `dealt`
   * to, the take holds the hand's cards from the third on just where the round has them, so only
   * its first two are laid in.
   */
  private matched(h: Held, seat: SeatId, shown: number, dealing: Pt[] | null, dealt = false): PlateDraw {
    const ref = this.plates[seat][shown];
    if (!ref) return plateDraw(h, 1, "whole");
    const tex = this.plateTex[seat][shown];
    return { ...plateDraw(h, 1, dealt ? "dealing" : "match"), ref: { tex: tex.image, matte: tex.matte, rect: ref.rect }, dealing };
  }

  /**
   * The seat's hand of `n` as the round dealt in take `view.home` has it: that take's own still of
   * its first two cards with the plate's others laid on, or, while that still is being grabbed,
   * the plate moved onto those two cards (its others a few pixels off where they will be).
   */
  private held(view: TableView, home: ClipInfo, seat: SeatId, n: number): Held | undefined {
    const own = view.home ? this.round?.get(view.home, seat, n) : undefined;
    if (own) return { ...own, place: IDENTITY };
    const plate = this.plates[seat][n];
    return plate && { plate, tex: this.plateTex[seat][n], place: placing(home, seat, plate) };
  }

  compute(s: PlayingState, view: TableView, now: number): SceneResult {
    if (view.home) this.round?.prepare(view.home);
    if (s.clip.bridge) return this.bridge(s.clip, s.frame, view);
    const { clip, frame: f } = s;
    const plates: (PlateDraw | null)[] = [];
    const cards: CardDraw[] = [];
    const visible = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 } as SceneResult["visible"];
    const plateUse = { seat1: null, seat2: null, seat3: null } as SceneResult["plateUse"];
    // footage from another take than the round's (a hit, from the full-table round), whose dealer
    // put the cards a few pixels from where the round has them
    const home = view.home && clip.mask !== view.home ? this.m.clips[clipName.wait(view.home)] : undefined;

    for (const seat of this.m.seats) {
      const hand = view.seats[seat];
      // cards lying in the seat on this frame (one still sliding in doesn't count yet)
      const footage = cardsAt(clip, seat, f).length;
      const own = clip.cards.filter((c) => c.slot === seat);

      if (home) {
        const dealt = dealsTo(clip, seat) ? own.find((c) => c.index === clip.card && c.index <= hand.length) : undefined;
        // the wait after a hit, same take: the seat as it was just dealt to
        const justDealt = clip.kind === "wait" && clip.seat === seat && hand.length >= 3;
        if (!dealt && !justDealt) {
          // the hand as it lies in the round, over whatever this take has in the seat
          const h = this.held(view, home, seat, hand.length);
          if (!h) {
            plates.push(null);
            continue;
          }
          plates.push(this.matched(h, seat, footage, null));
          plateUse[seat] = h.plate.n;
          h.plate.cards.forEach((q, i) => cards.push({ quad: moveQuad(h.place, q), cell: faceIndex(hand[i]), alpha: 1, mode: "footage" }));
          visible[seat] = hand.length;
          continue;
        }
        // The hit, and the wait after it: only the first two cards differ from the round (the rest
        // lie where the round has them too). So those are laid in, wherever the frame shows the
        // table just as this take's own still of the seat does, and all else stays as filmed: her
        // hand, her shadow, the cards from the third on, and the card she brings in, which lands
        // and settles under her finger as it really does. Over the second card, white on white,
        // its outline as tracked over its landing (`land`) marks it out until it lies at rest.
        const land = dealt?.land;
        const settling = !!dealt && f < (land ? land.rest : dealt.in + SETTLE);
        // the round's hand, and the take's own still, both without the new card until it lies at rest
        const h = this.held(view, home, seat, settling ? dealt.index - 1 : hand.length);
        if (!h) {
          plates.push(null);
          continue;
        }
        const outline = settling && land ? (land.outlines[f - land.from] ?? null) : null;
        plates.push(this.matched(h, seat, settling ? dealt.index - 1 : footage, outline, true));
        plateUse[seat] = h.plate.n;
        h.plate.cards.slice(0, 2).forEach((q, i) => cards.push({ quad: moveQuad(h.place, q), cell: faceIndex(hand[i]), alpha: 1, mode: "footage" }));
        footageFaces(clip, seat, hand, f, cards, 3);
        visible[seat] = Math.min(footage, hand.length);
        continue;
      }

      if (!dealsTo(clip, seat) && hand.length >= 2 && own.length === 2 && own.every((c) => c.index <= 2)) {
        // The take holds this hand's first two cards: they are the real ones, as filmed (and swept
        // up as filmed in a discard). A bigger hand's other cards are laid in from its plate where
        // the full-table round's dealer put them (as the hits show them landing); she can't pick
        // those up, so in a discard they fade out just before her hand comes over the hand.
        footageFaces(clip, seat, hand, f, cards);
        visible[seat] = Math.min(footage, hand.length);
        const plate = hand.length > 2 ? this.plates[seat][hand.length] : undefined;
        const alpha = plate ? extrasAlpha(clip, seat, hand.length, f, Math.min(...own.map((c) => c.out))) : 0;
        if (plate && alpha > 0) {
          plates.push(plateDraw({ plate, tex: this.plateTex[seat][plate.n], place: IDENTITY }, alpha, "extras"));
          plateUse[seat] = plate.n;
          plate.cards.slice(2).forEach((q, i) => {
            cards.push({ quad: q, cell: faceIndex(hand[i + 2]), alpha, mode: "footage" });
          });
          if (alpha > 0.5) visible[seat] += hand.length - 2;
        } else {
          plates.push(null);
        }
        continue;
      }

      let want = hand.length;
      let plateAlpha = 1;
      if (dealsTo(clip, seat)) {
        // this clip is putting cards down on this seat: the footage leads
        want = footage;
      } else if (clip.kind === "discard") {
        const lastOut = Math.max(-1, ...own.map((c) => c.out));
        if (own.length === hand.length) {
          // the take holds this very hand: it is swept up as filmed (a plate would lay a still
          // of the resting cards back in under her hand as each one leaves)
          want = footage;
        } else if (footage === 0 && f >= lastOut) {
          plateAlpha = 1 - (f - lastOut) / DISCARD_FADE;
          if (plateAlpha <= 0) want = 0;
        }
      }
      const plate = want !== footage ? this.plates[seat][want] : undefined;
      if (plate && plateAlpha > 0) {
        const place = placing(clip, seat, plate);
        plates.push(plateDraw({ plate, tex: this.plateTex[seat][plate.n], place }, plateAlpha, "whole"));
        plateUse[seat] = want;
        plate.cards.forEach((q, i) => {
          if (hand[i]) cards.push({ quad: moveQuad(place, q), cell: faceIndex(hand[i]), alpha: plateAlpha, mode: "footage" });
        });
        visible[seat] = plateAlpha > 0.5 ? want : 0;
      } else {
        plates.push(null);
        footageFaces(clip, seat, hand, f, cards);
        visible[seat] = Math.min(footage, hand.length);
      }
    }

    // dealer: the up card and the hole card are real; the up card's face rides in with it,
    // the hole shows its face once flipped
    let dealerShown = 0;
    const real = clip.cards.filter((c) => c.slot === "up" || c.slot === "hole");
    for (const c of real) {
      const card = view.dealer[c.index - 1];
      if (!card) continue;
      // the hole card's face shows from its flip (and as it turns over), like any card's from landing
      const quad = faceQuadAt(c, f);
      if (!quad) continue;
      cards.push(footageFace(c, quad, f, faceIndex(card), faceFrom(c)));
      if (f >= c.in) dealerShown++;
    }
    // graphic draws: on the table from when they leave the shoe until her hand comes for the
    // dealer's cards in the discard
    const draws = view.dealer.length - 2;
    let drawsAlpha = 1;
    if (clip.kind === "discard" && real.length) drawsAlpha = extrasAlpha(clip, "dealer", draws, f, Math.min(...real.map((c) => c.out)));
    if (["deal", "hit", "idle"].includes(clip.kind)) drawsAlpha = 0;
    if (drawsAlpha > 0) {
      view.dealer.slice(2).forEach((card, i) => {
        const t0 = view.dealerDrawAt[i];
        if (t0 === undefined || now < t0) return;
        const t = Math.min(1, (now - t0) / DRAW_MS);
        const e = 1 - Math.pow(1 - t, 3);
        const target = dealerExtraQuad(this.m, i);
        const shoe = translateQuad(target, this.m.dealer.shoe[0] - centre(target)[0], this.m.dealer.shoe[1] - centre(target)[1]);
        const q = rotateQuad(lerpQuad(scaleQuad(shoe, 0.9), target, e), (1 - e) * -0.5);
        cards.push({ quad: q, cell: faceIndex(card), alpha: drawsAlpha * Math.min(1, t * 4), mode: "graphic" });
        if (t >= 1 && drawsAlpha > 0.5) dealerShown++;
      });
    }
    visible.dealer = dealerShown;
    return { plates, cards, visible, plateUse };
  }

  /**
   * A bridge is generated from frames whose seats were cleared to bare felt (the pipeline's
   * SeatCleaner): the two clips it joins hold different cards there, and interpolated cards
   * would morph and drift. So every seat shows a plate of the game's hand for the whole move,
   * where the round has it. Outside a round, it glides from where that hand lay on the clip it
   * leaves (each take's dealer put the first two cards a little differently) to where it lies on
   * the clip it lands in. The dealer's own two cards are in the bridge; their faces glide so.
   */
  bridge(clip: ClipInfo, f: number, view: TableView): SceneResult {
    const { from, at, to } = clip.bridge!;
    const A = this.m.clips[from];
    const B = this.m.clips[to];
    const home = view.home ? this.m.clips[clipName.wait(view.home)] : undefined;
    const t = (f + 1) / (clip.frames + 1);
    const tPrev = f / (clip.frames + 1);
    const plates: (PlateDraw | null)[] = [];
    const cards: CardDraw[] = [];
    const visible = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 } as SceneResult["visible"];
    const plateUse = { seat1: null, seat2: null, seat3: null } as SceneResult["plateUse"];
    for (const seat of this.m.seats) {
      const hand = view.seats[seat];
      const plate = this.plates[seat][hand.length];
      visible[seat] = hand.length;
      if (!plate) {
        plates.push(null);
        continue;
      }
      const h = home
        ? this.held(view, home, seat, hand.length)!
        : { plate, tex: this.plateTex[seat][plate.n], place: lerpSimilarity(placing(A, seat, plate), placing(B, seat, plate), t) };
      plates.push(plateDraw(h, 1, "whole"));
      plateUse[seat] = hand.length;
      h.plate.cards.forEach((q, i) => {
        if (hand[i]) cards.push({ quad: moveQuad(h.place, q), cell: faceIndex(hand[i]), alpha: 1, mode: "footage" });
      });
    }
    for (const slot of ["up", "hole"] as const) {
      const card = view.dealer[slot === "up" ? 0 : 1];
      const a = lying(A, at, slot).get(slot === "up" ? 1 : 2);
      const b = lying(B, 0, slot).get(slot === "up" ? 1 : 2);
      if (card && a && b) {
        cards.push({ quad: lerpQuad(a, b, t), prev: lerpQuad(a, b, tPrev), cell: faceIndex(card), alpha: 1, mode: "footage" });
        visible.dealer++;
      }
    }
    return { plates, cards, visible, plateUse };
  }
}

function plateDraw({ plate, tex, place }: Held, alpha: number, mode: PlateDraw["mode"]): PlateDraw {
  return { tex: tex.image, matte: tex.matte, rect: plate.rect, place, alpha, mode };
}

/**
 * Where a plate lies on a clip: its first two cards moved onto that clip's own first two in the
 * seat (wherever that take's dealer put them), so its other cards lie as they would on that take.
 * A clip without them takes the plate where it was grabbed.
 */
function placing(clip: ClipInfo, seat: SeatId, plate: SeatPlate): Similarity {
  const a = clip.cards.find((c) => c.slot === seat && c.index === 1);
  const b = clip.cards.find((c) => c.slot === seat && c.index === 2);
  return a && b && plate.cards.length >= 2 ? fitSimilarity(plate.cards.slice(0, 2), [a.quad, b.quad]) : IDENTITY;
}

/**
 * How much of a hand's laid-in cards (a seat's from the third on, the dealer's graphic draws)
 * shows: in a discard they are faded out by the frame her hand first comes over the hand (the
 * manifest's `reach`; else `lift`, its first pickup), but never start fading before the clip
 * does, as it follows its hold seamlessly. Anywhere else, all of them.
 */
function extrasAlpha(clip: ClipInfo, hand: SeatId | "dealer", n: number, f: number, lift: number): number {
  if (clip.kind !== "discard") return 1;
  const end = Math.max(EXTRAS_FADE, clip.reach?.[hand]?.[String(n)] ?? lift);
  const t = Math.min(1, Math.max(0, (end - f) / EXTRAS_FADE));
  return t * t * (3 - 2 * t);
}

/** Every card of this seat (from the `from`th on) that is face up on screen: lying, or still sliding in under her fingers. */
function footageFaces(clip: ClipInfo, seat: SeatId, hand: Card[], f: number, out: CardDraw[], from = 1) {
  for (const c of clip.cards) {
    const card = c.slot === seat && c.index >= from ? hand[c.index - 1] : undefined;
    const quad = card && faceQuadAt(c, f);
    if (!card || !quad) continue;
    out.push(footageFace(c, quad, f, faceIndex(card), faceFrom(c)));
  }
}

/** Where each slot's cards lie on a clip frame, by their place in the hand. */
function lying(clip: ClipInfo, frame: number, slot: string): Map<number, Quad> {
  const out = new Map<number, Quad>();
  for (const c of clip.cards) {
    if (c.slot !== slot || frame < c.in || frame >= c.out) continue;
    if (c.slot === "hole" && (c.flip === null || frame < c.flip)) continue;
    out.set(c.index, c.quad);
  }
  return out;
}

/** A face on a physical card, fading in from the frame it first shows face up (`from`) and out
 * as it is swept into the pile in her hand. */
function footageFace(c: FootageCard, quad: Quad, f: number, cell: number, from: number): CardDraw {
  const fadeIn = from >= 0 ? Math.min(1, (f - from + 1) / LAND_FADE) : 1;
  const alpha = Math.min(fadeIn, (faceUntil(c) - f) / LAND_FADE);
  // where the card was a frame ago, so a moving face gets the footage's motion blur
  const prev = f > from ? (faceQuadAt(c, f - 1) ?? quad) : quad;
  return { quad, prev, cell, alpha, mode: "footage" };
}

/** Whether this clip is the one placing cards on `seat` (its footage is then the truth). */
export function dealsTo(clip: ClipInfo, seat: SeatId) {
  if (clip.kind === "deal") return true;
  return clip.kind === "hit" && clip.seat === seat;
}
