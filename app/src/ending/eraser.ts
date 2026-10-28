import { type Quad, type SeatId, faceQuadAt } from "../media/manifest";
import type { CardDraw } from "../render/Compositor";
import { centre, scaleQuad, translateQuad } from "../render/homography";
import { type SceneResult, dealerExtraQuad } from "../render/scene";
import { HANDS, type Hand } from "./erasePass";
import type { EndingContext } from "./types";

export { HANDS, type Hand } from "./erasePass";

/** How much of each hand's real cards is hidden: 0 = as composited, 1 = bare felt. */
export interface EraseAlpha {
  seat1: number;
  seat2: number;
  seat3: number;
  dealer: number;
}

export const ERASE_NONE: EraseAlpha = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 };
export const ERASE_ALL: EraseAlpha = { seat1: 1, seat2: 1, seat3: 1, dealer: 1 };

/** Graphic dealer draws the game may lay out (dealerExtraQuad's row): where the dealer's hand reaches. */
const DEALER_DRAWS = 6;
/** How near (px) a card's centre must be to the dealer's spots, or a seat's mask box, to count as that hand's. */
const DEALER_REACH = 30;
const SEAT_REACH = 24;

/**
 * Which hand a card on the table belongs to, by where it lies: a seat's (its centre in that
 * seat's mask, or just past its box, as a plate's card moved onto another take can be), or the
 * dealer's (on or by her two cards' spots, or in the row her graphic draws go in). Null for
 * anything else (a card in flight, a pass entry).
 */
export function handOfCard(card: CardDraw, ctx: EndingContext): Hand | null {
  if (card.pass) return null;
  const [x, y] = centre(card.quad);
  const seat = ctx.eraser.seatAt(x, y);
  if (seat) return seat;
  const spots = [ctx.m.dealer.up, ctx.m.dealer.hole, ...Array.from({ length: DEALER_DRAWS }, (_, i) => dealerExtraQuad(ctx.m, i))];
  if (spots.some((q) => Math.hypot(centre(q)[0] - x, centre(q)[1] - y) < DEALER_REACH)) return "dealer";
  let best: SeatId | null = null;
  let near = SEAT_REACH;
  for (const s of ctx.m.seats) {
    const [rx, ry, rw, rh] = ctx.eraser.seatRect(s);
    const d = Math.hypot(Math.max(rx - x, 0, x - rx - rw), Math.max(ry - y, 0, y - ry - rh));
    if (d < near) {
      near = d;
      best = s;
    }
  }
  return best;
}

/**
 * Outlines erased in this clear so far, per footage clip: a hand's laid-in cards (its hits, the
 * dealer's graphic draws) are gone from the scene once the clear is done and the game empties the
 * table, but the hold goes on; the felt where they lay stays the bare plate's, not the footage's,
 * so nothing shifts there at that moment.
 */
let sticky: { clip: string; quads: Map<string, { quad: Quad; hand: number }> } | null = null;

/**
 * Hide the real cards on the table, hand by hand, leaving bare felt and her arms in front as
 * filmed: the blank cards in the footage, their faces, any plate laid in for the hand (its hits,
 * or the whole hand) and the dealer's graphic draws, with their contact shadows. Each hand is
 * crossfaded as one picture into the bare table (erasePass.ts) lit as the frame is, so at any `a`
 * the hand is exactly (1 - a) of itself over a of the felt it lies on.
 *
 * It works through an entry it adds to the cards (CardDraw.pass): a style may lay its own cards
 * after it (over the bare table) but must keep the entry where it is, and not filter it out. A
 * fully erased hand's cards and plate are dropped from the result. `visible` (what the HUD shows)
 * is left as it was: when the hand leaves the HUD is the style's to say.
 */
export function eraseTable(res: SceneResult, a: EraseAlpha, ctx: EndingContext): SceneResult {
  const alpha = HANDS.map((h) => Math.min(1, Math.max(0, a[h] || 0))) as [number, number, number, number];
  const st = ctx.footage();
  // A bridge out of the hold (to the betting loop) is generated from frames with the table cleared,
  // but the real cards lie where the hold has them until it is gone: it counts as the clip it leaves.
  const leaving = st?.clip.bridge;
  const src = leaving ? { clip: ctx.m.clips[leaving.from], frame: leaving.at, name: leaving.from } : st;
  const clip = src?.name ?? "";
  if (alpha.every((v) => v <= 0)) {
    sticky = null;
    return res;
  }
  const handOf = new Map<CardDraw, Hand | null>(res.cards.map((c) => [c, handOfCard(c, ctx)]));
  const of = (c: CardDraw) => handOf.get(c) ?? null;
  if (!ctx.eraser.ready) {
    // the bare plate isn't in yet (only in the first seconds after the table opens): the faces at least
    return {
      ...res,
      cards: res.cards.map((c) => {
        const h = of(c);
        return h ? { ...c, alpha: c.alpha * (1 - alpha[HANDS.indexOf(h)]) } : c;
      }),
    };
  }

  // (cards a style moves through the erase would pile up outlines: past what a pass takes, start again)
  if (sticky?.clip !== clip || sticky.quads.size > 32) sticky = { clip, quads: new Map() };
  const add = (quad: Quad, hand: number) => {
    const [x, y] = centre(quad);
    const key = `${hand}/${Math.round(x)}/${Math.round(y)}/${Math.round(quad[1][0] - quad[0][0])}`;
    if (!sticky!.quads.has(key)) sticky!.quads.set(key, { quad, hand });
  };
  for (const c of res.cards) {
    const h = of(c);
    if (!h) continue;
    // a graphic card's shadow (Compositor.drawCards) is pushed toward the camera and widened
    add(c.mode === "graphic" ? scaleQuad(translateQuad(c.quad, 1.5, 2.5), 1.25) : c.quad, HANDS.indexOf(h));
  }
  // the real cards lying in the footage, faced or not (once the game has emptied the table the
  // scene draws nothing on them, but they are still there until the cut)
  if (src?.clip) {
    const f = src.frame;
    for (const c of src.clip.cards) {
      if (f < c.in || f >= c.out) continue;
      const quad = faceQuadAt(c, f) ?? c.rests?.findLast((r) => f >= r.from)?.quad ?? c.quad;
      add(quad, HANDS.indexOf(c.slot === "up" || c.slot === "hole" ? "dealer" : c.slot));
    }
  }

  // A seat laid in whole from a hand's plate covers its whole mask, which goes with it. The empty
  // seat's plate (index 0, laid once the game has emptied the table) only hides the footage's
  // cards, which are erased anyway; its felt is lit as another frame was, so at a = 1 it goes with
  // the rest, in favour of the pass's.
  const whole = ctx.m.seats.map((s, i) => {
    const p = res.plates[i];
    return !!p && p.mode !== "extras" && (res.plateUse[s] ?? 0) > 0;
  }) as [boolean, boolean, boolean];
  const plates = res.plates.map((p, i) => (alpha[i] >= 1 ? null : p));
  const cards = res.cards.filter((c) => {
    const h = of(c);
    return !h || alpha[HANDS.indexOf(h)] < 1;
  });
  cards.push(ctx.eraser.entry({ alpha, quads: [...sticky.quads.values()], whole }));
  return { ...res, plates, cards };
}
