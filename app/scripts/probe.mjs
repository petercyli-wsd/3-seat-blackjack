// Frame-by-frame check of a scripted round: records every rendered frame and flags
//  - "early": a seat's shown cards go up while the clip on screen is not dealing to it
//    (the result showing before the footage that produces it)
//  - "blend": a crossfade mixing two clips that need different seat plates (ghost cards)
//  - "stale": a clip's first frame on screen drawn from a video still parked elsewhere (a reused deck)
// and saves the canvas of the first few flagged frames to shots/probe-<n>.png.
// Usage: node scripts/probe.mjs <scenario> <seats> "<steps>"   (steps as in capture.mjs)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [scenario = "random", seats = "1,3", steps = "d"] = process.argv.slice(2);
const dir = new URL("../shots/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = (n) => new URL(n, dir).pathname.replace(/^\/([A-Z]:)/, "$1");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto((process.env.BASE_URL ?? "http://localhost:5183/") + "?framing=studio&background=studio&table=studio");
await page.waitForSelector(".betbar", { timeout: 240_000 });
await page.click(".icon-btn:has-text('Director')");
await page.selectOption(".dp-select", scenario);
await page.click(".icon-btn:has-text('Director')");
for (const s of seats.split(",")) await page.keyboard.press(s);

await page.evaluate(() => {
  const { store, director, player, scene } = window.__table;
  const seats = ["seat1", "seat2", "seat3"];
  const deals = (clip, seat) => clip.kind === "deal" || (clip.kind === "hit" && clip.seat === seat);
  const out = (window.__probe = { frames: [], flags: [], shots: [] });
  let prev = null;
  const tick = (now) => {
    requestAnimationFrame(tick);
    const a = player.active;
    if (!a?.name) return;
    const from = player.fadingFrom;
    const dom = from && player.fadeT < 0.5 ? from : a;
    const st = player.state(dom);
    const vis = { ...store.get().visible };
    const rec = { t: Math.round(now), clip: st.name, f: st.frame, from: from?.name ?? null, fade: +player.fadeT.toFixed(2), vis, plates: scene.compute(st, director.view, now).plateUse };
    if (from) {
      const other = player.state(dom === from ? a : from);
      rec.otherPlates = scene.compute(other, director.view, now).plateUse;
    }
    out.frames.push(rec);
    const why = [];
    if (prev) {
      for (const s of seats) if (vis[s] > prev.vis[s] && !deals(st.clip, s)) why.push(`early ${s} ${prev.vis[s]}→${vis[s]} on ${st.name}@${st.frame}`);
    }
    if (prev && prev.clip !== st.name && dom.el.seeking) why.push(`stale ${st.name} drawn mid-seek`);
    if (rec.otherPlates) {
      for (const s of seats) if (rec.otherPlates[s] !== rec.plates[s]) why.push(`blend ${s} ${from.name}↔${a.name} plates ${rec.plates[s]}/${rec.otherPlates[s]}`);
    }
    if (why.length) {
      out.flags.push({ t: rec.t, why });
      if (out.shots.length < 6) out.shots.push({ why: why.join("; "), url: document.querySelector("canvas").toDataURL("image/png") });
    }
    prev = rec;
  };
  requestAnimationFrame(tick);
});

for (const step of steps.split(" ").filter(Boolean)) {
  const op = step[0], arg = step.slice(1);
  if (op === "d") {
    await page.waitForSelector(".btn-deal:not([disabled])", { timeout: 150_000 });
    await page.keyboard.press("Space");
    await page.waitForSelector(".betbar", { state: "detached" });
  }
  else if (op === "h" || op === "s") {
    await page.waitForSelector(".decision", { timeout: 90_000 });
    await page.waitForTimeout(Number(arg || 600));
    await page.keyboard.press(op);
  } else if (op === "w") await page.waitForTimeout(Number(arg));
  else if (op === "u") await page.waitForSelector(arg, { timeout: 150_000 });
}

const res = await page.evaluate(() => {
  const p = window.__probe;
  const shots = p.shots;
  p.shots = [];
  return { n: p.frames.length, flags: p.flags, shots, clips: p.frames.map((r) => r.clip).filter((c, i, all) => c !== all[i - 1]) };
});
res.shots.forEach((s, i) => {
  writeFileSync(file(`probe-${i}.png`), Buffer.from(s.url.split(",")[1], "base64"));
  console.log(`probe-${i}.png: ${s.why}`);
});
console.log(`${res.n} frames over ${res.clips.join(" → ")}`);
const grouped = new Map();
for (const f of res.flags) for (const w of f.why) {
  const k = w.replace(/@\d+/, "");
  grouped.set(k, (grouped.get(k) ?? 0) + 1);
}
console.log(res.flags.length ? `${res.flags.length} flagged frames:` : "no flagged frames");
for (const [k, n] of grouped) console.log(`  ${n}×  ${k}`);
if (errors.length) console.log("page errors:", errors.join(" | "));
await browser.close();
