// Plays rounds with the tab "hidden" for a while from early in the deal: no video frame
// callbacks reach the page (as in a background tab or a covered window) while the footage plays
// on, and checks every round still gets back to betting. Usage: node scripts/hidden.mjs [rounds] [hidden ms]
import { chromium } from "playwright";

const [rounds = "2", hiddenMs = "25000"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
// a hidden page renders nothing, so it gets no frame callbacks; they resume once it is shown
await page.addInitScript(() => {
  const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
  window.__hiddenUntil = 0;
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
    const el = this;
    const held = (now, meta) => (performance.now() < window.__hiddenUntil ? request.call(el, held) : cb(now, meta));
    return request.call(el, held);
  };
});
const state = () => page.evaluate(() => {
  const { store, player } = window.__table;
  const s = player.state();
  return `phase ${store.get().phase}, "${store.get().message}", on screen ${s?.name}@${s?.frame}`;
});
let stuck = 0;
for (let r = 1; r <= Number(rounds); r++) {
  await page.goto(process.env.BASE_URL ?? "http://localhost:5183/");
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  for (const k of ["1", "2", "3"]) await page.keyboard.press(k);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__table.player.state()?.clip.kind === "deal", null, { timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.evaluate((ms) => { window.__hiddenUntil = performance.now() + ms; }, Number(hiddenMs));
  await page.waitForTimeout(Number(hiddenMs));
  // shown again: the round must carry on, through every decision (stand), back to betting
  let ok = await page.waitForFunction(() => window.__table.store.get().phase !== "dealing", null, { timeout: 20_000 }).then(() => true, () => false);
  while (ok) {
    const phase = await page.evaluate(() => window.__table.store.get().phase);
    if (phase === "betting") break;
    if (await page.$(".decision")) await page.keyboard.press("s");
    ok = await page.waitForFunction(() => window.__table.store.get().phase === "betting" || !!document.querySelector(".decision"), null, { timeout: 60_000 }).then(() => true, () => false);
    await page.waitForTimeout(300);
  }
  if (!ok) stuck++;
  console.log(`round ${r}: ${ok ? "back to betting" : "STUCK"} (${await state()})`);
}
console.log(`${stuck}/${rounds} stuck`);
await browser.close();
process.exit(stuck ? 1 : 0);
