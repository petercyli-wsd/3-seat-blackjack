// Records the page as a video through the end of a round (canvas and HTML overlays together), to
// catch anything that only shows on screen. Usage: node scripts/round-end-video.mjs <ending> [seats]
// (env: BASE_URL, FRAMING). Saves shots/round-end-<ending>.webm and prints when each phase began.
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";

const [ending = "fade", seats = "1,3"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:5183/";
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const path = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: path(""), size: { width: 1600, height: 1000 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
try {
  await page.goto(`${base}?ending=${ending}&framing=${process.env.FRAMING ?? "dealer"}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  for (const s of seats.split(",")) await page.keyboard.press(s);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  await page.keyboard.press("Space");
  let last = "";
  let betting = 0;
  for (;;) {
    const [phase, clip] = await page.evaluate(() => [window.__table.store.get().phase, window.__table.player.state()?.name ?? "-"]);
    if (`${phase} ${clip}` !== last) marks.push(`${((Date.now() - t0) / 1000).toFixed(2)}s ${phase} ${clip}`);
    last = `${phase} ${clip}`;
    if (await page.$(".decision")) await page.keyboard.press("s");
    if (phase === "betting" && marks.some((m) => m.includes("settling"))) betting ||= Date.now();
    if (betting && Date.now() - betting > 5000) break;
    await page.waitForTimeout(60);
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (video) renameSync(await video.path(), path(`round-end-${ending}.webm`));
  console.log(marks.join("\n"));
}
