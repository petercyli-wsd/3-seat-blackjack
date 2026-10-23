import { type Card, faceIndex } from "../engine/cards";
import type { PlayingState } from "../media/ClipPlayer";
import { type ClipInfo, type Manifest, type Quad, type SeatId, cardsAt } from "../media/manifest";
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
      const onTable = cardsAt(clip, seat, f);
      const footage = onTable.length;
      let want = hand.length;
      let plateAlpha = 1;
      if (dealsTo(clip, seat)) {
        // this clip is putting cards down on this seat: the footage leads
        want = footage;
      } else if (clip.kind === "discard") {
        const lastOut = Math.max(-1, ...clip.cards.filter((c) => c.slot === seat).map((c) => c.out));
        if (footage === 0 && f >= lastOut) {
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
        for (const c of onTable) {
          const card = hand[c.index - 1];
          if (!card) continue;
          const alpha = c.in >= 0 ? Math.min(1, (f - c.in + 1) / LAND_FADE) : 1;
          cards.push({ quad: c.quad, cell: faceIndex(card), alpha, mode: "footage" });
        }
        visible[seat] = Math.min(footage, hand.length);
      }
    }

    // dealer: the up card and the hole card are real; the hole shows its face once flipped
    const dealerOnTable = clip.cards.filter((c) => (c.slot === "up" || c.slot === "hole") && c.in <= f && f < c.out);
    let dealerShown = 0;
    for (const c of dealerOnTable) {
      const card = view.dealer[c.index - 1];
      if (!card) continue;
      if (c.slot === "hole" && (c.flip === null || f < c.flip)) continue;
      const from = c.slot === "hole" ? (c.flip as number) : c.in;
      const alpha = from >= 0 ? Math.min(1, (f - from + 1) / LAND_FADE) : 1;
      cards.push({ quad: c.quad, cell: faceIndex(card), alpha, mode: "footage" });
      dealerShown++;
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

/** Whether this clip is the one placing cards on `seat` (its footage is then the truth). */
export function dealsTo(clip: ClipInfo, seat: SeatId) {
  if (clip.kind === "deal") return true;
  return clip.kind === "hit" && clip.seat === seat;
}
