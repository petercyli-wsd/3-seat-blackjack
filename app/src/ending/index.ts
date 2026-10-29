import type { SceneResult } from "../render/scene";
import { collect } from "./collect";
import { fade } from "./fade";
import { board, panel } from "./panel";
import type { Clear, Clearing, EndingContext, RenderStyle, Timing } from "./types";

const STYLES: Record<Clear, RenderStyle> = { fade, panel, collect, board };

export const timing = (style: Clear): Timing => STYLES[style].timing;

/** The composite with the round's ending applied: unchanged outside a no-discard clear. */
export function applyEnding(res: SceneResult, c: Clearing | null, now: number, ctx: EndingContext): SceneResult {
  if (!c) return res;
  const t = c.done ? 1 : Math.min(1, Math.max(0, (now - c.startedAt) / c.duration));
  return STYLES[c.style].apply(res, c, t, now, ctx);
}
