// The results panel (ending "panel"), shot through a round's end in either framing.
// Usage: node scripts/ending-panel.mjs [seats] [scenario] [tag]
//   seats: "1,3";  scenario: a key of director/scenarios.ts ("random" by default);  tag: file name part
// FRAMING=studio for the whole take; VIEW=1280x720 for another window size; STEP=ms between shots;
// CAST=1 also saves every painted frame (shots/cast-*.jpg, the whole page) to check the motion.
// Saves shots/panel-<tag>-<framing>-<ms>.png (the page, cropped to the stage) from the results
// until betting reopens, and prints the director's log.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [seats = "1,3", scenario = "random", tag = "t"] = process.argv.slice(2);
const framing = process.env.FRAMING ?? "dealer";
const [vw, vh] = (process.env.VIEW ?? "1600x1000").split("x").map(Number);
const step = Number(process.env.STEP ?? 150);
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const errors = [];
setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 280_000).unref();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
try {
  await page.goto(`${base}?ending=panel&framing=${framing}`);
  await page.waitForSelector(".betbar", { timeout: 150_000 });
  console.log("loaded");
  await page.evaluate((k) => window.__table.director.setScenario(k), scenario);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  await page.waitForTimeout(500);
  const blocker = await page.evaluate((ids) => {
    const d = window.__table.director;
    for (const k of ids) d.toggleSeat(`seat${k}`);
    void d.deal();
    return d.dealBlocker();
  }, seats.split(","));
  if (blocker) throw new Error(`can't deal: ${blocker}`);
  const playStart = Date.now();
  for (;;) {
    const phase = await page.evaluate(() => window.__table.store.get().phase);
    if (phase === "settling" || phase === "clearing") break;
    if (Date.now() - playStart > 90_000) throw new Error(`stuck in ${phase}`);
    if (await page.$(".decision")) await page.keyboard.press(process.env.HIT && Math.random() < 0.5 ? "h" : "s");
    await page.waitForTimeout(200);
  }
  const frame = await page.$(".stage-frame");
  const t0 = Date.now();
  // CAST=1: every frame the page paints (the DevTools screencast), as JPEGs, besides the shots
  if (process.env.CAST) {
    const box = await frame.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      const ms = Date.now() - t0;
      writeFileSync(file(`cast-${tag}-${framing}-${String(ms).padStart(5, "0")}.jpg`), Buffer.from(data, "base64"));
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: Math.round(box.x * 2 + box.width), maxHeight: vh });
  }
  for (let after = 0; ; ) {
    const phase = await page.evaluate(() => window.__table.store.get().phase);
    const ms = Date.now() - t0;
    await frame.screenshot({ path: file(`panel-${tag}-${framing}-${String(ms).padStart(5, "0")}.png`) });
    if (phase === "betting" && ++after > 6) break;
    if (ms > 20_000) break;
    await page.waitForTimeout(step);
  }
  const log = await page.evaluate(() => window.__table.store.get().debug.log.slice(0, 14).reverse());
  console.log(log.join("\n"));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  await browser.close();
}
