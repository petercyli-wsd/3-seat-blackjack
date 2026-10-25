import { Director } from "./director/Director";
import { Store } from "./director/store";
import { ClipPlayer } from "./media/ClipPlayer";
import { ASSET_BASE, type SeatId, loadBridges, loadManifest } from "./media/manifest";
import { grabPlates, maskRects } from "./media/plates";
import { ClipLoader, loadImage } from "./media/preload";
import { Compositor } from "./render/Compositor";
import { buildFaceAtlas } from "./render/faceAtlas";
import { Scene } from "./render/scene";

export interface Table {
  store: Store;
  director: Director;
  dispose(): void;
}

/** Graphic dealer cards animate on the clock rather than the footage; render every frame while one might be moving. */
const DRAW_ANIM_MS = 1000;

/**
 * Boot: manifest -> the clips the table opens on into memory (the rest follow in
 * the background) -> plates grabbed from the clips -> compositor -> director; then
 * a render loop that composites whatever the player is showing with whatever the
 * game says is on the table.
 */
export async function bootTable(canvas: HTMLCanvasElement, host: HTMLElement, store: Store): Promise<Table> {
  const setLoading = (label: string, done = 0, total = 1) => store.set({ loading: { label, done, total } });
  setLoading("Reading manifest");
  const m = await loadManifest();
  const bridges = await loadBridges(m);
  {
    const all = [...bridges.values()].flat();
    const tool = all.filter((b) => b.source === "tool").length;
    const rejected = all.filter((b) => b.rejected).length;
    store.set((s) => ({ debug: { ...s.debug, bridges: { tool, flow: all.length - tool, rejected } } }));
  }
  const files = new ClipLoader(
    m,
    (done, total) => {
      store.set({ footage: { done, total } });
      if (store.get().phase === "loading" && done <= files.bootCount) setLoading("Loading dealer footage", done, files.bootCount);
    },
    (e) => store.set({ error: `Footage failed to load: ${e.message}` }),
  );
  setLoading("Loading dealer footage", 0, files.bootCount);
  await document.fonts.ready;
  const mask = await loadImage(ASSET_BASE + m.masks);
  const atlas = buildFaceAtlas();
  const compositor = new Compositor(canvas, m.width, m.height, mask, atlas);
  setLoading("Grabbing seat plates");
  const plates = await grabPlates(m, files, maskRects(mask, m.seats), host);
  const plateTex = {} as Record<SeatId, Record<number, WebGLTexture>>;
  for (const seat of m.seats) {
    plateTex[seat] = {};
    for (const [n, p] of Object.entries(plates[seat])) plateTex[seat][Number(n)] = compositor.imageTexture(p.image);
  }
  const scene = new Scene(m, plates, plateTex);
  const player = new ClipPlayer(m, files, host);
  const director = new Director(m, player, store, bridges);

  let raf = 0;
  let lastDebug = 0;
  let lastDrawn = "";
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    player.tick(now);
    const active = player.active;
    if (!active?.name) return;
    const from = player.fadingFrom;
    const dominant = from && player.fadeT < 0.5 ? from : active;
    const st = player.state(dominant);
    if (!st) return;
    // The footage runs at 24 fps under a 60-144 Hz display: composite only when a video frame,
    // the table or a graphic card has moved on since the last one.
    const v0 = director.view;
    const drawn = [
      player.decks.indexOf(active), active.fileFrame, from ? player.decks.indexOf(from) : -1, from?.fileFrame, player.fadeT,
      v0.seats.seat1.length, v0.seats.seat2.length, v0.seats.seat3.length, v0.dealer.length, store.get().showMasks,
    ].join();
    const animating = v0.dealerDrawAt.some((t) => now - t < DRAW_ANIM_MS);
    if (drawn === lastDrawn && !animating) return;
    lastDrawn = drawn;
    const res = scene.compute(st, director.view, now);
    compositor.render({
      a: from ? from.el : active.el,
      b: from ? active.el : undefined,
      mix: from ? player.fadeT : 0,
      plates: res.plates,
      cards: res.cards,
      showMasks: store.get().showMasks,
    });
    const s = store.get();
    const v = res.visible;
    if (v.seat1 !== s.visible.seat1 || v.seat2 !== s.visible.seat2 || v.seat3 !== s.visible.seat3 || v.dealer !== s.visible.dealer) {
      store.set({ visible: { ...v } });
    }
    if (now - lastDebug > 100) {
      lastDebug = now;
      store.set((s0) => ({
        debug: {
          ...s0.debug,
          clip: st.name, kind: st.clip.kind, frame: st.frame, frames: st.clip.frames, loop: st.loop,
          plates: res.plateUse, handoffGap: player.lastHandoffGap, fade: player.fadeT,
          shoeRemaining: director.shoeStats.remaining, shuffles: director.shoeStats.shuffles,
        },
      }));
    }
  };
  raf = requestAnimationFrame(loop);
  // browser checks (scripts/probe.mjs) read the live table through this
  if (import.meta.env.DEV) Object.assign(window, { __table: { store, director, player, scene } });
  await director.open();
  return {
    store,
    director,
    dispose() {
      cancelAnimationFrame(raf);
      player.stopAll();
      files.dispose();
    },
  };
}
