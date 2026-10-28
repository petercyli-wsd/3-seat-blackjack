import type { Manifest, Pt, Quad } from "../media/manifest";
import { invert3 } from "../render/homography";

/** A playing card (mm): poker size, as the blanks dealt in the footage are. */
export const CARD_W = 63;
export const CARD_H = 88;

/** Where a card lies on the table: its centre (table mm) and how it is turned (radians). */
export interface Pose {
  x: number;
  y: number;
  a: number;
}

/** A card's corners about its centre (mm), in a face quad's order: TL, TR, BR, BL (TL -> TR its top edge). */
export const CORNERS: Pt[] = [[-CARD_W / 2, -CARD_H / 2], [CARD_W / 2, -CARD_H / 2], [CARD_W / 2, CARD_H / 2], [-CARD_W / 2, CARD_H / 2]];

/** Image pixels a height of 1 mm above the table rises by, per pixel a millimetre across the table spans
 * there: the camera looks down at the table steeply enough that a height shows nearly whole. */
const RISE = 0.9;
/** Rounds of the fit (each a pose per card, then the homography): it settles well within these. */
const FIT_ROUNDS = 80;

const project = (H: number[], [x, y]: Pt): Pt => {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
};

/** Rotated by a, about the origin. */
export const turn = ([x, y]: Pt, a: number): Pt => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

/**
 * The table as a plane: the homography from table millimetres to video pixels, fitted to the cards
 * lying on it in the holds (every take's, the full table's included), each a 63 x 88 mm rectangle
 * somewhere on it. So a card can be put anywhere on the table, turned any way, and drawn in the
 * table's own perspective, its size following its distance from the camera; and lifted off it.
 */
export class TableSpace {
  private constructor(private H: number[], private Hi: number[]) {}

  static fit(m: Manifest): TableSpace {
    const quads = Object.values(m.clips).filter((c) => c.kind === "hold").flatMap((c) => c.cards.map((k) => k.quad));
    // start from the dealer's up card alone, then alternately place every card (its pose, by the
    // current homography) and refit the homography to all their corners
    let H = dlt(CORNERS, m.dealer.up);
    for (let i = 0; i < FIT_ROUNDS; i++) {
      const src: Pt[] = [];
      const dst: Pt[] = [];
      const space = new TableSpace(H, invert3(H));
      for (const q of quads) {
        const p = space.pose(q);
        CORNERS.forEach((c, k) => {
          src.push(space.local(p, c));
          dst.push(q[k]);
        });
      }
      H = dlt(src, dst);
    }
    return new TableSpace(H, invert3(H));
  }

  /** Table mm -> video pixels. */
  toImage(p: Pt): Pt {
    return project(this.H, p);
  }

  toTable(p: Pt): Pt {
    return project(this.Hi, p);
  }

  /** A point on a card at pose p, given about the card's centre (mm) -> table mm. */
  local(p: Pose, c: Pt): Pt {
    const [x, y] = turn(c, p.a);
    return [p.x + x, p.y + y];
  }

  /** Where a card drawn on the video as quad q lies on the table (its corners fitted as a whole). */
  pose(q: Quad): Pose {
    const w = q.map((pt) => this.toTable(pt));
    const cx = w.reduce((s, p) => s + p[0], 0) / 4;
    const cy = w.reduce((s, p) => s + p[1], 0) / 4;
    let sin = 0, cos = 0;
    w.forEach(([x, y], i) => {
      const [rx, ry] = CORNERS[i];
      sin += rx * (y - cy) - ry * (x - cx);
      cos += rx * (x - cx) + ry * (y - cy);
    });
    return { x: cx, y: cy, a: Math.atan2(sin, cos) };
  }

  /** The card at pose p, on the video. */
  quad(p: Pose): Quad {
    return CORNERS.map((c) => this.toImage(this.local(p, c))) as Quad;
  }

  /** Video pixels a height of 1 mm above the table point t rises by (straight up the frame). */
  rise(t: Pt): number {
    const a = this.toImage(t);
    const b = this.toImage([t[0] + 1, t[1]]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) * RISE;
  }
}

/** The homography (row-major, H[8] = 1) taking the points src onto dst, by least squares (DLT). */
function dlt(src: Pt[], dst: Pt[]): number[] {
  const A = Array.from({ length: 8 }, () => new Array<number>(9).fill(0));
  const row = (r: number[], v: number) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) A[i][j] += r[i] * r[j];
      A[i][8] += r[i] * v;
    }
  };
  src.forEach(([X, Y], i) => {
    const [x, y] = dst[i];
    row([X, Y, 1, 0, 0, 0, -x * X, -x * Y], x);
    row([0, 0, 0, X, Y, 1, -y * X, -y * Y], y);
  });
  // Gauss-Jordan with partial pivoting on the 8 x 9 normal equations
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
