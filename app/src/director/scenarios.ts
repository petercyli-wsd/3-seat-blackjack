import type { Card } from "../engine/cards";
import type { SeatId } from "../media/manifest";

/**
 * Stacked decks for demoing specific footage paths. A scenario gives each
 * seat's two cards and the hits it will take, plus the dealer's hand; the
 * director lays them out in dealing order. If a seat plays differently from
 * the script the stack simply runs on in order, then the real shoe takes over.
 */
export interface Scenario {
  label: string;
  hint: string;
  seats?: Partial<Record<SeatId, { start: [Card, Card]; hits?: Card[] }>>;
  dealer?: { up: Card; hole: Card; draws?: Card[] };
}

const c = (s: string) => s.split(" ") as Card[];

export const SCENARIOS: Record<string, Scenario> = {
  random: { label: "Live shoe", hint: "8-deck CSPRNG shoe" },
  splitTable: {
    label: "Right 3 cards · left 5 cards",
    hint: "Seats 1 and 3: seat 3 hits once and stands, seat 1 hits three times — the mixed-hand case the seat plates exist for",
    seats: {
      seat3: { start: c("9S 3H") as [Card, Card], hits: c("6D") },
      seat1: { start: c("2C 3D") as [Card, Card], hits: c("2H 3S 4C") },
    },
    dealer: { up: "TS", hole: "7H" },
  },
  charlie: {
    label: "Six-card charlie",
    hint: "Every seat can hit to six small cards",
    seats: {
      seat3: { start: c("2S 3H") as [Card, Card], hits: c("2D 3C 2H 3D") },
      seat2: { start: c("AS 2C") as [Card, Card], hits: c("2S 3S AH 2C") },
      seat1: { start: c("3D 2H") as [Card, Card], hits: c("AC 2D 2H 2S") },
    },
    dealer: { up: "TS", hole: "7H" },
  },
  dealerSeven: {
    label: "Dealer draws to 7",
    hint: "Dealer shows A, then four more small cards",
    seats: {
      seat3: { start: c("TS 8H") as [Card, Card] },
      seat2: { start: c("9C 9D") as [Card, Card] },
      seat1: { start: c("KH 7S") as [Card, Card] },
    },
    dealer: { up: "AS", hole: "2H", draws: c("AD AC AH TS 2C") },
  },
  blackjacks: {
    label: "Blackjacks",
    hint: "Naturals on seats 1 and 3",
    seats: {
      seat3: { start: c("AS KH") as [Card, Card] },
      seat2: { start: c("8C 8D") as [Card, Card], hits: c("2H") },
      seat1: { start: c("QD AC") as [Card, Card] },
    },
    dealer: { up: "9S", hole: "7C", draws: c("5D") },
  },
  busts: {
    label: "Hit to bust",
    hint: "Every hit busts a stiff hand",
    seats: {
      seat3: { start: c("TS 6H") as [Card, Card], hits: c("KD") },
      seat2: { start: c("9C 5D") as [Card, Card], hits: c("8H") },
      seat1: { start: c("8S 7C") as [Card, Card], hits: c("QH") },
    },
    dealer: { up: "6S", hole: "TH", draws: c("9D") },
  },
};

export function stack(s: Scenario, order: SeatId[]): Card[] {
  if (!s.seats && !s.dealer) return [];
  const out: Card[] = [];
  const filler = "5C" as Card;
  for (const round of [0, 1]) {
    for (const seat of order) out.push(s.seats?.[seat]?.start[round] ?? filler);
    out.push((round === 0 ? s.dealer?.up : s.dealer?.hole) ?? filler);
  }
  for (const seat of order) out.push(...(s.seats?.[seat]?.hits ?? []));
  out.push(...(s.dealer?.draws ?? []));
  return out;
}
