import { ASSET_BASE, type Manifest } from "./manifest";

/**
 * Every clip is fetched into memory up front. Switching between in-memory
 * blobs costs one decoder spin-up (~a frame or two), where a network-backed
 * src would stall on range requests at exactly the moments the dealer has to
 * move on cue.
 */
export async function preloadClips(
  m: Manifest,
  onProgress: (loaded: number, total: number) => void,
): Promise<Map<string, string>> {
  const files = new Set<string>();
  for (const c of Object.values(m.clips)) {
    files.add(c.file);
    if (c.loop) files.add(c.loop);
  }
  const list = [...files];
  const urls = new Map<string, string>();
  let done = 0;
  onProgress(0, list.length);
  const queue = [...list];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await fetch(ASSET_BASE + f);
      if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
      const blob = await r.blob();
      urls.set(f, URL.createObjectURL(new Blob([blob], { type: "video/mp4" })));
      onProgress(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return urls;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`image ${src}`));
    img.src = src;
  });
}
