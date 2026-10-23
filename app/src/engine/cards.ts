export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"] as const;
export const SUITS = ["S", "H", "D", "C"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

export const rankOf = (c: Card) => c[0] as Rank;
export const suitOf = (c: Card) => c[1] as Suit;
export const isRed = (c: Card) => suitOf(c) === "H" || suitOf(c) === "D";

export const RANK_LABEL: Record<Rank, string> = {
  A: "A", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7",
  "8": "8", "9": "9", T: "10", J: "J", Q: "Q", K: "K",
};
export const SUIT_GLYPH: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

/** Index into the 52-card face atlas: suit-major, rank-minor. */
export const faceIndex = (c: Card) => SUITS.indexOf(suitOf(c)) * 13 + RANKS.indexOf(rankOf(c));

export function freshDecks(n: number): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < n; d++) for (const s of SUITS) for (const r of RANKS) out.push(`${r}${s}`);
  return out;
}
