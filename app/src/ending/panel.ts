import { ERASE_ALL, eraseTable } from "./eraser";
import type { RenderStyle } from "./types";

/** STUB: the table empties at once halfway through, under the panel (PanelOverlay.tsx). */
export const panel: RenderStyle = {
  timing: { readMs: 300, duration: 2400 },
  apply(res, _c, t, _now, ctx) {
    return t >= 0.5 ? eraseTable(res, ERASE_ALL, ctx) : res;
  },
};
