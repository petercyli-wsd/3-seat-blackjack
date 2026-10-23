// End-to-end smoke run in a real browser: boot, take seats, deal, play a round,
// screenshotting each stage into ./shots. Usage: node scripts/smoke.mjs [url] [scenario]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:5183/";
const scenario = process.argv[3] ?? "random";
const out = new URL("../shots/", import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=d3d11", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: new URL(`${name}.png`, out).pathname.replace(/^\/([A-Z]:)/, "$1") });
  console.log("shot", name);
};
const wait = (ms) => page.waitForTimeout(ms);

try {
  await page.goto(url);
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  await wait(1500);
  await shot("01-betting");

  if (scenario !== "random") {
    await page.click(".icon-btn:has-text('Director')");
    await page.selectOption(".dp-select", scenario);
  }
  const seats = (process.argv[4] ?? "1,3").split(",");
  for (const s of seats) await page.keyboard.press(s);
  await wait(300);
  await shot("02-seated");
  await page.keyboard.press("Space");
  await wait(4500);
  await shot("03-dealing");
  await page.waitForSelector(".decision", { timeout: 60_000 });
  await wait(600);
  await shot("04-decision");
  for (let i = 0; i < 12; i++) {
    const deciding = await page.$(".decision");
    if (!deciding) break;
    await page.keyboard.press(i % 3 === 2 ? "s" : "h");
    await wait(2200);
    await shot(`05-turn-${i}`);
    await page.waitForSelector(".decision, .round-steps li.is-now:has-text('Dealer'), .round-steps li.is-now:has-text('Settle')", { timeout: 60_000 });
  }
  await page.waitForSelector(".round-steps li.is-now:has-text('Settle')", { timeout: 90_000 });
  await wait(800);
  await shot("06-settle");
  await page.waitForSelector(".betbar", { timeout: 90_000 });
  await wait(800);
  await shot("07-next-round");
} catch (e) {
  console.error("FAILED:", e.message);
  await shot("99-failure");
} finally {
  console.log(logs.slice(-40).join("\n"));
  await browser.close();
}
