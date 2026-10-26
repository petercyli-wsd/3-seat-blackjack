// Renders the empty set (no dealer) in the dealer framing, with the painted table over a plain grey
// backdrop: the input the pipeline's sets pass (bj3/sets.py) restyles into studio sets.
// Usage: node scripts/set-input.mjs <out.png>   (dev server running)
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [out = "set-input.png"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto((process.env.BASE_URL ?? "http://localhost:5183/") + "?framing=dealer&background=studio&table=studio");
await page.waitForSelector(".betbar", { timeout: 240_000 });
const url = await page.evaluate(async () => {
  const t = window.__table;
  const backdrop = document.createElement("canvas");
  backdrop.width = 1600;
  backdrop.height = 900;
  const g = backdrop.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 900);
  grad.addColorStop(0, "#8a8a88");
  grad.addColorStop(0.55, "#77777a");
  grad.addColorStop(1, "#3a3a3c");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 900);
  t.compositor.setOnly = true;
  t.compositor.setView({ crop: [226, 0, 1088, 612], out: [1600, 900], set: backdrop, table: { art: await t.tableArt, recolor: null }, painted: true });
  // the render loop draws only when the footage moves on; nudge it
  t.store.set({ showMasks: true });
  await new Promise((r) => setTimeout(r, 300));
  t.store.set({ showMasks: false });
  await new Promise((r) => setTimeout(r, 600));
  return document.querySelector("canvas").toDataURL("image/png");
});
writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
console.log(out);
await browser.close();
