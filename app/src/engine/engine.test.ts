import { describe, expect, it } from "vitest";
import type { Card } from "./cards";
import { dealerDraws, handFinished, isBlackjack, isCharlie, label, total } from "./rules";
import { settle } from "./settle";
import { Shoe } from "./shoe";
import { seededRng } from "./rng";
import { autoHit } from "./strategy";

const h = (...c: string[]) => c as Card[];

describe("totals", () => {
  it("counts one ace as 11 when it fits", () => {
    expect(total(h("AS", "6D"))).toEqual({ best: 17, soft: true });
    expect(total(h("AS", "6D", "9C"))).toEqual({ best: 16, soft: false });
    expect(total(h("AS", "AD", "9C"))).toEqual({ best: 21, soft: true });
    expect(total(h("KS", "QD", "2C"))).toEqual({ best: 22, soft: false });
  });
  it("labels soft hands both ways", () => {
    expect(label(h("AS", "6D"))).toBe("7/17");
    expect(label(h("AS", "KD"))).toBe("BJ");
    expect(label(h("AS", "5D", "5C"))).toBe("21");
  });
});

describe("turn end", () => {
  it("ends on bust, 21 and six cards", () => {
    expect(handFinished(h("KS", "QD", "2C"))).toBe(true);
    expect(handFinished(h("7S", "7D", "7C"))).toBe(true);
    expect(handFinished(h("2S", "2D", "2C", "2H", "3S", "3D"))).toBe(true);
    expect(handFinished(h("2S", "2D", "2C", "2H", "3S"))).toBe(false);
    expect(isCharlie(h("2S", "2D", "2C", "2H", "3S", "3D"))).toBe(true);
  });
});

describe("dealer", () => {
  it("stands on all 17s and at seven cards", () => {
    expect(dealerDraws(h("AS", "6D"))).toBe(false);
    expect(dealerDraws(h("TS", "6D"))).toBe(true);
    expect(dealerDraws(h("AS", "AD", "AC", "AH", "2S", "2D", "2C"))).toBe(false);
  });
});

describe("settlement", () => {
  it("pays blackjack 3:2 and pushes blackjack vs blackjack", () => {
    expect(settle(h("AS", "KD"), h("9S", "8D"), 10)).toEqual({ outcome: "blackjack", payout: 25 });
    expect(settle(h("AS", "KD"), h("AH", "QD"), 10)).toEqual({ outcome: "push", payout: 10 });
  });
  it("charlie beats a 21 but not a dealer blackjack", () => {
    const six = h("2S", "2D", "2C", "2H", "3S", "3D");
    expect(settle(six, h("TS", "5D", "6C"), 10).outcome).toBe("charlie");
    expect(settle(six, h("AS", "KD"), 10).outcome).toBe("lose");
  });
  it("bust loses even when the dealer busts", () => {
    expect(settle(h("KS", "QD", "5C"), h("KH", "6D", "TC"), 10)).toEqual({ outcome: "bust", payout: 0 });
  });
  it("compares standing totals", () => {
    expect(settle(h("KS", "8D"), h("KH", "7D"), 10).payout).toBe(20);
    expect(settle(h("KS", "7D"), h("KH", "7D"), 10).payout).toBe(10);
    expect(settle(h("KS", "6D"), h("KH", "7D"), 10).payout).toBe(0);
  });
  it("detects naturals only on two cards", () => {
    expect(isBlackjack(h("AS", "5D", "5C"))).toBe(false);
  });
});

describe("strategy", () => {
  it("plays basic hit/stand", () => {
    expect(autoHit(h("TS", "2D"), "4C" as Card)).toBe(false);
    expect(autoHit(h("TS", "2D"), "2C" as Card)).toBe(true);
    expect(autoHit(h("TS", "6D"), "7C" as Card)).toBe(true);
    expect(autoHit(h("AS", "7D"), "9C" as Card)).toBe(true);
    expect(autoHit(h("AS", "7D"), "8C" as Card)).toBe(false);
  });
});

describe("shoe", () => {
  it("deals forced cards first and is deterministic under a seed", () => {
    const a = new Shoe(seededRng(7));
    const b = new Shoe(seededRng(7));
    a.force(h("AS", "KD"));
    expect([a.draw(), a.draw()]).toEqual(["AS", "KD"]);
    expect(a.draw()).toBe(b.draw());
    expect(a.remaining).toBe(8 * 52 - 1);
  });
});
