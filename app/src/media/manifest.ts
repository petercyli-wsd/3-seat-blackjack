export type Pt = [number, number];
/** Face TL, TR, BR, BL in source video pixels (TL->TR is the face's top edge). */
export type Quad = [Pt, Pt, Pt, Pt];

export type SeatId = "seat1" | "seat2" | "seat3";
export type Slot = SeatId | "up" | "hole";
export type ClipKind = "idle" | "deal" | "wait" | "reveal" | "hold" | "discard" | "hit";

/** A physical card visible during a clip; frames are clip-relative (may lie outside the clip). */
export interface FootageCard {
  slot: Slot;
  /** 1-based position in its hand (dealer: up = 1, hole = 2). */
  index: number;
  in: number;
  out: number;
  flip: number | null;
  faceDown: boolean;
  quad: Quad;
  /** Outline per frame while the dealer slides it in face up: quads[i] is frame from + i, up to `in`. */
  path?: { from: number; quads: Quad[] };
  /** From the frame it starts to be swept up: its outline while it moves on its own (quads[i] is frame from + i), then none. */
  away?: { from: number; quads: Quad[] };
}

export interface ClipInfo {
  file: string;
  kind: ClipKind;
  frames: number;
  sourceStart: number;
  cards: FootageCard[];
  loop?: string;
  loopFrames?: number;
  /** The loop plays only clip frames loopFrom..loopTo-1 (an idle's calm stretch); absent = the whole clip. */
  loopFrom?: number;
  loopTo?: number;
  still: number;
  mask?: string;
  seat?: SeatId;
  card?: number;
  part?: number;
}

export interface Plate {
  clip: string;
  frame: number;
  cards: Quad[];
}

export interface Manifest {
  fps: number;
  width: number;
  height: number;
  seats: SeatId[];
  playOrder: SeatId[];
  masks: string;
  dealer: { up: Quad; hole: Quad; shoe: Pt; discardTray: Pt };
  plates: Record<SeatId, Record<string, Plate>>;
  clips: Record<string, ClipInfo>;
}

/** game_assets/ is the dev server's public dir (see vite.config.ts). */
export const ASSET_BASE = "/";

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch(`${ASSET_BASE}manifest.json`);
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status} — run the pipeline first (see README)`);
  return r.json();
}

/** Footage cards of one slot that are on the table at a clip frame. */
export const cardsAt = (clip: ClipInfo, slot: Slot, frame: number) =>
  clip.cards.filter((c) => c.slot === slot && c.in <= frame && frame < c.out);

/** First clip frame the card shows its face up: where its slide-in path starts, else where it lands. */
export const faceFrom = (c: FootageCard) => (c.path?.quads.length ? c.path.from : c.in);

/** Frame the card's face stops showing: when it is no longer followed after leaving its resting place. */
export const faceUntil = (c: FootageCard) => (c.away ? c.away.from + c.away.quads.length : c.out);

/** The card's outline at a clip frame while it is face up on screen (sliding in, lying, being swept off), else null. */
export function faceQuadAt(c: FootageCard, frame: number): Quad | null {
  if (c.away && frame >= c.away.from) return c.away.quads[frame - c.away.from] ?? null;
  if (frame >= c.out) return null;
  if (frame >= c.in) return c.quad;
  const i = c.path ? frame - c.path.from : -1;
  return c.path && i >= 0 && i < c.path.quads.length ? c.path.quads[i] : null;
}

/** The clip frames a loop file ping-pongs over: from, from + 1, ..., from + n - 1 and back. */
export const loopSpan = (c: ClipInfo) => {
  const from = c.loopFrom ?? 0;
  return { from, n: (c.loopTo ?? c.frames) - from };
};

/** Clip names, by the conventions the pipeline writes. */
export const clipName = {
  openingIdle: "opening_idle",
  deal: (mask: string) => `${mask}_deal`,
  wait: (mask: string) => `${mask}_wait`,
  reveal: (mask: string) => `${mask}_reveal`,
  hold: (mask: string) => `${mask}_hold`,
  discard: (mask: string) => `${mask}_discard`,
  idle: (mask: string) => `${mask}_idle`,
  hit: (seat: SeatId, card: number) => `${seat}_card${card}_deal`,
  hitWait: (seat: SeatId, card: number) => `${seat}_card${card}_wait`,
};

/** The clip that follows `name` in the original take, if any (a seamless continuation). */
export function naturalNext(m: Manifest, name: string): string | undefined {
  const c = m.clips[name];
  const end = c.sourceStart + c.frames;
  return Object.keys(m.clips).find((k) => m.clips[k].sourceStart === end);
}
