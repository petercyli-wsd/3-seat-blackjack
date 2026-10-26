import { ASSET_BASE, type Manifest, type Pt, type Quad } from "../media/manifest";
import { loadImage } from "../media/preload";
import { centre, invert3, squareToQuad } from "./homography";

/**
 * The set around the dealer: how the frame is cropped, the studio she is in and the felt of its
 * table, chosen separately. The pipeline's scene pass (bj3/scene.py) measures the cloth's top in
 * the frame and writes the masks the compositor keys her out with. Each studio is a generated set
 * (bj3/sets.py: nano-banana-pro restyling this app's own render of the empty set, so its camera
 * and its table are this take's), its felt generated blue; a table choice recolours that felt.
 *
 * The table painted here, on the cloth's plane (in cm, origin at the cloth's back-left corner, y
 * toward the camera), is that render's table (the generator's input), and where its felt lies.
 */

export type Framing = "dealer" | "studio";
/** "studio" keeps the room or the table as filmed. */
export type BackgroundId = string;
export type TableId = string;
export type Rect = [number, number, number, number];

/** The dealer framing: her head at about 15% of the height, the cloth's back edge just past half,
 * the seats' cards in the lower third (as on the live studio tables this copies). 16:9. */
export const DEALER_CROP: Rect = [226, 0, 1088, 612];
/** Output size of the cropped frame. */
export const DEALER_OUT: [number, number] = [1600, 900];

export interface SceneInfo {
  corners: Quad;
  planeCm: [number, number];
  reference: string;
  masks: string;
  clutter: string;
}

export interface StudioSet {
  id: BackgroundId;
  name: string;
  file: string;
  /** The generated felt's mean colour (0-1 RGB), which a table choice recolours from. */
  felt: [number, number, number];
  credit: string;
}

/** A table: its felt's colour, or null to leave the set's own (generated) felt. */
export interface Felt {
  id: TableId;
  name: string;
  colour: [number, number, number] | null;
}

export const FELTS: Felt[] = [
  { id: "studio-blue", name: "Studio Blue", colour: null },
  { id: "emerald", name: "Emerald", colour: [0.07, 0.36, 0.22] },
  { id: "crimson", name: "Crimson", colour: [0.55, 0.08, 0.1] },
  { id: "burgundy", name: "Burgundy", colour: [0.4, 0.11, 0.2] },
  { id: "onyx", name: "Onyx", colour: [0.12, 0.12, 0.13] },
  { id: "teal", name: "Teal", colour: [0.04, 0.32, 0.34] },
];

interface TableStyle {
  id: TableId;
  name: string;
  /** Felt at the centre and at the rail. */
  felt: [string, string];
  print: string;
  printSoft: string;
  leather: string;
  trim: string;
  /** Multiplies the walnut skirt. */
  skirt: [number, number, number];
  /** LED strip along the skirt's foot, or null. */
  led: [number, number, number] | null;
}

export interface TableArt {
  top: TexImageSource;
  /** Where its felt lies (alpha), in the same texture space as `top`. */
  felt: TexImageSource;
  /** Source pixel -> uv in the table-top texture (row-major 3x3). */
  toTop: number[];
  /** Skirt height in source pixels at source row y: a + b * y. */
  skirt: [number, number];
  skirtTint: [number, number, number];
  led: [number, number, number] | null;
}

/** The painted table: Studio Blue felt, black leather, gold trim, walnut skirt. */
const PAINTED: TableStyle = {
  id: "studio-blue", name: "Studio Blue",
  felt: ["#1658b4", "#082a6c"], print: "rgba(255,236,190,0.92)", printSoft: "rgba(255,236,190,0.7)",
  leather: "#1b1a1c", trim: "#d9b45c", skirt: [0.55, 0.42, 0.34], led: null,
};

// ---------- table geometry (cm on the cloth's plane) ----------

const RAIL_CM = 10;
const SKIRT_CM = 8;
const PX_PER_CM = 8;
/** Real-world size of one tile of each material's scan. */
const FELT_TILE_CM = 18;
const LEATHER_TILE_CM = 30;

interface Plane {
  W: number;
  /** Source px -> plane cm. */
  toPlane: number[];
  dealer: Pt;
  seats: { at: Pt; angle: number }[];
  a: number;
  b: number;
}

function apply(m: number[], [x, y]: Pt): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

const mean = (ps: Pt[]): Pt => [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];

function mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}

function plane(scene: SceneInfo, m: Manifest): Plane {
  const [W, D] = scene.planeCm;
  const H = mul([W, 0, 0, 0, D, 0, 0, 0, 1], invert3(squareToQuad(scene.corners)));
  // the table is centred on the dealer's two cards; each seat's betting box under its first two
  const dealer: Pt = [apply(H, mean([centre(m.dealer.up), centre(m.dealer.hole)]))[0], 0];
  const seats = m.seats.map((s) => {
    const at = apply(H, mean(m.plates[s][2].cards.map(centre)));
    return { at, angle: Math.atan2(at[0] - dealer[0], at[1] - dealer[1]) };
  });
  const reach = Math.max(...seats.map((s) => Math.hypot(s.at[0] - dealer[0], s.at[1])));
  return { W, toPlane: H, dealer, seats, a: Math.max(reach * 1.4, 100), b: reach + 20 };
}

/** The cloth's back edge as a line in source px (unit normal), positive toward the camera. */
export function backLine(scene: SceneInfo): [number, number, number] {
  const [[x0, y0], [x1, y1], front] = scene.corners;
  const a = y0 - y1, b = x1 - x0;
  const c = -(a * x0 + b * y0);
  const s = (a * front[0] + b * front[1] + c > 0 ? 1 : -1) / Math.hypot(a, b);
  return [s * a, s * b, s * c];
}

// ---------- painting ----------

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!] as const;
}

function arcText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, size: number, weight: number, spacing: number) {
  g.save();
  g.font = `${weight} ${size}px Inter, "Segoe UI", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const widths = [...text].map((ch) => g.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  // text reads left to right for the players, bowed toward them (centre of the arc behind it)
  let t = Math.PI / 2 + total / 2 / r;
  [...text].forEach((ch, i) => {
    const half = widths[i] / 2 / r;
    t -= half;
    g.save();
    g.translate(cx + r * Math.cos(t), cy + r * Math.sin(t));
    g.rotate(t - Math.PI / 2);
    g.fillText(ch, 0, 0);
    g.restore();
    t -= half;
  });
  g.restore();
}

function halfEllipse(g: CanvasRenderingContext2D, cx: number, a: number, b: number) {
  g.beginPath();
  g.moveTo(cx - a, 0);
  g.ellipse(cx, 0, a, b, 0, Math.PI, 0, true);
  g.closePath();
}

/** A material's grain laid over what is already there, tiled at its real size. */
function grain(g: CanvasRenderingContext2D, img: HTMLImageElement, tileCm: number, strength: number, x0: number, y0: number, w: number, h: number) {
  const pat = g.createPattern(img, "repeat")!;
  pat.setTransform(new DOMMatrix().scaleSelf(tileCm / img.width, tileCm / img.height));
  g.save();
  g.globalCompositeOperation = "overlay";
  g.globalAlpha = strength;
  g.fillStyle = pat;
  g.fillRect(x0, y0, w, h);
  g.restore();
}

function paintTop(p: Plane, t: TableStyle, mats: Materials) {
  const x0 = p.dealer[0] - p.a - RAIL_CM - 2;
  const x1 = p.dealer[0] + p.a + RAIL_CM + 2;
  const y0 = 0;
  const y1 = p.b + RAIL_CM + 2;
  const s = PX_PER_CM;
  const [c, g] = canvas(Math.round((x1 - x0) * s), Math.round((y1 - y0) * s));
  g.scale(s, s);
  g.translate(-x0, -y0);
  const cx = p.dealer[0];
  const { a, b } = p;

  // felt: lit from above the dealer, falling off toward the rail, with the scan's grain
  halfEllipse(g, cx, a, b);
  g.save();
  g.clip();
  const felt = g.createRadialGradient(cx, b * 0.35, 4, cx, b * 0.35, Math.max(a, b) * 1.15);
  felt.addColorStop(0, t.felt[0]);
  felt.addColorStop(1, t.felt[1]);
  g.fillStyle = felt;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  grain(g, mats.felt, FELT_TILE_CM, 0.55, x0, y0, x1 - x0, y1 - y0);

  // print
  g.fillStyle = t.print;
  arcText(g, "BLACKJACK PAYS 3 TO 2", cx, 0, 30.5, 4.1, 700, 0.4);
  g.fillStyle = t.printSoft;
  arcText(g, "Dealer stands on all 17s  ·  Six cards win", cx, 0, 36.4, 2.4, 500, 0.14);
  g.lineWidth = 0.3;
  g.strokeStyle = t.printSoft;
  g.beginPath();
  g.arc(cx, 0, 39.8, Math.PI * 0.18, Math.PI * 0.82);
  g.stroke();
  g.beginPath();
  g.arc(cx, 0, 26.4, Math.PI * 0.25, Math.PI * 0.75);
  g.stroke();
  // a betting box under each seat's cards, squared to the dealer
  p.seats.forEach((st, i) => {
    g.save();
    g.translate(st.at[0], st.at[1]);
    g.rotate(-st.angle);
    g.lineWidth = 0.35;
    g.strokeStyle = t.print;
    g.beginPath();
    g.roundRect(-8.5, -11, 17, 22, 2.2);
    g.stroke();
    g.fillStyle = t.printSoft;
    g.font = `700 3px Inter, "Segoe UI", Arial, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(i + 1), 0, 14.5);
    g.restore();
  });
  // the dealer's edge: a strip of the rail's leather along the straight side, trimmed
  g.fillStyle = t.leather;
  g.fillRect(x0, 0, x1 - x0, 1.6);
  g.fillStyle = t.trim;
  g.fillRect(x0, 1.6, x1 - x0, 0.35);
  g.restore();

  // padded rail: leather with its grain, rounded by light from above (crown lit, sides in shade)
  g.save();
  g.beginPath();
  g.ellipse(cx, 0, a + RAIL_CM, b + RAIL_CM, 0, 0, Math.PI);
  g.lineTo(cx - a, 0);
  g.ellipse(cx, 0, a, b, 0, Math.PI, 0, true);
  g.closePath();
  g.clip();
  g.fillStyle = t.leather;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  grain(g, mats.leather, LEATHER_TILE_CM, 0.7, x0, y0, x1 - x0, y1 - y0);
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps;
    const crown = Math.sin(Math.PI * Math.min(1, u * 1.1));
    g.lineWidth = RAIL_CM / steps + 0.1;
    g.beginPath();
    g.ellipse(cx, 0, a + u * RAIL_CM, b + u * RAIL_CM, 0, 0, Math.PI);
    g.strokeStyle = `rgba(0,0,0,${0.6 * (1 - crown) ** 1.6})`;
    g.stroke();
    g.strokeStyle = `rgba(255,255,255,${0.3 * Math.max(0, crown - 0.55) ** 2 * 4})`;
    g.stroke();
  }
  g.restore();
  // gold trim between the felt and the rail, round in section
  for (let i = 0; i < 6; i++) {
    const u = i / 5;
    g.strokeStyle = t.trim;
    g.globalAlpha = 0.55 + 0.45 * Math.sin(Math.PI * u);
    g.lineWidth = 0.2;
    g.beginPath();
    g.ellipse(cx, 0, a - 0.2 + u * 0.9, b - 0.2 + u * 0.9, 0, 0, Math.PI);
    g.stroke();
  }
  g.globalAlpha = 1;

  // where the felt lies, inside its trim
  const [fc, fg] = canvas(c.width, c.height);
  fg.scale(s, s);
  fg.translate(-x0, -y0);
  halfEllipse(fg, cx, a - 0.3, b - 0.3);
  fg.fillStyle = "#fff";
  fg.fill();

  const toTop = mul([1 / (x1 - x0), 0, -x0 / (x1 - x0), 0, 1 / (y1 - y0), -y0 / (y1 - y0), 0, 0, 1], p.toPlane);
  return { canvas: c, felt: fc, toTop };
}

interface Materials {
  felt: HTMLImageElement;
  leather: HTMLImageElement;
}

let materials: Promise<Materials> | null = null;
const loadMaterials = () =>
  (materials ??= Promise.all([loadImage(ASSET_BASE + "scene/materials/felt.jpg"), loadImage(ASSET_BASE + "scene/materials/leather.jpg")]).then(
    ([felt, leather]) => ({ felt, leather }),
  ));

/** The walnut the skirts are made of (the shader tints it per table). */
export const loadSkirtWood = () => loadImage(ASSET_BASE + "scene/materials/wood.jpg");

export async function loadSceneInfo(): Promise<SceneInfo | null> {
  try {
    const r = await fetch(ASSET_BASE + "scene/scene.json");
    return r.ok ? ((await r.json()) as SceneInfo) : null;
  } catch {
    return null;
  }
}

/** Clips packed with her matte (the pipeline's mattes pass): file -> packed file. */
export async function loadMattes(): Promise<Record<string, string>> {
  try {
    const r = await fetch(ASSET_BASE + "scene/mattes.json");
    if (!r.ok) return {};
    const listing = (await r.json()) as Record<string, { file: string }>;
    return Object.fromEntries(Object.entries(listing).map(([f, { file }]) => [f, file]));
  } catch {
    return {};
  }
}

export async function loadSets(): Promise<StudioSet[]> {
  try {
    const r = await fetch(ASSET_BASE + "scene/sets.json");
    return r.ok ? ((await r.json()) as StudioSet[]) : [];
  } catch {
    return [];
  }
}

/** A studio set, cover-fitted to the dealer framing's output. */
export async function paintSet(b: StudioSet): Promise<TexImageSource> {
  const img = await loadImage(ASSET_BASE + b.file);
  const [ow, oh] = DEALER_OUT;
  const [c, g] = canvas(ow, oh);
  const s = Math.max(ow / img.width, oh / img.height);
  g.drawImage(img, (ow - img.width * s) / 2, (oh - img.height * s) / 2, img.width * s, img.height * s);
  return c;
}

/** The painted table (the sets pass's input), and where its felt lies. */
export async function paintTable(scene: SceneInfo, m: Manifest): Promise<TableArt> {
  const t = PAINTED;
  const p = plane(scene, m);
  const top = paintTop(p, t, await loadMaterials());
  // skirt height (px): the plane's scale (px per cm) at its back and front edges, linear in y between
  const c = scene.corners;
  const yb = (c[0][1] + c[1][1]) / 2, sb = (c[1][0] - c[0][0]) / p.W;
  const yf = (c[2][1] + c[3][1]) / 2, sf = (c[2][0] - c[3][0]) / p.W;
  const slope = (sf - sb) / (yf - yb);
  return { top: top.canvas, felt: top.felt, toTop: top.toTop, skirt: [SKIRT_CM * (sb - slope * yb), SKIRT_CM * slope], skirtTint: t.skirt, led: t.led };
}
