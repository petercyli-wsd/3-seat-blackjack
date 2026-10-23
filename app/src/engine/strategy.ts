import { type Card, rankOf } from "./cards";
import { total } from "./rules";

const upValue = (c: Card) => {
  const r = rankOf(c);
  if (r === "A") return 11;
  if ("TJQK".includes(r)) return 10;
  return Number(r);
};

/** Basic strategy restricted to hit/stand — what the table plays for you on timeout. */
export function autoHit(hand: readonly Card[], dealerUp: Card): boolean {
  const { best, soft } = total(hand);
  const up = upValue(dealerUp);
  if (soft) {
    if (best <= 17) return true;
    if (best === 18) return up >= 9;
    return false;
  }
  if (best <= 11) return true;
  if (best === 12) return up <= 3 || up >= 7;
  if (best <= 16) return up >= 7;
  return false;
}
