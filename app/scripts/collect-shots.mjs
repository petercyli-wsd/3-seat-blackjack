// Plays one round with the collect ending and grabs the canvas densely through the clear, to judge
// its motion. Usage: node scripts/collect-shots.mjs [seats] [scenario] [hits]
//   seats: "1,3"; scenario: a key of director/scenarios.ts (random); hits: "seat1:3,seat3:1"
// Env: STEP (ms between grabs, default 33), FRAMING (dealer | studio), CROP=x,y,w,h (canvas px).
// Saves shots/collect-<ms>.png from just before the clear until it is done.
import { chromium } from "playwright";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const [seats = "1,3", scenario = "random", hitArg = ""] = process.argv.slice(2);
const hits = Object.fromEntries(hitArg.split(",").filter(Boolean).map((s) => s.split(":")).map(([k, n]) => [k, Number(n)]));
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const step = Number(process.env.STEP ?? 33);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
for (const f of readdirSync(dir)) if (f.startsWith("collect-")) rmSync(file(f));
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
try {
  await page.goto(`${base}?ending=collect&framing=${process.env.FRAMING ?? "dealer"}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  await page.evaluate((k) => window.__table.director.setScenario(k), scenario);
  for (const s of seats.split(",")) await page.keyboard.press(s);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  await page.keyboard.press("Space");
  for (;;) {
    const st = await page.evaluate(() => {
      const s = window.__table.store.get();
      return { phase: s.phase, seat: s.activeSeat, n: s.activeSeat ? s.seats[s.activeSeat].cards.length : 0 };
    });
    if (st.phase === "settling" || st.phase === "clearing") break;
    if (await page.$(".decision")) await page.keyboard.press(st.n < 2 + (hits[st.seat] ?? 0) ? "h" : "s");
    await page.waitForTimeout(400);
  }
  // in the page: grab every `step` ms from shortly before the clear until it is done
  const shots = await page.evaluate(async ({ step, crop }) => {
    const { director } = window.__table;
    const cv = document.querySelector(".stage-canvas");
    const out = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; !director.clearing; i++) {
      if (i > 12000) return [];
      await sleep(5);
    }
    const t0 = director.clearing.startedAt;
    const g = document.createElement("canvas");
    const [x, y, w, h] = crop ?? [0, 0, cv.width, cv.height];
    g.width = w;
    g.height = h;
    const ctx = g.getContext("2d");
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now() - t0;
      ctx.drawImage(cv, x, y, w, h, 0, 0, w, h);
      out.push({ t: Math.round(t), url: g.toDataURL("image/png") });
      if (!director.clearing || director.clearing.done || t > 8000) break;
      await sleep(step);
    }
    return out;
  }, { step, crop: process.env.CROP ? process.env.CROP.split(",").map(Number) : null });
  for (const s of shots) writeFileSync(file(`collect-${String(s.t).padStart(5, "0")}.png`), Buffer.from(s.url.split(",")[1], "base64"));
  console.log(`${shots.length} shots: ${shots.map((s) => s.t).join(" ")}`);
  const log = await page.evaluate(() => window.__table.store.get().debug.log.slice(0, 12).reverse());
  console.log(log.join("\n"));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  await browser.close();
}
