// Soak test: N rounds with random seat combinations and random play (including
// letting the decision timer run out), checking the table always returns to betting.
import { chromium } from "playwright";

const rounds = Number(process.argv[2] ?? 6);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(process.env.BASE_URL ?? "http://localhost:5183/");
await page.waitForSelector(".betbar", { timeout: 240_000 });
const taken = async () => page.$$eval(".seat-toggle", (b) => b.map((x) => x.classList.contains("is-on")));
let ok = 0;
for (let r = 0; r < rounds; r++) {
  const want = [0, 1, 2].map(() => Math.random() < 0.6);
  if (!want.some(Boolean)) want[Math.floor(Math.random() * 3)] = true;
  const have = await taken();
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) await page.keyboard.press(String(i + 1));
  const mask = want.map((w) => (w ? 1 : 0)).join("");
  const t0 = Date.now();
  await page.keyboard.press("Space");
  let decisions = 0, timeouts = 0;
  for (;;) {
    const state = await page.waitForSelector(".decision, .betbar", { timeout: 150_000 }).then((e) => e.getAttribute("class"));
    if (state?.includes("betbar") && Date.now() - t0 > 3000) break;
    if (state?.includes("decision")) {
      decisions++;
      const roll = Math.random();
      if (roll < 0.15) {
        timeouts++;
        await page.waitForSelector(".decision", { state: "detached", timeout: 30_000 });
      } else await page.keyboard.press(roll < 0.6 ? "h" : "s");
      await page.waitForTimeout(400);
    } else await page.waitForTimeout(300);
  }
  const clip = await page.evaluate(() => document.querySelector(".dp-clip code")?.textContent ?? "");
  const bal = await page.$eval(".balance-value", (e) => e.textContent);
  ok++;
  console.log(`round ${r + 1}: mask ${mask}  decisions ${decisions} (timeouts ${timeouts})  ${((Date.now() - t0) / 1000).toFixed(1)}s  balance ${bal}  ${clip}`);
}
console.log(`${ok}/${rounds} rounds completed; errors: ${errors.length ? errors.join(" | ") : "none"}`);
await browser.close();
