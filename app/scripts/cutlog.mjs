// Usage: node scripts/cutlog.mjs <scenario> <seats> <keys> -- e.g. charlie 2,3 hhhhhhhh; prints every cut.
// Plays scripted rounds and prints the director log (every cut and how it was made).
import { chromium } from "playwright";
const [scenario, seats, keys] = process.argv.slice(2);
const b = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5183/");
await p.waitForSelector(".betbar", { timeout: 240000 });
await p.click(".icon-btn:has-text('Director')");
await p.selectOption(".dp-select", scenario);
for (const s of seats.split(",")) await p.keyboard.press(s);
await p.keyboard.press("Space");
for (const k of keys.split("")) {
  await p.waitForSelector(".decision", { timeout: 60000 });
  await p.waitForTimeout(250);
  await p.keyboard.press(k);
  await p.waitForTimeout(700);
}
await p.waitForSelector(".betbar", { timeout: 120000 });
const log = await p.$$eval(".dp-log li", (l) => l.map((x) => x.textContent).reverse());
console.log(log.join("\n"));
console.log("bridges:", await p.$eval(".dp-stats", (e) => e.textContent.match(/Bridges.*?stand-in[^S]*/)?.[0]));
console.log("errors:", errs.length ? errs : "none");
await b.close();
