import { Director } from "./director/Director";
import { Store } from "./director/store";
import { ClipPlayer } from "./media/ClipPlayer";
import { ASSET_BASE, loadBridges, loadManifest } from "./media/manifest";
import { RoundPlates, grabPlates, maskRects } from "./media/plates";
import { ClipLoader, loadImage } from "./media/preload";
import { Compositor } from "./render/Compositor";
import { buildFaceAtlas } from "./render/faceAtlas";
import { type PlateTextures, Scene } from "./render/scene";
import { applyEnding } from "./ending";
import { ENDING_IDS, type Ending, type EndingContext } from "./ending/types";
import {
  DEALER_CROP, DEALER_OUT, FELTS, ROOM_BEHIND, type TableArt, backLine, lightOf, loadMattes, loadSceneInfo, loadSets, loadSkirtWood,
  paintSet, paintTable, tintFor,
} from "./render/stageArt";

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
    const cut = all.filter((b) => b.frames === 0).length;
    const rejected = all.filter((b) => b.rejected).length;
    store.set((s) => ({ debug: { ...s.debug, bridges: { tool, flow: all.length - tool - cut, cut, rejected } } }));
  }
  // clips the pipeline has packed with her matte are played packed
  const files = new ClipLoader(
    m,
    (done, total) => {
      store.set({ footage: { done, total } });
      if (store.get().phase === "loading" && done <= files.bootCount) setLoading("Loading dealer footage", done, files.bootCount);
    },
    (e) => store.set({ error: `Footage failed to load: ${e.message}` }),
    await loadMattes(),
  );
  setLoading("Loading dealer footage", 0, files.bootCount);
  await document.fonts.ready;
  const mask = await loadImage(ASSET_BASE + m.masks);
  const atlas = buildFaceAtlas();
  const compositor = new Compositor(canvas, m.width, m.height, mask, atlas);
  const sceneInfo = await loadSceneInfo();
  const sets = sceneInfo ? await loadSets() : [];
  const studio = { id: "studio", name: "As filmed" };
  // the filmed wall behind her, where the dealer framing puts the room behind her: the light she was filmed in
  let wall: [number, number, number] = [1, 1, 1];
  if (sceneInfo) {
    const [ref, masks, clutter, wood] = await Promise.all([
      loadImage(ASSET_BASE + sceneInfo.reference), loadImage(ASSET_BASE + sceneInfo.masks), loadImage(ASSET_BASE + sceneInfo.clutter), loadSkirtWood(),
    ]);
    compositor.setScene(ref, masks, clutter, backLine(sceneInfo), wood);
    const [cx, cy, cw, ch] = DEALER_CROP;
    const [fx, fy, fw, fh] = ROOM_BEHIND;
    wall = lightOf(ref, [(cx + fx * cw) / m.width, (cy + fy * ch) / m.height, (fw * cw) / m.width, (fh * ch) / m.height]);
    store.set({
      backgrounds: [...sets.map(({ id, name }) => ({ id, name })), studio],
      tables: [...FELTS.map(({ id, name }) => ({ id, name })), studio],
    });
    if (!sets.some((x) => x.id === store.get().background)) store.set({ background: sets[0]?.id ?? "studio" });
  }
  // ?framing=studio&background=studio&table=studio: the browser checks read the canvas in source pixels
  const q = new URLSearchParams(location.search);
  const qFraming = q.get("framing");
  if (qFraming === "dealer" || qFraming === "studio") store.set({ framing: qFraming });
  for (const k of ["background", "table"] as const) {
    const v = q.get(k);
    if (v) store.set({ [k]: v });
  }
  // ?ending=fade|panel|collect: play rounds out without the discard footage
  const qEnding = q.get("ending");
  if (qEnding && (ENDING_IDS as string[]).includes(qEnding)) store.set({ ending: qEnding as Ending });

  // the view: framing, set and felt; each set painted once, re-applied when any changes
  const painted = new Map<string, Promise<TexImageSource>>();
  const tableArt: Promise<TableArt> | null = sceneInfo ? paintTable(sceneInfo, m) : null;
  let viewKey = "";
  let viewVersion = 0;
  const applyView = async () => {
    const { framing, background, table } = store.get();
    const key = `${framing}/${background}/${table}`;
    if (key === viewKey) return;
    viewKey = key;
    // a set needs the dealer framing: the full take shows the set as filmed
    const dealer = framing === "dealer";
    const set = dealer ? sets.find((x) => x.id === background) : undefined;
    if (set && !painted.has(set.id)) painted.set(set.id, paintSet(set));
    const felt = FELTS.find((f) => f.id === table);
    const [image, art] = await Promise.all([set ? painted.get(set.id)! : null, set && felt ? tableArt : null]);
    if (viewKey !== key) return;
    compositor.setView({
      crop: dealer ? DEALER_CROP : [0, 0, m.width, m.height],
      out: dealer ? DEALER_OUT : [m.width, m.height],
      set: image,
      table: set && felt && art ? { art, recolor: felt.colour ? { from: set.felt, to: felt.colour } : null } : null,
      tint: image ? tintFor(lightOf(image as HTMLCanvasElement, ROOM_BEHIND), wall) : undefined,
    });
    viewVersion++;
  };
  await applyView();
  const unsubscribe = store.subscribe(() => void applyView());
  setLoading("Grabbing seat plates");
  const rects = maskRects(mask, m.seats);
  const plates = await grabPlates(m, files, rects, host);
  const plateTex = {} as PlateTextures;
  for (const seat of m.seats) {
    plateTex[seat] = {};
    for (const [n, p] of Object.entries(plates[seat])) {
      plateTex[seat][Number(n)] = { image: compositor.imageTexture(p.image), matte: compositor.imageTexture(p.matte) };
    }
  }
  const scene = new Scene(m, plates, plateTex, new RoundPlates(m, files, rects, host, plates, (src) => compositor.imageTexture(src)));
  const player = new ClipPlayer(m, files, host);
  const director = new Director(m, player, store, bridges);
  const endingCtx: EndingContext = { m, plates, plateTex, compositor, files, host };

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
      v0.seats.seat1.length, v0.seats.seat2.length, v0.seats.seat3.length, v0.dealer.length, store.get().showMasks, viewVersion,
      director.clearing?.style, director.clearing?.done,
    ].join();
    // a no-discard clear animates on the clock too
    const animating = v0.dealerDrawAt.some((t) => now - t < DRAW_ANIM_MS) || (!!director.clearing && !director.clearing.done);
    if (drawn === lastDrawn && !animating) return;
    lastDrawn = drawn;
    const res = applyEnding(scene.compute(st, director.view, now), director.clearing, now, endingCtx);
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
  // browser checks (scripts/probe.mjs, scripts/frames.mjs) read and draw the live table through this
  if (import.meta.env.DEV) {
    Object.assign(window, { __table: { store, director, player, scene, compositor, m, tableArt } });
  }
  await director.open();
  return {
    store,
    director,
    dispose() {
      cancelAnimationFrame(raf);
      unsubscribe();
      player.stopAll();
      files.dispose();
    },
  };
}
