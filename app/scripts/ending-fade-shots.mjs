// The fade ending, frame by frame: plays a round and saves the stage through the read and the clear.
// Usage: node scripts/ending-fade-shots.mjs [seats] [scenario] [everyMs]
//   seats "1,2,3"; scenario: a key of director/scenarios.ts (hands are hit below 17); everyMs: 40
// Env: UI=1 records the page as shown (canvas and HTML overlays; a screencast, every frame the
//   browser paints, whole page) instead of reading the canvas every everyMs; FRAMING=studio;
//   FROM/TO: ms from the results to capture between (default 0 .. betting + 1200).
// Saves shots/ending-fade-x-<ms from results>[-ui].png and prints the clear's timeline.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [seats = "1,2,3", scenario = "random", every = "40"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const ui = !!process.env.UI;
const from = Number(process.env.FROM ?? 0);
const to = Number(process.env.TO ?? 1e9);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
try {
  await page.goto(`${base}?ending=fade&framing=${process.env.FRAMING ?? "dealer"}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  await page.evaluate((k) => window.__table.director.setScenario(k), scenario);
  for (const s of seats.split(",")) await page.keyboard.press(s);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  // let the whole round's footage load: a hit clip still loading stalls the round, not the clear
  await page.waitForFunction(() => { const f = window.__table.store.get().footage; return f.done >= f.total; }, null, { timeout: 240_000 });
  await page.keyboard.press("Space");
  // a hot reload (other files being edited) resets the table: give up rather than wait forever
  for (const until = Date.now() + 180_000; ; ) {
    if (Date.now() > until) throw new Error("the round never reached its results");
    const st = await page.evaluate(() => {
      const s = window.__table.store.get();
      const best = (cards) => {
        let t = 0, aces = 0;
        for (const c of cards) { const r = c[0]; t += r === "A" ? 11 : "TJQK".includes(r) ? 10 : Number(r); if (r === "A") aces++; }
        while (t > 21 && aces--) t -= 10;
        return t;
      };
      return { phase: s.phase, hand: s.decision ? best(s.seats[s.decision.seat].cards) : null };
    });
    if (st.phase === "settling" || st.phase === "clearing") break;
    if (st.hand !== null && (await page.$(".decision"))) await page.keyboard.press(st.hand < 17 ? "h" : "s");
    await page.waitForTimeout(120);
  }
  const t0 = await page.evaluate(() => performance.now());
  const wall0 = await page.evaluate(() => performance.timeOrigin + performance.now());
  const box = await (await page.$(".stage-frame")).boundingBox();
  const cdp = ui ? await page.context().newCDPSession(page) : null;
  const pending = [];
  if (cdp) {
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const ms = Math.round(metadata.timestamp * 1000 - wall0);
      if (ms >= from && ms <= to) pending.push({ ms, data });
      void cdp.send("Page.screencastFrameAck", { sessionId });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
  }
  let betAt = null;
  const timeline = [];
  for (;;) {
    const { now, phase, clearing } = await page.evaluate(() => {
      const s = window.__table.store.get();
      return { now: performance.now(), phase: s.phase, clearing: s.clearing };
    });
    const ms = Math.round(now - t0);
    if (timeline.at(-1)?.phase !== phase) timeline.push({ ms, phase, clearAt: clearing ? Math.round(clearing.startedAt - t0) : null });
    if (phase === "betting" && betAt === null) betAt = ms;
    if (!ui && ms >= from && ms <= to) {
      const url = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
      writeFileSync(file(`ending-fade-x-${String(ms).padStart(5, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
    }
    if ((betAt !== null && ms > betAt + 1200) || ms > to || ms > 20_000) break;
    await page.waitForTimeout(Number(every));
  }
  if (cdp) {
    await cdp.send("Page.stopScreencast");
    for (const f of pending) writeFileSync(file(`ending-fade-x-${String(f.ms).padStart(5, "0")}-ui.jpg`), Buffer.from(f.data, "base64"));
    console.log(`${pending.length} frames; stage at ${JSON.stringify(box)}`);
  }
  console.log(timeline.map((e) => `${e.ms} ms  ${e.phase}${e.clearAt !== null ? `  (clear started ${e.clearAt})` : ""}`).join("\n"));
  const log = await page.evaluate(() => window.__table.store.get().debug.log.slice(0, 12).reverse());
  console.log(log.join("\n"));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  await browser.close();
}
