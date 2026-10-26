// Plays a scripted round and saves the composited canvas at native 1440x810 at chosen moments.
// Usage: node scripts/capture.mjs <scenario> <seats> "<steps>"
//   steps: space-separated; h / s = hit / stand, w<ms> = wait, c<name> = capture canvas,
//          d = deal, u<selector> = wait until selector exists
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [scenario = "random", seats = "1,3", steps = ""] = process.argv.slice(2);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
try {
  await page.goto((process.env.BASE_URL ?? "http://localhost:5183/") + "?framing=studio&background=studio&table=studio");
  await page.waitForSelector(".betbar", { timeout: 240_000 });
  await page.click(".icon-btn:has-text('Director')");
  await page.selectOption(".dp-select", scenario);
  for (const s of seats.split(",")) await page.keyboard.press(s);
  for (const step of steps.split(" ").filter(Boolean)) {
    const op = step[0], arg = step.slice(1);
    if (op === "d") await page.keyboard.press("Space");
    else if (op === "h" || op === "s") {
      await page.waitForSelector(".decision", { timeout: 60_000 });
      await page.keyboard.press(op);
    } else if (op === "w") await page.waitForTimeout(Number(arg));
    else if (op === "u") await page.waitForSelector(arg, { timeout: 90_000 });
    else if (op === "c") {
      const url = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
      writeFileSync(file(`cap-${arg}.png`), Buffer.from(url.split(",")[1], "base64"));
      await page.screenshot({ path: file(`ui-${arg}.png`) });
      const dbg = await page.evaluate(() => [...document.querySelectorAll(".dp-clip code, .dp-plate strong")].map((e) => e.textContent).join(" | "));
      console.log("captured", arg, "::", dbg);
    }
  }
} catch (e) {
  console.error("FAILED:", e.message);
} finally {
  console.log(logs.filter((l) => !l.includes("vite") && !l.includes("DevTools")).slice(-30).join("\n"));
  await browser.close();
}
