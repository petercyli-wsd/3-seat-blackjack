import type { SceneResult } from "../render/scene";
import type { EndingContext } from "./types";

/** How much of each hand's real cards is hidden: 0 = as composited, 1 = bare felt. */
export interface EraseAlpha {
  seat1: number;
  seat2: number;
  seat3: number;
  dealer: number;
}

export const ERASE_NONE: EraseAlpha = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 };
export const ERASE_ALL: EraseAlpha = { seat1: 1, seat2: 1, seat3: 1, dealer: 1 };

/**
 * Hide the real cards on the table (the blank cards in the footage, their faces and any laid-in
 * plate of the hand), hand by hand, leaving bare felt and her arms in front as filmed.
 *
 * STUB: fades the faces only; the physical cards stay. The eraser is built in its own task.
 */
export function eraseTable(res: SceneResult, a: EraseAlpha, _ctx: EndingContext): SceneResult {
  const k = 1 - Math.max(a.seat1, a.seat2, a.seat3, a.dealer);
  return { ...res, cards: res.cards.map((c) => ({ ...c, alpha: c.alpha * k })) };
}
