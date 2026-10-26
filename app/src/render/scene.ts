import { type Card, faceIndex } from "../engine/cards";
import type { PlayingState } from "../media/ClipPlayer";
import { type ClipInfo, type FootageCard, type Manifest, type Quad, type SeatId, cardsAt, faceFrom, faceQuadAt, faceUntil } from "../media/manifest";
import type { PlateSet, SeatPlate } from "../media/plates";
import type { CardDraw, PlateDraw } from "./Compositor";
import { IDENTITY, type Similarity, centre, fitSimilarity, lerpQuad, lerpSimilarity, moveQuad, rotateQuad, scaleQuad, translateQuad } from "./homography";

/** What the game says is on the table; the scene decides how to show it on the current frame. */
export interface TableView {
  seats: Record<SeatId, Card[]>;
  dealer: Card[];
  /** performance.now() at which each graphic dealer card (3rd onwards) left the shoe. */
  dealerDrawAt: number[];
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
export type PlateTextures = Record<SeatId, Record<number, { image: WebGLTexture; matte: WebGLTexture }>>;

const LAND_FADE = 3;
const DRAW_MS = 520;
const DISCARD_FADE = 5;
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
  ) {}

  compute(s: PlayingState, view: TableView, now: number): SceneResult {
    if (s.clip.bridge) return this.bridge(s.clip, s.frame, view);
    const { clip, frame: f } = s;
    const plates: (PlateDraw | null)[] = [];
    const cards: CardDraw[] = [];
    const visible = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 } as SceneResult["visible"];
    const plateUse = { seat1: null, seat2: null, seat3: null } as SceneResult["plateUse"];

    for (const seat of this.m.seats) {
      const hand = view.seats[seat];
      // cards lying in the seat on this frame (one still sliding in doesn't count yet)
      const footage = cardsAt(clip, seat, f).length;
      const own = clip.cards.filter((c) => c.slot === seat);

      if (!dealsTo(clip, seat) && hand.length >= 2 && own.length === 2 && own.every((c) => c.index <= 2)) {
        // The take holds this hand's first two cards: they are the real ones, as filmed (and swept
        // up as filmed in a discard). A bigger hand's other cards are laid in from its plate, moved
        // onto these two; she can't pick those up, so in a discard they fade out just before her
        // hand comes over the hand.
        footageFaces(clip, seat, hand, f, cards);
        visible[seat] = Math.min(footage, hand.length);
        const plate = hand.length > 2 ? this.plates[seat][hand.length] : undefined;
        const alpha = plate ? extrasAlpha(clip, seat, hand.length, f, Math.min(...own.map((c) => c.out))) : 0;
        if (plate && alpha > 0) {
          const place = placing(clip, seat, plate);
          plates.push(this.plateDraw(seat, plate, place, alpha, true));
          plateUse[seat] = plate.n;
          plate.cards.slice(2).forEach((q, i) => {
            cards.push({ quad: moveQuad(place, q), cell: faceIndex(hand[i + 2]), alpha, mode: "footage" });
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
        plates.push(this.plateDraw(seat, plate, place, plateAlpha, false));
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
   * gliding from where that hand lay on the clip it leaves (each take's dealer put the first two
   * cards a little differently) to where it lies on the clip it lands in. The dealer's own two
   * cards are in the bridge; their faces glide the same way.
   */
  bridge(clip: ClipInfo, f: number, view: TableView): SceneResult {
    const { from, at, to } = clip.bridge!;
    const A = this.m.clips[from];
    const B = this.m.clips[to];
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
      const place = lerpSimilarity(placing(A, seat, plate), placing(B, seat, plate), t);
      plates.push(this.plateDraw(seat, plate, place, 1, false));
      plateUse[seat] = hand.length;
      plate.cards.forEach((q, i) => {
        if (hand[i]) cards.push({ quad: moveQuad(place, q), cell: faceIndex(hand[i]), alpha: 1, mode: "footage" });
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

  private plateDraw(seat: SeatId, plate: SeatPlate, place: Similarity, alpha: number, extrasOnly: boolean): PlateDraw {
    const tex = this.plateTex[seat][plate.n];
    return { tex: tex.image, matte: tex.matte, rect: plate.rect, place, alpha, extrasOnly };
  }
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

/** Every card of this seat that is face up on screen: lying, or still sliding in under her fingers. */
function footageFaces(clip: ClipInfo, seat: SeatId, hand: Card[], f: number, out: CardDraw[]) {
  for (const c of clip.cards) {
    const card = c.slot === seat ? hand[c.index - 1] : undefined;
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
