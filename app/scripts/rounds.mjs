// Usage: node scripts/rounds.mjs 101 100 111 -- one round per seat mask (all stand); prints every cut.
// Several rounds with given seat masks (all stand), printing the director log.
import { chromium } from "playwright";
const masks = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5183/");
await p.waitForSelector(".betbar", { timeout: 240000 });
await p.click(".icon-btn:has-text('Director')");
for (const mask of masks) {
  const on = await p.$$eval(".seat-toggle", (bs) => bs.map((x) => x.classList.contains("is-on")));
  for (let i = 0; i < 3; i++) if (on[i] !== (mask[i] === "1")) await p.keyboard.press(String(i + 1));
  const t0 = Date.now();
  await p.keyboard.press("Space");
  while (true) {
    const el = await p.waitForSelector(".decision, .betbar", { timeout: 120000 });
    if ((await el.getAttribute("class")).includes("betbar") && Date.now() - t0 > 3000) break;
    if ((await el.getAttribute("class")).includes("decision")) { await p.keyboard.press("s"); await p.waitForTimeout(500); }
    else await p.waitForTimeout(300);
  }
  console.log(`-- round ${mask} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const log = await p.$$eval(".dp-log li", (l) => l.map((x) => x.textContent).reverse());
console.log(log.filter((l) => l.includes("→")).join("\n"));
console.log("errors:", errs.length ? errs : "none");
await b.close();
