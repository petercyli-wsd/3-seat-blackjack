import type { Card } from "../engine/cards";
import type { Manifest, SeatId } from "../media/manifest";
import type { PlateSet } from "../media/plates";
import type { ClipLoader } from "../media/preload";
import type { Compositor } from "../render/Compositor";
import type { PlateTextures, SceneResult } from "../render/scene";

/**
 * How a round ends. "discard" is the filmed one: she sweeps the cards up (the take's own discard
 * clip). The others never play discard footage: she stays at rest, the table is cleared by the
 * game, and the footage goes from her rest after the reveal straight back to the betting loop.
 */
export type Ending = "discard" | "fade" | "panel" | "collect";
export type Clear = Exclude<Ending, "discard">;

export const ENDINGS: Record<Ending, { label: string; hint: string }> = {
  discard: { label: "Discard", hint: "She sweeps the cards up, as filmed" },
  fade: { label: "Fade", hint: "No discard: the cards fade from the table" },
  panel: { label: "Results", hint: "No discard: a results panel covers the table while it clears" },
  collect: { label: "Collect", hint: "No discard: the cards gather and slide into the discard holder" },
};

export const ENDING_IDS = Object.keys(ENDINGS) as Ending[];

/** What the render hook (and the overlays) see while a no-discard ending runs. */
export interface Clearing {
  style: Clear;
  /** performance.now() when the clear started (after the results have been read). */
  startedAt: number;
  /** ms from startedAt until the table is empty. */
  duration: number;
  /** The round's hands as the clear began: the game empties its own state once the clear is done. */
  seats: Record<SeatId, Card[]>;
  dealer: Card[];
  /** The round's take (seat mask): the footage on screen is its hold loop until the cut to betting. */
  mask: string;
  /** The table is empty: every real card stays hidden until the footage has left the hold. */
  done: boolean;
}

/** When a style runs, in ms: a read of the results before it starts, then the clear itself. */
export interface Timing {
  readMs: number;
  duration: number;
}

/** What a style may use to draw: built once in table.ts. */
export interface EndingContext {
  m: Manifest;
  plates: PlateSet;
  plateTex: PlateTextures;
  compositor: Compositor;
  files: ClipLoader;
  host: HTMLElement;
}

/** A style's part in the composite: given the scene as the footage and game show it, what to draw. */
export interface RenderStyle {
  timing: Timing;
  /** t: 0 -> 1 over the clear (1 once done). */
  apply(res: SceneResult, c: Clearing, t: number, now: number, ctx: EndingContext): SceneResult;
}
