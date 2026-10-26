// Renders runs of clip frames exactly as the table draws them (same scene, plates and shaders)
// with given hands, to numbered PNGs: for encoding a moment into a clip to judge at full speed.
// Usage: node scripts/render.mjs <out dir> '<hands json>' <clip>:<from>-<to> [...] [--crop x,y,w,h]
//   hands: {"seat1":["2C","3D"],"seat2":[],"seat3":[],"dealer":["TS","7H","4C"]}; graphic dealer
//   draws (the 3rd card on) are drawn as already landed.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cropAt = args.indexOf("--crop");
const crop = (cropAt >= 0 ? args.splice(cropAt, 2)[1] : "0,0,1440,810").split(",").map(Number);
const [out, handsJson, ...runs] = args;
mkdirSync(out, { recursive: true });
const hands = JSON.parse(handsJson);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(process.env.BASE_URL ?? "http://localhost:5183/");
await page.waitForSelector(".betbar", { timeout: 240_000 });
await page.evaluate(() => window.__table.player.stopAll());

let n = 0;
for (const run of runs) {
  const [, clip, from, to] = run.match(/^(.+):(\d+)-(\d+)$/);
  await page.evaluate(async (clip) => {
    const { m } = window.__table;
    const video = document.createElement("video");
    video.muted = true;
    video.src = "/" + m.clips[clip].file;
    await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
    window.__render = video;
  }, clip);
  for (let f = Number(from); f <= Number(to); f++) {
    const url = await page.evaluate(async ({ clip, f, hands, crop }) => {
      const { scene, compositor, m } = window.__table;
      const video = window.__render;
      video.currentTime = (f + 0.5) / m.fps;
      await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
      const view = {
        seats: { seat1: hands.seat1 ?? [], seat2: hands.seat2 ?? [], seat3: hands.seat3 ?? [] },
        dealer: hands.dealer ?? [],
        dealerDrawAt: (hands.dealer ?? []).slice(2).map(() => -1e9),
      };
      const res = scene.compute({ name: clip, clip: m.clips[clip], frame: f, loop: false, deck: { el: video } }, view, performance.now());
      compositor.render({ a: video, mix: 0, plates: res.plates, cards: res.cards });
      const [x, y, w, h] = crop;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d").drawImage(compositor.gl.canvas, x, y, w, h, 0, 0, w, h);
      return cv.toDataURL("image/png");
    }, { clip, f, hands, crop });
    writeFileSync(join(out, `${String(n++).padStart(4, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
  console.log(`${run}: done`);
}
console.log(`${n} frames -> ${out}`);
await browser.close();
