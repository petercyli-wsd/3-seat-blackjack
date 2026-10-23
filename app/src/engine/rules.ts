import { type Card, rankOf } from "./cards";

export const RULES = {
  decks: 8,
  cutCardMin: 60,
  cutCardMax: 80,
  /** Six cards without busting stands automatically and wins (dealer blackjack still beats it). */
  charlieCards: 6,
  dealerStandsOn: 17,
  dealerMaxCards: 7,
  blackjackPays: 1.5,
  minBet: 1,
  maxBet: 5000,
} as const;

const VALUE: Record<string, number> = {
  A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 10, Q: 10, K: 10,
};

export interface Total {
  best: number;
  soft: boolean;
}

/** Best total ≤ 21 if reachable; at most one ace can count 11. */
export function total(cards: readonly Card[]): Total {
  let hard = 0;
  let ace = false;
  for (const c of cards) {
    hard += VALUE[rankOf(c)];
    if (rankOf(c) === "A") ace = true;
  }
  if (ace && hard + 10 <= 21) return { best: hard + 10, soft: true };
  return { best: hard, soft: false };
}

export const isBlackjack = (cards: readonly Card[]) => cards.length === 2 && total(cards).best === 21;
export const isBust = (cards: readonly Card[]) => total(cards).best > 21;
export const isCharlie = (cards: readonly Card[]) => cards.length >= RULES.charlieCards && !isBust(cards);

/** The player's turn is over without a decision: bust, 21, blackjack or charlie. */
export const handFinished = (cards: readonly Card[]) =>
  isBust(cards) || total(cards).best === 21 || cards.length >= RULES.charlieCards;

/** Stands on all 17s, and on reaching the card limit whatever the total. */
export const dealerDraws = (cards: readonly Card[]) =>
  cards.length < RULES.dealerMaxCards && total(cards).best < RULES.dealerStandsOn;

export const label = (cards: readonly Card[]) => {
  if (!cards.length) return "";
  if (isBlackjack(cards)) return "BJ";
  const t = total(cards);
  if (t.best > 21) return String(t.best);
  return t.soft && t.best !== 21 ? `${t.best - 10}/${t.best}` : String(t.best);
};
