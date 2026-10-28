import { type Hand, eraseTable } from "./eraser";
import type { RenderStyle } from "./types";

/**
 * The order the hands go in: the order she sweeps them up in every filmed discard (her own two
 * first, then the seats from her right, screen left to right), so the fade reads as the same
 * ritual as the filmed ending, only without her hands.
 */
export const FADE_ORDER: Hand[] = ["dealer", "seat1", "seat2", "seat3"];

/** Results on the table before anything goes: the badges pop (0.45 s) and are read. */
const READ_MS = 1800;
/** The whole clear: the last hand is gone by then. */
const DURATION = 950;
/** One hand's fade. Long enough to read as a dissolve, not a blink; short enough not to drag. */
export const HAND_MS = 600;
/**
 * Between one hand starting and the next: a wave, not a sequence. Fewer hands spread no wider
 * (two hands 350 ms apart read as two separate events), and the table just stays bare until the
 * clear is up.
 */
const STAGGER_MAX = 130;

/** When each hand that holds cards starts to fade, in ms from the start of the clear. */
export function fadeStarts(present: Hand[]): Partial<Record<Hand, number>> {
  const hands = FADE_ORDER.filter((h) => present.includes(h));
  const step = hands.length > 1 ? Math.min(STAGGER_MAX, (DURATION - HAND_MS) / (hands.length - 1)) : 0;
  return Object.fromEntries(hands.map((h, i) => [h, i * step]));
}

/**
 * How much of a hand is erased, `p` 0 -> 1 through its fade. A white card on dark felt stays
 * bright to the eye long after its alpha has dropped (lightness goes as about the cube root of
 * luminance): a linear or smoothstep alpha looks like it lingers and then snaps off. So the
 * coverage left is the square of an eased fall: soft out of rest, then nearly even in perceived
 * lightness, down to a faint ghost that thins away rather than cutting out.
 */
export function eraseCurve(p: number): number {
  const t = Math.min(1, Math.max(0, p));
  const e = t * t * (3 - 2 * t);
  return 1 - (1 - e) * (1 - e);
}

/** No cards move and nothing is drawn: each hand dissolves to bare felt where it lies. */
export const fade: RenderStyle = {
  timing: { readMs: READ_MS, duration: DURATION },
  apply(res, c, t, _now, ctx) {
    const present = FADE_ORDER.filter((h) => (h === "dealer" ? c.dealer : c.seats[h]).length > 0);
    const starts = fadeStarts(present);
    const ms = t * c.duration;
    const a = (h: Hand) => (t >= 1 ? 1 : eraseCurve((ms - (starts[h] ?? 0)) / HAND_MS));
    const erased = eraseTable(res, { seat1: a("seat1"), seat2: a("seat2"), seat3: a("seat3"), dealer: a("dealer") }, ctx);
    // The HUD keeps the hands as dealt until the table is empty: it fades with each hand in CSS
    // (FadeOverlay), and a total or the dealer's marker dropped at half-erased would pop off
    // mid-fade (and snap its pill to size) rather than fold away with its cards.
    return { ...erased, visible: res.visible };
  },
};
