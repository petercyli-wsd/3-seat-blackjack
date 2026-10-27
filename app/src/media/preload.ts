import type { PackedFile } from "../render/stageArt";
import { ASSET_BASE, type Manifest, clipName } from "./manifest";

const WORKERS = 6;
const RETRIES = 3;

/**
 * Every clip is fetched into memory. Switching between in-memory blobs costs
 * one decoder spin-up (~a frame or two), where a network-backed src would
 * stall on range requests at exactly the moments the dealer has to move on cue.
 *
 * The table opens once the files it boots from are in (the opening idle and the
 * plate clips, ~10% of the footage); the rest keeps loading in round order, and a
 * file asked for before its turn jumps the queue.
 */
export class ClipLoader {
  private urls = new Map<string, string>();
  private waiting = new Map<string, { promise: Promise<string>; resolve: (u: string) => void; reject: (e: Error) => void }>();
  private queue: string[];
  readonly total: number;
  /** How many files at the head of the order the table needs before it can open. */
  readonly bootCount: number;
  done = 0;

  /**
   * `packed` names, for a file, the version of it with the dealer's matte stacked below the
   * picture (the pipeline's mattes pass): that is what is fetched for it, unless the file has
   * changed since it was packed (a bridge generated again), when the file itself is.
   */
  constructor(
    m: Manifest,
    private onProgress: (loaded: number, total: number) => void,
    private onError: (e: Error) => void,
    private packed: Record<string, PackedFile> = {},
  ) {
    const order = loadOrder(m);
    this.queue = order.files;
    this.total = order.files.length;
    this.bootCount = order.boot;
    for (const f of this.queue) {
      let resolve!: (u: string) => void, reject!: (e: Error) => void;
      const promise = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
      promise.catch(() => {}); // surfaced through onError; a play() waiting on it just never starts
      this.waiting.set(f, { promise, resolve, reject });
    }
    for (let i = 0; i < WORKERS; i++) void this.worker();
  }

  has(file: string) {
    return this.urls.has(file);
  }

  /** The file's blob URL, once it is in memory. */
  get(file: string): Promise<string> {
    const have = this.urls.get(file);
    if (have) return Promise.resolve(have);
    const w = this.waiting.get(file);
    if (!w) return Promise.reject(new Error(`${file}: not in the manifest`));
    const i = this.queue.indexOf(file);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    return w.promise;
  }

  private async worker() {
    for (let f = this.queue.shift(); f; f = this.queue.shift()) {
      const w = this.waiting.get(f)!;
      try {
        const p = this.packed[f];
        const src = p && (await sameSize(ASSET_BASE + f, p.sourceSize)) ? p.file : f;
        const url = URL.createObjectURL(new Blob([await fetchBlob(ASSET_BASE + src)], { type: "video/mp4" }));
        this.urls.set(f, url);
        w.resolve(url);
        this.onProgress(++this.done, this.total);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        w.reject(err);
        this.onError(err);
      }
    }
  }

  dispose() {
    this.queue = [];
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
  }
}

/** Whether a file is still the size it was (a HEAD request; a server that won't say counts as yes). */
async function sameSize(url: string, size: number): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    const n = Number(r.headers.get("content-length"));
    return !r.ok || !n || n === size;
  } catch {
    return true;
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.blob();
    } catch (e) {
      if (attempt >= RETRIES) throw e;
      await new Promise((res) => setTimeout(res, 500 * attempt));
    }
  }
}

/** Every file the table plays or grabs plates from: boot files first, then each round's clips in the order a round plays them. */
function loadOrder(m: Manifest): { files: string[]; boot: number } {
  const out: string[] = [];
  const add = (name: string, loop = false) => {
    const c = m.clips[name];
    const f = c && (loop ? c.loop : c.file);
    if (f && !out.includes(f)) out.push(f);
  };
  if (m.clips[clipName.openingIdle]?.loopFrom) add(clipName.openingIdle);
  add(clipName.openingIdle, true);
  for (const seat of m.seats) for (const p of Object.values(m.plates[seat])) add(p.clip);
  const boot = out.length;
  // the first thing a Deal plays is a bridge out of the betting idle
  const bridgesInto = (kind: string) => {
    for (const [name, c] of Object.entries(m.clips)) if (c.bridge && m.clips[c.bridge.to]?.kind === kind) add(name);
  };
  bridgesInto("deal");
  const masks = [...new Set(Object.values(m.clips).flatMap((c) => (c.kind === "deal" && c.part === 1 && c.mask ? [c.mask] : [])))];
  for (const step of ["deal", "wait", "reveal", "hold", "discard", "idle"] as const) {
    for (const mask of masks) {
      const name = clipName[step](mask);
      // a loop whose window starts late is entered by playing its lead-in from the plain file
      if (m.clips[name]?.loopFrom) add(name);
      add(name, step === "wait" || step === "hold" || step === "idle");
    }
  }
  bridgesInto("hit");
  bridgesInto("reveal");
  // and any other bridge, so nothing the director may choose is ever missing from the loader
  for (const [name, c] of Object.entries(m.clips)) if (c.bridge) add(name);
  for (const seat of m.playOrder) {
    for (let k = 3; k <= 6; k++) {
      add(clipName.hit(seat, k));
      add(clipName.hitWait(seat, k), true);
    }
  }
  // the rest of the take (part 2's deal, reveal and discard) is never played, so it is never downloaded
  return { files: out, boot };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`image ${src}`));
    img.src = src;
  });
}
