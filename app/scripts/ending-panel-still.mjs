// The results panel held still over the table, for a look at its layout without playing rounds:
// it fakes a settled round in the store and puts the panel up (the composite is left as it is).
// Usage: node scripts/ending-panel-still.mjs [views]   e.g. "1600x1000,1280x800"
// Saves shots/still-<case>-<framing>-<view>.png (the stage) for each case below in both framings.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const views = (process.argv[2] ?? "1600x1000").split(",");
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");

const r = (outcome, bet, payout) => ({ outcome, payout: payout ?? 0 });
const CASES = {
  one: { dealer: ["TS", "7H"], seats: [["seat2", ["9C", "TD"], 10, r("win", 10, 20)]] },
  two: { dealer: ["6S", "TH", "9D"], seats: [["seat1", ["8S", "7C", "QH"], 10, r("bust")], ["seat3", ["TS", "6H"], 25, r("win", 25, 50)]] },
  three: {
    dealer: ["9S", "7C", "5D"],
    seats: [["seat1", ["QD", "AC"], 10, r("blackjack", 10, 25)], ["seat2", ["8C", "8D", "2H"], 10, r("lose")], ["seat3", ["AS", "KH"], 10, r("blackjack", 10, 25)]],
  },
  long: {
    dealer: ["AS", "2H", "AD", "AC", "AH", "TS", "2C"],
    seats: [["seat1", ["3D", "2H", "AC", "2D", "2H", "2S"], 100, r("charlie", 100, 200)], ["seat2", ["9C", "9D"], 500, r("push", 500, 500)], ["seat3", ["TS", "8H"], 5, r("push", 5, 5)]],
  },
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const view of views) {
    const [w, h] = view.split("x").map(Number);
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`${base}?ending=panel`);
    await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 150_000 });
    for (const framing of ["dealer", "studio"]) {
      for (const [name, c] of Object.entries(CASES)) {
        await page.evaluate(({ c, framing }) => {
          const { store } = window.__table;
          const net = c.seats.reduce((a, [, , bet, res]) => a + res.payout - bet, 0);
          const record = { no: 7, mask: "111", dealer: c.dealer, net, seats: c.seats.map(([seat, cards, bet, result]) => ({ seat, cards, bet, result })) };
          store.set({ clearing: null, framing });
          store.set({ round: 7, balance: 1000 + net, history: [record], phase: "clearing", clearing: { style: "panel", startedAt: performance.now(), duration: 3000 } });
        }, { c, framing });
        await page.waitForTimeout(1600);
        await (await page.$(".stage-frame")).screenshot({ path: file(`still-${name}-${framing}-${view}.png`) });
      }
    }
    await page.evaluate(() => window.__table.store.set({ clearing: null, phase: "betting" }));
    await page.close();
  }
} finally {
  await browser.close();
}
