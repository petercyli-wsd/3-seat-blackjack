import { eraseTable } from "./eraser";
import type { RenderStyle } from "./types";

/** STUB: a plain fade until the collect animation is built in its own task. */
export const collect: RenderStyle = {
  timing: { readMs: 1500, duration: 1200 },
  apply(res, _c, t, _now, ctx) {
    return eraseTable(res, { seat1: t, seat2: t, seat3: t, dealer: t }, ctx);
  },
};
