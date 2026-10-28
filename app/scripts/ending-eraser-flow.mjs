// ending.mjs, dealing again if the dev server reloads the table mid-round (other edits): the
// eraser's checks of a whole round, through the clear and the cut back to betting.
// Plays rounds with a no-discard ending and saves frames through the clear.
// Usage: node scripts/ending.mjs <ending> [seats] [rounds]
//   ending: discard | fade | panel | collect;  seats: "1,3";  rounds: how many to play
// Saves shots/ending-<ending>-r<round>-<ms>.png (the composited canvas) and -ui- (the page),
// every 150 ms from the results until betting reopens, and prints the director's log.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [ending = "fade", seats = "1,3", rounds = "1"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:5191/";
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
try {
  await page.goto(`${base}?ending=${ending}&framing=${process.env.FRAMING ?? "dealer"}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  for (const s of seats.split(",")) await page.keyboard.press(s);
  for (let r = 1; r <= Number(rounds); r++) {
    await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
    await page.keyboard.press("Space");
    let dealt = Date.now();
    // stand every hand as soon as it is asked
    for (;;) {
      const phase = await page.evaluate(() => window.__table.store.get().phase);
      if (phase === "betting" && Date.now() - dealt > 4000) {
        console.log("table reset: dealing again");
        if (!(await page.evaluate(() => Object.values(window.__table.store.get().seats).some((x) => x.taken)))) {
          for (const s of seats.split(",")) await page.keyboard.press(s);
        }
        await page.keyboard.press("Space");
        dealt = Date.now();
      }
      if (phase === "settling" || phase === "clearing") break;
      if (await page.$(".decision")) await page.keyboard.press("s");
      await page.waitForTimeout(200);
    }
    const t0 = Date.now();
    for (;;) {
      const phase = await page.evaluate(() => window.__table.store.get().phase);
      const ms = Date.now() - t0;
      const url = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
      writeFileSync(file(`eraser-flow-${ending}-r${r}-${String(ms).padStart(5, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
      if (process.env.UI) await page.screenshot({ path: file(`eraser-flow-${ending}-ui-r${r}-${String(ms).padStart(5, "0")}.png`) });
      if (phase === "betting" || ms > 20_000) break;
      await page.waitForTimeout(150);
    }
  }
  const log = await page.evaluate(() => window.__table.store.get().debug.log.slice(0, 30).reverse());
  console.log(log.join("\n"));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
  await browser.close();
}
