import { eraseTable } from "./eraser";
import type { RenderStyle } from "./types";

/** STUB: every hand fades together. The fade's look is built in its own task. */
export const fade: RenderStyle = {
  timing: { readMs: 1500, duration: 600 },
  apply(res, _c, t, _now, ctx) {
    const a = t * t * (3 - 2 * t);
    return eraseTable(res, { seat1: a, seat2: a, seat3: a, dealer: a }, ctx);
  },
};
