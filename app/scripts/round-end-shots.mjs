// Records the end of a round frame by frame: from the results until the footage has been on the
// betting loop for a second, with the clip each frame comes from.
// Usage: node scripts/round-end-shots.mjs <ending> [seats]   (env: BASE_URL, FRAMING, EVERY ms)
// Saves shots/round-end-<ms>-<clip>.png (the canvas) and prints the clip timeline.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [ending = "fade", seats = "1,3"] = process.argv.slice(2);
const base = process.env.BASE_URL ?? "http://localhost:5183/";
const every = Number(process.env.EVERY ?? 30);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto(`${base}?ending=${ending}&framing=${process.env.FRAMING ?? "dealer"}`);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  for (const s of seats.split(",")) await page.keyboard.press(s);
  await page.waitForFunction(() => window.__table?.store.get().phase === "betting", null, { timeout: 120_000 });
  await page.keyboard.press("Space");
  for (;;) {
    const phase = await page.evaluate(() => window.__table.store.get().phase);
    if (phase === "settling" || phase === "clearing") break;
    if (await page.$(".decision")) await page.keyboard.press("s");
    await page.waitForTimeout(150);
  }
  const t0 = Date.now();
  let onIdle = 0;
  const timeline = [];
  for (;;) {
    const ms = Date.now() - t0;
    const [url, clip] = await page.evaluate(() => {
      const st = window.__table.player.state();
      return [document.querySelector("canvas").toDataURL("image/png"), st ? `${st.name}@${st.frame}` : "-"];
    });
    writeFileSync(file(`round-end-${String(ms).padStart(5, "0")}-${clip.replace(/[@]/g, "_")}.png`), Buffer.from(url.split(",")[1], "base64"));
    if (timeline.at(-1)?.split(" ")[1]?.split("@")[0] !== clip.split("@")[0]) timeline.push(`${ms} ${clip}`);
    if (/_idle/.test(clip) && !onIdle) onIdle = ms;
    if ((onIdle && ms - onIdle > 1000) || ms > 25_000) break;
    await page.waitForTimeout(every);
  }
  console.log(timeline.join("\n"));
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
