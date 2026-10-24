import { type Card, faceIndex } from "../engine/cards";
import type { PlayingState } from "../media/ClipPlayer";
import { type ClipInfo, type FootageCard, type Manifest, type Quad, type SeatId, cardsAt, faceFrom, faceQuadAt, faceUntil } from "../media/manifest";
import type { PlateSet } from "../media/plates";
import type { CardDraw, PlateDraw } from "./Compositor";
import { centre, lerpQuad, rotateQuad, scaleQuad, translateQuad } from "./homography";

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

const LAND_FADE = 3;
const DRAW_MS = 520;
const DISCARD_FADE = 5;

/** Graphic dealer cards go in a second row just in front of the two real ones. */
export function dealerExtraQuad(m: Manifest, i: number): Quad {
  const up = m.dealer.up;
  const c = centre(up);
  return scaleQuad(translateQuad(up, 735 + i * 26 - c[0], 402 - c[1]), 1.03);
}

export class Scene {
  constructor(
    private m: Manifest,
    private plates: PlateSet,
    private plateTex: Record<SeatId, Record<number, WebGLTexture>>,
  ) {}

  compute(s: PlayingState, view: TableView, now: number): SceneResult {
    const { clip, frame: f } = s;
    const plates: (PlateDraw | null)[] = [];
    const cards: CardDraw[] = [];
    const visible = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 } as SceneResult["visible"];
    const plateUse = { seat1: null, seat2: null, seat3: null } as SceneResult["plateUse"];

    for (const seat of this.m.seats) {
      const hand = view.seats[seat];
      // cards lying in the seat on this frame (one still sliding in doesn't count yet)
      const footage = cardsAt(clip, seat, f).length;
      let want = hand.length;
      let plateAlpha = 1;
      if (dealsTo(clip, seat)) {
        // this clip is putting cards down on this seat: the footage leads
        want = footage;
      } else if (clip.kind === "discard") {
        const filmed = clip.cards.filter((c) => c.slot === seat);
        const lastOut = Math.max(-1, ...filmed.map((c) => c.out));
        if (filmed.length === hand.length) {
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
        plates.push({ tex: this.plateTex[seat][want], rect: plate.rect, alpha: plateAlpha });
        plateUse[seat] = want;
        plate.cards.forEach((q, i) => {
          if (hand[i]) cards.push({ quad: q, cell: faceIndex(hand[i]), alpha: plateAlpha, mode: "footage" });
        });
        visible[seat] = plateAlpha > 0.5 ? want : 0;
      } else {
        plates.push(null);
        // every card of this seat that is face up on screen: lying, or still sliding in under her fingers
        for (const c of clip.cards) {
          const card = c.slot === seat ? hand[c.index - 1] : undefined;
          const quad = card && faceQuadAt(c, f);
          if (!card || !quad) continue;
          cards.push(footageFace(c, quad, f, faceIndex(card), faceFrom(c)));
        }
        visible[seat] = Math.min(footage, hand.length);
      }
    }

    // dealer: the up card and the hole card are real; the up card's face rides in with it,
    // the hole shows its face once flipped
    let dealerShown = 0;
    for (const c of clip.cards) {
      const card = c.slot === "up" || c.slot === "hole" ? view.dealer[c.index - 1] : undefined;
      if (!card) continue;
      const hole = c.slot === "hole";
      const quad = !hole || (c.flip !== null && c.flip <= f) ? faceQuadAt(c, f) : null;
      if (!quad) continue;
      cards.push(footageFace(c, quad, f, faceIndex(card), hole ? (c.flip as number) : faceFrom(c)));
      if (f >= c.in) dealerShown++;
    }
    // graphic draws: on the table from when they leave the shoe until the real cards are swept
    const upCard = clip.cards.find((c) => c.slot === "up");
    let extrasAlpha = 1;
    if (clip.kind === "discard" && upCard) extrasAlpha = 1 - (f - upCard.out) / DISCARD_FADE;
    if (["deal", "hit", "idle"].includes(clip.kind)) extrasAlpha = 0;
    if (extrasAlpha > 0) {
      view.dealer.slice(2).forEach((card, i) => {
        const t0 = view.dealerDrawAt[i];
        if (t0 === undefined || now < t0) return;
        const t = Math.min(1, (now - t0) / DRAW_MS);
        const e = 1 - Math.pow(1 - t, 3);
        const target = dealerExtraQuad(this.m, i);
        const shoe = translateQuad(target, this.m.dealer.shoe[0] - centre(target)[0], this.m.dealer.shoe[1] - centre(target)[1]);
        const q = rotateQuad(lerpQuad(scaleQuad(shoe, 0.9), target, e), (1 - e) * -0.5);
        cards.push({ quad: q, cell: faceIndex(card), alpha: Math.min(1, extrasAlpha) * Math.min(1, t * 4), mode: "graphic" });
        if (t >= 1) dealerShown++;
      });
    }
    visible.dealer = dealerShown;
    return { plates, cards, visible, plateUse };
  }
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
