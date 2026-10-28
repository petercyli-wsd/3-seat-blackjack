// The table eraser (ending/eraser.ts) at chosen alphas: plays a round with hits on the seats and
// dealer draws, holds the round at rest in the hold loop, and saves the canvas at each alpha, then
// after the clear (the game's table emptied, still on the hold) for a second and a half.
// Usage: node scripts/ending-eraser-shots.mjs [seats] [hits]
//   seats "1,2,3"; hits per seat "3,1,0" (seat 1 takes 3, seat 2 one, seat 3 none); the dealer
//   draws four (A 2, then A A A 2).
// Env: FRAMING=studio (raw footage, as filmed) | dealer (default); TABLE: a felt (stageArt FELTS);
//   TAG names the shots.
// Saves shots/eraser-<tag>-<label>.png.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [seats = "1,2,3", hitsArg = "3,1,0"] = process.argv.slice(2);
const hits = Object.fromEntries(hitsArg.split(",").map((n, i) => [`seat${i + 1}`, Number(n)]));
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const framing = process.env.FRAMING ?? "dealer";
const tag = process.env.TAG ?? framing;
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(m.text()));
const shot = async (label) => {
  const url = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
  writeFileSync(file(`eraser-${tag}-${label}.png`), Buffer.from(url.split(",")[1], "base64"));
};
try {
  const view = framing === "studio" ? "&background=studio&table=studio" : process.env.TABLE ? `&table=${process.env.TABLE}` : "";
  await page.goto(`${base}?ending=fade&framing=${framing}${view}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  const install = () => page.evaluate(async (hits) => {
    if (window.__installed === window.__table) return;
    window.__installed = window.__table;
    // the app's own module instances (an HMR-updated module is imported with a ?t= stamp)
    const mod = (p) => import(performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes(p)) ?? p);
    const { SCENARIOS } = await mod("/src/director/scenarios.ts");
    const small = ["2H", "3S", "4C", "2D", "3C"];
    SCENARIOS.eraser = {
      label: "Eraser", hint: "",
      seats: {
        seat1: { start: ["2C", "3D"], hits: small.slice(0, hits.seat1) },
        seat2: { start: ["9C", "5D"], hits: ["2S", "AD", "AC", "2C"].slice(0, hits.seat2) },
        seat3: { start: ["TS", "8H"], hits: ["AH", "AS", "2S"].slice(0, hits.seat3) },
      },
      dealer: { up: "AS", hole: "2H", draws: ["AD", "AC", "AH", "2C"] },
    };
    window.__table.director.setScenario("eraser");
    // the fade's own look is replaced by the alphas this script sets
    const { fade } = await mod("/src/ending/fade.ts");
    const { eraseTable } = await mod("/src/ending/eraser.ts");
    window.__alpha = null;
    const own = fade.apply;
    fade.apply = (res, c, t, now, ctx) => (window.__alpha ? eraseTable(res, window.__alpha, ctx) : own(res, c, t, now, ctx));
    // the round stops at rest in the hold once settled, until released
    const d = window.__table.director;
    d.clearWithoutDiscard = () => new Promise(() => { window.__blocked = true; });
  }, hits);
  await install();
  for (const s of seats.split(",")) await page.keyboard.press(s);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  await page.waitForFunction(() => { const f = window.__table.store.get().footage; return f.done >= f.total; }, null, { timeout: 240_000 });
  await page.keyboard.press("Space");
  console.log("dealt");
  let dealt = Date.now();
  for (let i = 0; ; i++) {
    const st = await page.evaluate(() => {
      const s = window.__table.store.get();
      return { phase: s.phase, seat: s.decision?.seat ?? null, n: s.decision ? s.seats[s.decision.seat].cards.length : 0, blocked: !!window.__blocked };
    });
    if (st.blocked) break;
    // the dev server reloaded the table under us (another edit): set up again and deal again
    if (st.phase === "betting" && Date.now() - dealt > 3000) {
      console.log("table reset: dealing again");
      await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
      await install();
      if (!(await page.evaluate(() => Object.values(window.__table.store.get().seats).some((x) => x.taken)))) {
        for (const s of seats.split(",")) await page.keyboard.press(s);
      }
      await page.keyboard.press("Space");
      dealt = Date.now();
    }
    if (i % 50 === 0) console.log(JSON.stringify(st), await page.evaluate(() => window.__table.store.get().debug.clip));
    if (st.seat && (await page.$(".decision"))) await page.keyboard.press(st.n < 2 + hits[st.seat] ? "h" : "s");
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => {
    const d = window.__table.director;
    const v = d.view;
    d.clearing = {
      style: "fade", startedAt: performance.now(), duration: 1000, mask: d.mask, done: false,
      seats: { seat1: [...v.seats.seat1], seat2: [...v.seats.seat2], seat3: [...v.seats.seat3] }, dealer: [...v.dealer],
    };
  });
  const steps = [0, 0.25, 0.5, 0.75, 1];
  for (const a of steps) {
    await page.evaluate((a) => { window.__alpha = { seat1: a, seat2: a, seat3: a, dealer: a }; }, a);
    await page.waitForTimeout(300);
    await shot(`a${String(a * 100).padStart(3, "0")}`);
  }
  // hands one at a time: a hand's erase leaves the others as they are
  await page.evaluate(() => { window.__alpha = { seat1: 1, seat2: 0.5, seat3: 0, dealer: 0.5 }; });
  await page.waitForTimeout(300);
  await shot("mixed");
  // the clear is done: the game's table is emptied, the footage still on the hold
  await page.evaluate(() => {
    const d = window.__table.director;
    window.__alpha = { seat1: 1, seat2: 1, seat3: 1, dealer: 1 };
    d.emptyTable();
    d.clearing = { ...d.clearing, done: true };
  });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    await shot(`done${i}`);
  }
  const bare = await page.evaluate(() => window.__bare?.toDataURL("image/png"));
  if (bare) writeFileSync(file(`eraser-${tag}-bare.png`), Buffer.from(bare.split(",")[1], "base64"));
  const st = await page.evaluate(() => window.__table.store.get().debug);
  console.log("clip", st.clip, "frame", st.frame, "plates", JSON.stringify(st.plates));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  await browser.close();
}
