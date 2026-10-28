import type { Manifest, Quad, SeatId } from "./manifest";
import type { ClipLoader } from "./preload";

type Rect = [number, number, number, number];

/** The bare table: a still of the felt where the hands lie, the seats' and the dealer's alike, with nothing on it. */
export interface BarePlate {
  /** x, y, w, h in video pixels: where it was grabbed from. */
  rect: Rect;
  image: HTMLCanvasElement;
}

/** Frames of the empty-table clip the plate is made from. */
const SAMPLES = 16;
/** How far (px) round a sample must be felt too for it to count. */
const FELT_RING = 2;
/** Past the cards' area, room for the eraser's light match to read the felt around them (erasePass.ts). */
const MARGIN = 56;

/**
 * Where the bare plate has to cover: every seat's mask, the dealer's two cards, and the row her
 * graphic draws go in, with room round them.
 */
export function bareRect(m: Manifest, seatRects: Record<SeatId, Rect>, extras: Quad[]): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y, w, h] of Object.values(seatRects)) {
    xs.push(x, x + w);
    ys.push(y, y + h);
  }
  for (const q of [m.dealer.up, m.dealer.hole, ...extras]) {
    for (const [x, y] of q) {
      xs.push(x);
      ys.push(y);
    }
  }
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - MARGIN);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - MARGIN);
  const x1 = Math.min(m.width, Math.ceil(Math.max(...xs)) + MARGIN);
  const y1 = Math.min(m.height, Math.ceil(Math.max(...ys)) + MARGIN);
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The table with nothing on it, under `rect`: the per-pixel median, over frames spread through the
 * empty-table clip (the one the seats' empty plates come from, in memory from boot), of the frames
 * where that pixel shows felt. Her hands wander over the dealer's spot in that clip (resting, then
 * clasped in front of her), so no one frame of it is bare there; each pixel is bare in most of them,
 * and the median keeps the felt's own weave and the light it lies in, dropping her and the shadows
 * that pass over it. Grabbed through the browser's own decode, as the seat plates are, so its
 * colours are the footage's. The eraser matches its light to the frame on screen.
 */
export async function grabBarePlate(m: Manifest, files: ClipLoader, rect: Rect, host: HTMLElement): Promise<BarePlate> {
  const name = m.plates[m.seats[0]]?.["0"]?.clip ?? Object.keys(m.clips).find((k) => m.clips[k].kind === "idle")!;
  const clip = m.clips[name];
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.style.cssText = "position:absolute;width:2px;height:2px;opacity:0.001;pointer-events:none";
  host.appendChild(el);
  const [x, y, w, h] = rect;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  const frames: Uint8ClampedArray[] = [];
  try {
    el.src = await files.get(clip.file);
    el.load();
    await whenLoaded(el);
    for (let i = 0; i < SAMPLES; i++) {
      const f = Math.round(((i + 0.5) / SAMPLES) * (clip.frames - 1));
      await seekFrame(el, (f + 0.5) / m.fps);
      g.drawImage(el, x, y, w, h, 0, 0, w, h);
      frames.push(g.getImageData(0, 0, w, h).data);
    }
  } finally {
    el.remove();
  }
  const out = g.createImageData(w, h);
  const o = out.data;
  const n = frames.length;
  // Felt as the shaders' feltness has it (strongly blue; in her shadow too: the median, of mostly
  // lit samples, passes over the few shaded ones), and so all round within FELT_RING px: the rim of
  // her fingers is half felt, and would leave their outline in the plate.
  const felt = frames.map((d) => {
    const blue = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) blue[i] = (d[i * 4 + 2] - Math.max(d[i * 4], d[i * 4 + 1])) / 255;
    return erode(erode(blue, w, h, 1, 0), w, h, 0, 1);
  });
  const r = new Float32Array(n), gr = new Float32Array(n), b = new Float32Array(n);
  for (let p = 0; p < w * h * 4; p += 4) {
    let k = 0;
    let best = 0, bestF = -1;
    for (let i = 0; i < n; i++) {
      const d = frames[i];
      const blue = felt[i][p / 4];
      if (blue > bestF) {
        bestF = blue;
        best = i;
      }
      if (blue < 0.12) continue;
      r[k] = d[p];
      gr[k] = d[p + 1];
      b[k] = d[p + 2];
      k++;
    }
    if (k === 0) {
      // never felt here (a prop on the table): the frame that comes closest
      const d = frames[best];
      o.set([d[p], d[p + 1], d[p + 2], 255], p);
      continue;
    }
    o[p] = median(r, k);
    o[p + 1] = median(gr, k);
    o[p + 2] = median(b, k);
    o[p + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return { rect, image: cv };
}

/** Each value the least of itself and its neighbours within FELT_RING px along (dx, dy). */
function erode(v: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(v.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let lo = v[y * w + x];
      for (let s = -FELT_RING; s <= FELT_RING; s++) {
        const xx = Math.min(w - 1, Math.max(0, x + s * dx)), yy = Math.min(h - 1, Math.max(0, y + s * dy));
        lo = Math.min(lo, v[yy * w + xx]);
      }
      out[y * w + x] = lo;
    }
  }
  return out;
}

function median(v: Float32Array, k: number): number {
  const s = Array.from(v.subarray(0, k)).sort((p, q) => p - q);
  return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2;
}

function whenLoaded(el: HTMLVideoElement): Promise<void> {
  return new Promise((res) => {
    if (el.readyState >= 2) return res();
    el.addEventListener("loadeddata", () => res(), { once: true });
  });
}

/** Seek, and wait for the frame to be there (plates.ts's: a paused hidden video may never present it). */
function seekFrame(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    el.addEventListener(
      "seeked",
      () => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          res();
        };
        el.requestVideoFrameCallback?.(finish);
        setTimeout(finish, 120);
      },
      { once: true },
    );
    el.currentTime = t;
  });
}
