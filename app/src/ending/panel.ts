import { ERASE_ALL, eraseTable } from "./eraser";
import type { RenderStyle } from "./types";

/**
 * The results panel's clock, in ms from the clear's start: PanelOverlay.tsx moves the panel by
 * it, apply() below clears the table under it by the same numbers.
 */
export const PANEL = {
  /** The panel rises over the table's cards (it is opaque from the end of this)... */
  riseMs: 620,
  /** ...and only then, with a few frames' slack for the DOM to catch up, is the table cleared
   * under it: a soft ramp, so not even the blur behind the glass changes at once. */
  eraseFrom: 620 + 180,
  eraseMs: 520,
  /** The panel leaves once betting has reopened (the footage is on the betting loop by then)... */
  exitMs: 440,
  /** ...and "Place your bets" comes in as it goes. */
  handoverMs: 1200,
};

const smooth = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * No discard: a results panel (PanelOverlay.tsx) rises over the table's cards after a short read
 * of the result, the table is cleared under it, and it stays up through the cut to the betting
 * loop. The composite is the footage as it is until the panel covers the cards.
 */
export const panel: RenderStyle = {
  // readMs: the dealer's last card and her total have a beat on the table before the panel
  // takes over; duration: the panel holds at least this long (plus the wait for the cut)
  timing: { readMs: 700, duration: 2600 },
  apply(res, c, t, _now, ctx) {
    const k = smooth((t * c.duration - PANEL.eraseFrom) / PANEL.eraseMs);
    if (k <= 0) return res;
    return eraseTable(res, k >= 1 ? ERASE_ALL : { seat1: k, seat2: k, seat3: k, dealer: k }, ctx);
  },
};
