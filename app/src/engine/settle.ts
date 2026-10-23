import type { Card } from "./cards";
import { RULES, isBlackjack, isBust, isCharlie, total } from "./rules";

export type Outcome = "blackjack" | "charlie" | "win" | "push" | "lose" | "bust";

export interface Settlement {
  outcome: Outcome;
  /** Amount returned to the player, stake included (0 on a loss). */
  payout: number;
}

export function settle(player: readonly Card[], dealer: readonly Card[], bet: number): Settlement {
  const pBJ = isBlackjack(player);
  const dBJ = isBlackjack(dealer);
  if (isBust(player)) return { outcome: "bust", payout: 0 };
  if (pBJ && dBJ) return { outcome: "push", payout: bet };
  if (pBJ) return { outcome: "blackjack", payout: bet + bet * RULES.blackjackPays };
  if (dBJ) return { outcome: "lose", payout: 0 };
  if (isCharlie(player)) return { outcome: "charlie", payout: bet * 2 };
  const p = total(player).best;
  const d = total(dealer).best;
  if (d > 21 || p > d) return { outcome: "win", payout: bet * 2 };
  if (p === d) return { outcome: "push", payout: bet };
  return { outcome: "lose", payout: 0 };
}
