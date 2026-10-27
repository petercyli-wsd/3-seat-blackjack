// Renders chosen frames of one clip exactly as the table draws them (same scene, plates and
// shaders) with a given hand, and saves a contact sheet of crops: for checking card faces frame
// by frame without having to catch the moment in a live round.
// Usage: node scripts/frames.mjs <clip> <from> <to> [step] [x,y,w,h crop] [out.png]   (ZOOM=3 to enlarge)
//   e.g. node scripts/frames.mjs 111_deal 200 240 2 680,340,160,90
// TABLE=emerald and/or BACKGROUND=music_hall_01 (ids in stageArt.ts, game_assets/scene/backgrounds.json)
// draw them in the dealer framing with that table or room; the crop is then in its 1600x900 canvas.
// Hands: seats get 7H 8C, KD 3S, 5S 2D and hits 4C 6H 9D QS; the dealer AD 9C (up, hole).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const { TABLE: table = "studio", BACKGROUND: background = "studio" } = process.env;
const dealer = table !== "studio" || background !== "studio";
const [clip, from, to, step = "1", crop = dealer ? "0,0,1600,900" : "0,0,1440,810", outName] = process.argv.slice(2);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto((process.env.BASE_URL ?? "http://localhost:5183/") + `?framing=${dealer ? "dealer" : "studio"}&background=${background}&table=${table}`);
await page.waitForSelector(".betbar", { timeout: 240_000 });

const sheet = await page.evaluate(async ({ clip, from, to, step, crop, zoom }) => {
  const { player, scene, compositor, m } = window.__table;
  player.stopAll();
  const info = m.clips[clip];
  const video = document.createElement("video");
  video.muted = true;
  // as the table plays it: packed with her matte where the pipeline has made one
  const mattes = await fetch("/scene/mattes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  video.src = "/" + (mattes[info.file]?.file ?? info.file);
  await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
  const view = {
    seats: {
      seat1: ["7H", "8C", "4C", "6H", "9D", "QS"],
      seat2: ["KD", "3S", "4C", "6H", "9D", "QS"],
      seat3: ["5S", "2D", "4C", "6H", "9D", "QS"],
    },
    dealer: ["AD", "9C"],
    dealerDrawAt: [],
  };
  // each hand as long as the footage's, so no seat is plated
  for (const s of Object.keys(view.seats)) {
    view.seats[s] = view.seats[s].slice(0, Math.max(0, ...info.cards.filter((c) => c.slot === s).map((c) => c.index)));
  }
  const [cx, cy, cw, ch] = crop.split(",").map(Number);
  const z = zoom;
  const frames = [];
  for (let f = from; f <= to; f += step) frames.push(f);
  const cols = Math.min(6, frames.length);
  const out = document.createElement("canvas");
  out.width = cw * z * cols;
  out.height = (ch * z + 16) * Math.ceil(frames.length / cols);
  const g = out.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, out.width, out.height);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    video.currentTime = (f + 0.5) / m.fps;
    await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
    const st = { name: clip, clip: info, frame: f, loop: false, deck: { el: video } };
    const res = scene.compute(st, view, performance.now());
    compositor.render({ a: video, mix: 0, plates: res.plates, cards: res.cards });
    const x = (i % cols) * cw * z, y = Math.floor(i / cols) * (ch * z + 16);
    g.imageSmoothingEnabled = false;
    g.drawImage(compositor.gl.canvas, cx, cy, cw, ch, x, y + 16, cw * z, ch * z);
    g.fillStyle = "#ff0";
    g.font = "12px monospace";
    g.fillText(`${clip} ${f}`, x + 3, y + 12);
  }
  return out.toDataURL("image/png");
}, { clip, from: Number(from), to: Number(to), step: Number(step), crop, zoom: Number(process.env.ZOOM ?? 1) });

const name = outName ?? `frames-${clip}-${from}-${to}.png`;
writeFileSync(file(name), Buffer.from(sheet.split(",")[1], "base64"));
console.log(file(name));
await browser.close();
