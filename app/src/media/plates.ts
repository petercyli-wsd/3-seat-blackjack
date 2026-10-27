import { type Manifest, type Plate, type Quad, type SeatId, clipName, loopSpan } from "./manifest";
import type { ClipLoader } from "./preload";

export interface SeatPlate {
  n: number;
  /** The seat's mask bounding box in video pixels, which is what the plate holds. */
  rect: [number, number, number, number];
  image: HTMLCanvasElement;
  /**
   * Over the image: red where its cards lie, grown by MATTE_GROW px (their contact shadows) and
   * feathered, and green exactly where its third card on lies. A plate over a take holding the
   * hand's first two cards lays in only its others by the green (to their own edges: around them
   * the plate has its own take's first two cards, a few pixels off the round's), and a moved plate
   * is never clipped by the seat mask by the red.
   */
  matte: HTMLCanvasElement;
  cards: Quad[];
}

const MATTE_GROW = 3;

type Rect = [number, number, number, number];

function canvas(w: number, h: number) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv;
}

/** Cards' outlines over `rect` in one colour, grown by `grow` px and feathered outside that (none: just their own edges). */
function shape(rect: Rect, quads: Quad[], colour: string, grow = 0): HTMLCanvasElement {
  const [x, y, w, h] = rect;
  const l = canvas(w, h);
  const lg = l.getContext("2d")!;
  lg.fillStyle = lg.strokeStyle = colour;
  lg.lineJoin = "round";
  // a solid core, feathered over two pixels outside it
  const passes = grow > 0 ? [[grow + 2, 0.35], [grow + 1, 0.7], [grow, 1]] : [[0, 1]];
  for (const [g, alpha] of passes) {
    lg.globalAlpha = alpha;
    lg.lineWidth = 2 * g;
    for (const q of quads) {
      lg.beginPath();
      // quads are in the pipeline's pixel-centre coordinates (see shaders.ts)
      q.forEach(([px, py]) => lg.lineTo(px - x + 0.5, py - y + 0.5));
      lg.closePath();
      lg.fill();
      if (g > 0) lg.stroke();
    }
  }
  return l;
}

function drawMatte(rect: Rect, cards: Quad[]): HTMLCanvasElement {
  const cv = canvas(rect[2], rect[3]);
  const g = cv.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = "lighter";
  g.drawImage(shape(rect, cards, "#f00", MATTE_GROW), 0, 0);
  g.drawImage(shape(rect, cards.slice(2), "#0f0"), 0, 0);
  return cv;
}

export type PlateSet = Record<SeatId, Record<number, SeatPlate>>;

/** Per seat, the bounding box of its compositing mask (R, G, B channel = seat 1, 2, 3). */
export function maskRects(mask: HTMLImageElement, seats: SeatId[]): Record<SeatId, [number, number, number, number]> {
  const cv = document.createElement("canvas");
  cv.width = mask.width;
  cv.height = mask.height;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(mask, 0, 0);
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  const out = {} as Record<SeatId, [number, number, number, number]>;
  seats.forEach((s, ch) => {
    let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (px[(y * cv.width + x) * 4 + ch] > 4) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    out[s] = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  });
  return out;
}

function seekFrame(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const done = () => {
      el.removeEventListener("seeked", done);
      // Prefer waiting for the seeked frame to be presented; a paused video that
      // isn't composited may never present, and by "seeked" the frame is decoded anyway.
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          res();
        }
      };
      el.requestVideoFrameCallback?.(finish);
      setTimeout(finish, 120);
    };
    el.addEventListener("seeked", done);
    el.currentTime = t;
  });
}

function whenLoaded(el: HTMLVideoElement): Promise<void> {
  return new Promise((res) => {
    if (el.readyState >= 2) return res();
    const done = () => {
      el.removeEventListener("loadeddata", done);
      res();
    };
    el.addEventListener("loadeddata", done);
  });
}

/**
 * Grab every plate: seek the plate's clip to its still frame and copy the
 * seat's box out. Using the browser's own decode of the same files keeps the
 * plates colour-identical to the footage they are laid into.
 */
export async function grabPlates(
  m: Manifest,
  files: ClipLoader,
  rects: Record<SeatId, [number, number, number, number]>,
  host: HTMLElement,
): Promise<PlateSet> {
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.style.cssText = "position:absolute;width:2px;height:2px;opacity:0.001;pointer-events:none";
  host.appendChild(el);
  const out = {} as PlateSet;
  const byClip = new Map<string, { seat: SeatId; n: number; plate: Plate }[]>();
  for (const seat of m.seats) {
    out[seat] = {};
    for (const [n, plate] of Object.entries(m.plates[seat])) {
      const list = byClip.get(plate.clip) ?? [];
      list.push({ seat, n: Number(n), plate });
      byClip.set(plate.clip, list);
    }
  }
  for (const [clip, list] of byClip) {
    el.src = await files.get(m.clips[clip].file);
    el.load();
    await whenLoaded(el);
    for (const { seat, n, plate } of list) {
      await seekFrame(el, (plate.frame + 0.5) / m.fps);
      const [x, y, w, h] = rects[seat];
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d")!.drawImage(el, x, y, w, h, 0, 0, w, h);
      out[seat][n] = { n, rect: rects[seat], image: cv, matte: drawMatte(rects[seat], plate.cards), cards: plate.cards };
    }
  }
  el.remove();
  return out;
}

/** A plate's still and matte, as textures. */
export interface PlateTexture {
  image: WebGLTexture;
  matte: WebGLTexture;
}

/**
 * A seat's hand as the round has it, whatever footage is on screen: its first two cards as the
 * take it was dealt in has them (a still of that take's own wait, grabbed once the round is dealt
 * there), and a bigger hand's others where the full-table round's dealer put them, as she is seen
 * dealing them. Over a hit, or a bridge, a seat then shows the very two cards the round's own
 * clips show, wherever each take's dealer put them, and the hit lands where it lands.
 */
export class RoundPlates {
  private stills = new Map<string, Partial<Record<SeatId, HTMLCanvasElement>>>();
  private asked = new Set<string>();
  private built = new Map<string, { plate: SeatPlate; tex: PlateTexture }>();

  constructor(
    private m: Manifest,
    private files: ClipLoader,
    private rects: Record<SeatId, Rect>,
    private host: HTMLElement,
    private plates: PlateSet,
    private texture: (src: TexImageSource) => WebGLTexture,
  ) {}

  /** The seat's hand of `n` (2 on) as the round dealt in take `mask` has it, in place; undefined until that take's still is in. */
  get(mask: string, seat: SeatId, n: number): { plate: SeatPlate; tex: PlateTexture } | undefined {
    const key = `${mask}/${seat}/${n}`;
    const done = this.built.get(key);
    if (done) return done;
    const stills = this.stills.get(mask);
    if (!stills) {
      void this.grab(mask);
      return undefined;
    }
    const still = stills[seat];
    const src = this.plates[seat][n];
    const own = [1, 2].map((i) => this.m.clips[clipName.wait(mask)].cards.find((c) => c.slot === seat && c.index === i)?.quad);
    if (!still || !src || n < 2 || !own[0] || !own[1]) return undefined;
    const plate = compose(still, src, [own[0], own[1]]);
    const out = { plate, tex: { image: this.texture(plate.image), matte: this.texture(plate.matte) } };
    this.built.set(key, out);
    return out;
  }

  /** Start grabbing take `mask`'s still (a round was dealt there), to be in long before its first hit. */
  prepare(mask: string) {
    void this.grab(mask);
  }

  /** Each seat of take `mask` as its wait loop (in memory once the round is dealt) shows it at rest. */
  private async grab(mask: string) {
    if (this.asked.has(mask)) return;
    this.asked.add(mask);
    const clip = this.m.clips[clipName.wait(mask)];
    const { from, n } = loopSpan(clip);
    const at = Math.min(Math.max(clip.still, from), from + n - 1);
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.style.cssText = "position:absolute;width:2px;height:2px;opacity:0.001;pointer-events:none";
    this.host.appendChild(el);
    try {
      el.src = await this.files.get(clip.loop ?? clip.file);
      el.load();
      await whenLoaded(el);
      await seekFrame(el, ((clip.loop ? at - from : at) + 0.5) / this.m.fps);
      const out: Partial<Record<SeatId, HTMLCanvasElement>> = {};
      for (const seat of this.m.seats) {
        if (!clip.cards.some((c) => c.slot === seat)) continue;
        const [x, y, w, h] = this.rects[seat];
        const cv = canvas(w, h);
        cv.getContext("2d")!.drawImage(el, x, y, w, h, 0, 0, w, h);
        out[seat] = cv;
      }
      this.stills.set(mask, out);
    } catch {
      // the footage didn't load: the round's hands go on being shown from the plates alone
    } finally {
      el.remove();
    }
  }
}

/** `still` (a seat with its first two cards, `own`) with `src`'s cards from the third on laid on. */
function compose(still: HTMLCanvasElement, src: SeatPlate, own: Quad[]): SeatPlate {
  const rect = src.rect;
  const cv = canvas(rect[2], rect[3]);
  const g = cv.getContext("2d")!;
  g.drawImage(still, 0, 0);
  const extras = src.cards.slice(2);
  if (extras.length) {
    const lay = canvas(rect[2], rect[3]);
    const lg = lay.getContext("2d")!;
    lg.drawImage(src.image, 0, 0);
    lg.globalCompositeOperation = "destination-in";
    lg.drawImage(shape(rect, extras, "#fff"), 0, 0);
    g.drawImage(lay, 0, 0);
  }
  const cards = [...own, ...extras];
  return { n: src.n, rect, image: cv, matte: drawMatte(rect, cards), cards };
}
