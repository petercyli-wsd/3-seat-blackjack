import type { Manifest, Plate, Quad, SeatId } from "./manifest";
import type { ClipLoader } from "./preload";

export interface SeatPlate {
  n: number;
  /** The seat's mask bounding box in video pixels, which is what the plate holds. */
  rect: [number, number, number, number];
  image: HTMLCanvasElement;
  /**
   * Over the image: red where its cards lie, green where its third card on lies, each grown by
   * MATTE_GROW px (their contact shadows) and feathered. A plate moved onto a take's own cards
   * lays in only its extra cards by the green, and is never clipped by the seat mask by the red.
   */
  matte: HTMLCanvasElement;
  cards: Quad[];
}

const MATTE_GROW = 3;

function drawMatte(rect: [number, number, number, number], cards: Quad[]): HTMLCanvasElement {
  const [x, y, w, h] = rect;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "lighter";
  const layer = (quads: Quad[], colour: string) => {
    const l = document.createElement("canvas");
    l.width = w;
    l.height = h;
    const lg = l.getContext("2d")!;
    lg.fillStyle = lg.strokeStyle = colour;
    lg.lineJoin = "round";
    // a solid core, feathered over two pixels outside it
    for (const [grow, alpha] of [[MATTE_GROW + 2, 0.35], [MATTE_GROW + 1, 0.7], [MATTE_GROW, 1]]) {
      lg.globalAlpha = alpha;
      lg.lineWidth = 2 * grow;
      for (const q of quads) {
        lg.beginPath();
        // quads are in the pipeline's pixel-centre coordinates (see shaders.ts)
        q.forEach(([px, py]) => lg.lineTo(px - x + 0.5, py - y + 0.5));
        lg.closePath();
        lg.fill();
        lg.stroke();
      }
    }
    g.drawImage(l, 0, 0);
  };
  layer(cards, "#f00");
  layer(cards.slice(2), "#0f0");
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
