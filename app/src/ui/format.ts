import type { Outcome } from "../engine/settle";
import type { SeatStatus } from "../director/store";

export const money = (n: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

export const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0));

export const STATUS_LABEL: Partial<Record<SeatStatus, string>> = {
  acting: "Your move",
  stood: "Stand",
  bust: "Bust",
  blackjack: "Blackjack",
  charlie: "6-Card Charlie",
  twentyone: "21",
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  blackjack: "Blackjack",
  charlie: "Charlie",
  win: "Win",
  push: "Push",
  lose: "Lose",
  bust: "Bust",
};

/** Seats are numbered left to right on screen; the dealer plays them right to left. */
export const seatNo = (id: string) => id.slice(-1);
