import { Director } from "./director/Director";
import { Store } from "./director/store";
import { ClipPlayer } from "./media/ClipPlayer";
import { ASSET_BASE, type SeatId, loadManifest } from "./media/manifest";
import { grabPlates, maskRects } from "./media/plates";
import { loadImage, preloadClips } from "./media/preload";
import { Compositor } from "./render/Compositor";
import { buildFaceAtlas } from "./render/faceAtlas";
import { Scene } from "./render/scene";

export interface Table {
  store: Store;
  director: Director;
  dispose(): void;
}

/**
 * Boot: manifest -> clips into memory -> plates grabbed from the clips ->
 * compositor -> director; then a render loop that composites whatever the
 * player is showing with whatever the game says is on the table.
 */
export async function bootTable(canvas: HTMLCanvasElement, host: HTMLElement, store: Store): Promise<Table> {
  const setLoading = (label: string, done = 0, total = 1) => store.set({ loading: { label, done, total } });
  setLoading("Reading manifest");
  const m = await loadManifest();
  const urls = await preloadClips(m, (d, t) => setLoading("Loading dealer footage", d, t));
  setLoading("Preparing table");
  await document.fonts.ready;
  const mask = await loadImage(ASSET_BASE + m.masks);
  const atlas = buildFaceAtlas();
  const compositor = new Compositor(canvas, m.width, m.height, mask, atlas);
  setLoading("Grabbing seat plates");
  const plates = await grabPlates(m, urls, maskRects(mask, m.seats), host);
  const plateTex = {} as Record<SeatId, Record<number, WebGLTexture>>;
  for (const seat of m.seats) {
    plateTex[seat] = {};
    for (const [n, p] of Object.entries(plates[seat])) plateTex[seat][Number(n)] = compositor.imageTexture(p.image);
  }
  const scene = new Scene(m, plates, plateTex);
  const player = new ClipPlayer(m, urls, host);
  const director = new Director(m, player, store);

  let raf = 0;
  let lastDebug = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    player.tick(now);
    const active = player.active;
    if (!active?.name) return;
    const from = player.fadingFrom;
    const dominant = from && player.fadeT < 0.5 ? from : active;
    const st = player.state(dominant);
    if (!st) return;
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
      for (const u of urls.values()) URL.revokeObjectURL(u);
    },
  };
}
