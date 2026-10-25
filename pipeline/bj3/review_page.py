"""bridges/review.html: every generated bridge, playing in context, to judge by eye.

Each card loops the tool's output as delivered (the footage it leaves, the bridge, the
footage it lands in), with the bridge's place in the game, its scores and flags, and what
the game plays for it now. Reject / OK on a card is kept in the page (localStorage);
"Download verdicts.json" writes them in the form `bridges.py` reads — save it over
bridges/verdicts.json and run `python -m bj3.bridges resolve`.
"""

import html
import json

from bj3.bridges import BRIDGE_DIR, GENERATED, STATE, VERDICTS, _load, plan_rows, registry_path

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bridge review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#111;--card:#1b1b1b;--line:#ffffff1a;--text:#ffffffe6;--muted:#ffffff80;--gold:#d4af37;--bad:#f87171;--ok:#4ade80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 Inter,Segoe UI,system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px;background:#0d0d0dee;border-bottom:1px solid var(--line)}
h1{margin:0 12px 0 0;font:600 20px Georgia,serif}h1 small{color:var(--muted);font:12px Inter,sans-serif;margin-left:8px}
button,select{background:#ffffff10;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}
button.on{border-color:var(--gold);color:var(--gold)}.primary{background:var(--gold);color:#1a1408;border:0;font-weight:700}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;padding:16px 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.card.reject{border-color:var(--bad)}.card.flagged:not(.reject){border-color:#d4af3777}
video{display:block;width:100%;aspect-ratio:16/9;background:#000}
.body{padding:10px 12px;display:grid;gap:6px}.name{font:12px Consolas,monospace;word-break:break-all}
.route{color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-size:11px;padding:1px 7px;border-radius:999px;background:#ffffff12;color:var(--muted)}
.chip.crit{color:var(--gold)}.chip.flag{color:#1a1408;background:var(--gold)}.chip.rej{color:#fff;background:var(--bad)}
.chip.tool{color:var(--ok)}.metrics{font:11px Consolas,monospace;color:var(--muted)}
.actions{display:flex;gap:6px;align-items:center}.actions input{flex:1;min-width:0;background:#0006;border:1px solid var(--line);border-radius:6px;color:var(--text);padding:5px 8px;font:inherit}
.empty{color:var(--muted);padding:40px}
</style></head><body>
<header>
 <h1>Bridge review<small id="count"></small></h1>
 <select id="filter">
  <option value="all">All</option><option value="flagged">Flagged by checks</option>
  <option value="reject">Rejected</option><option value="critical">Hits (time-critical)</option>
  <option value="deal">Into deals</option><option value="reveal">Into reveals</option>
  <option value="generative">Generative</option>
 </select>
 <button id="slow">Speed 1×</button>
 <button class="primary" id="save">Download verdicts.json</button>
 <span class="route">Save over <code>bridges/verdicts.json</code>, then run <code>python -m bj3.bridges resolve</code>.</span>
</header>
<main id="grid"></main>
<script>
const DATA = __DATA__;
const KEY = "bridge-verdicts:" + DATA.planId;
// verdicts.json as written by the pipeline, merged with what was marked in this page: for each
// bridge the newer of the two wins (a clear in the page is kept as a dated tombstone)
let verdicts = Object.assign({}, DATA.verdicts);
let local = {};
try { local = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
for (const [k, v] of Object.entries(local)) {
  const f = verdicts[k];
  if (!f || (v.t || "") > (f.t || "")) { if (v.cleared) delete verdicts[k]; else verdicts[k] = v; }
}
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(local)); } catch {} };
const stamp = () => new Date().toISOString().slice(0, 19) + "+00:00";
let rate = 1;
const grid = document.getElementById("grid");
const io = new IntersectionObserver((es) => es.forEach((e) => {
  const v = e.target; if (e.isIntersecting) { if (!v.src) v.src = v.dataset.src; v.playbackRate = rate; v.play().catch(() => {}); } else v.pause();
}), { rootMargin: "200px" });
function card(b) {
  const el = document.createElement("article");
  const v = verdicts[b.name];
  const valid = v && v.sha1 === b.sha1;
  el.className = "card" + (b.flags.length ? " flagged" : "") + (valid && v.verdict === "reject" ? " reject" : "");
  const chips = [
    `<span class="chip">${b.cls}</span>`, `<span class="chip">${b.method} ${b.duration}s · ${b.frames} fr</span>`,
    b.critical ? `<span class="chip crit">hit · time-critical</span>` : "",
    `<span class="chip ${b.plays === "tool" ? "tool" : ""}">game plays: ${b.plays === "tool" ? "generated" : "stand-in"}</span>`,
    ...b.flags.map((f) => `<span class="chip flag">${f}</span>`),
    valid && v.verdict === "reject" ? `<span class="chip rej">rejected</span>` : "",
  ].join("");
  el.innerHTML = `<video muted loop playsinline preload="none" data-src="${b.video}"></video>
   <div class="body"><div class="name">${b.name}</div><div class="route">${b.from} @${b.at} → ${b.to}</div>
   <div class="chips">${chips}</div>
   <div class="metrics">seams ${b.q.seam_in} / ${b.q.seam_out} · spike ${b.q.spike} · held ${b.q.frozen} · tone ${b.q.tone} · flow ${b.flow}px</div>
   <div class="actions"><input placeholder="note" value="${valid ? (v.note || "") : ""}">
   <button data-v="ok" class="${valid && v.verdict === "ok" ? "on" : ""}">OK</button>
   <button data-v="reject" class="${valid && v.verdict === "reject" ? "on" : ""}">Reject</button></div></div>`;
  el.querySelectorAll("button[data-v]").forEach((btn) => btn.onclick = () => {
    const note = el.querySelector("input").value;
    const cur = verdicts[b.name];
    if (cur && cur.sha1 === b.sha1 && cur.verdict === btn.dataset.v) {
      delete verdicts[b.name];
      local[b.name] = { cleared: true, t: stamp() };
    } else {
      verdicts[b.name] = local[b.name] = { verdict: btn.dataset.v, note, sha1: b.sha1, t: stamp() };
    }
    persist(); render();
  });
  io.observe(el.querySelector("video"));
  return el;
}
function render() {
  const f = document.getElementById("filter").value;
  const shown = DATA.bridges.filter((b) => {
    const v = verdicts[b.name], rej = v && v.sha1 === b.sha1 && v.verdict === "reject";
    return f === "all" || (f === "flagged" && b.flags.length) || (f === "reject" && rej) || (f === "critical" && b.critical)
      || (f === "generative" && b.cls === "generative") || ((f === "deal" || f === "reveal") && b.to.endsWith("_" + f) && !b.to.includes("_card"));
  });
  grid.replaceChildren(...shown.map(card));
  if (!shown.length) grid.innerHTML = `<p class="empty">Nothing here.</p>`;
  const current = new Map(DATA.bridges.map((b) => [b.name, b.sha1]));
  const rejected = Object.entries(verdicts).filter(([k, v]) => v.verdict === "reject" && current.get(k) === v.sha1).length;
  document.getElementById("count").textContent = `${shown.length} of ${DATA.bridges.length} · ${rejected} rejected`;
}
document.getElementById("filter").onchange = render;
document.getElementById("slow").onclick = (e) => {
  rate = rate === 1 ? 0.25 : 1; e.target.textContent = `Speed ${rate === 1 ? "1" : "¼"}×`;
  document.querySelectorAll("video").forEach((v) => v.playbackRate = rate);
};
document.getElementById("save").onclick = () => {
  const out = {}; Object.keys(verdicts).sort().forEach((k) => out[k] = verdicts[k]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1) + "\\n"], { type: "application/json" }));
  a.download = "verdicts.json"; a.click();
};
render();
</script></body></html>
"""


def build() -> None:
    rows = plan_rows()
    state = _load(STATE, {})
    verdicts = _load(VERDICTS, {})
    plays = {b["name"]: b["source"] for b in _load(registry_path(), {"bridges": []})["bridges"]}
    bridges = []
    for r in rows:
        s = state.get(r["output"])
        if not s or not (GENERATED / r["output"]).exists():
            continue
        bridges.append({
            "name": r["output"], "from": r["src"], "at": r["frame"], "to": r["dst"], "cls": r["class"],
            "critical": r["critical"], "flow": r["flow_px"], "method": s["method"], "duration": s["duration"],
            "frames": s["frames"], "sha1": s["sha1"], "q": s["quality"], "flags": s["flags"],
            "plays": plays.get(r["output"], "flow"), "video": f"generated/{html.escape(r['output'])}",
        })
    # flagged first, then the order of the plan
    bridges.sort(key=lambda b: not b["flags"])
    data = {"planId": str(len(rows)), "bridges": bridges, "verdicts": verdicts}
    out = BRIDGE_DIR / "review.html"
    out.write_text(PAGE.replace("__DATA__", json.dumps(data).replace("</", "<\\/")), encoding="utf-8")
    print(f"{out}: {len(bridges)} bridges")
