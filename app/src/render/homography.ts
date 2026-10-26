import type { Pt, Quad } from "../media/manifest";

/** 3x3 homography (row-major) taking the unit square (0,0),(1,0),(1,1),(0,1) onto the quad. */
export function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** Column-major for gl.uniformMatrix3fv. */
export const toColumnMajor = (m: number[]) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export const translateQuad = (q: Quad, dx: number, dy: number): Quad =>
  q.map(([x, y]) => [x + dx, y + dy]) as Quad;

export function lerpQuad(a: Quad, b: Quad, t: number): Quad {
  return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]) as Quad;
}

export function scaleQuad(q: Quad, s: number, about?: Pt): Quad {
  const c = about ?? centre(q);
  return q.map(([x, y]) => [c[0] + (x - c[0]) * s, c[1] + (y - c[1]) * s]) as Quad;
}

export function rotateQuad(q: Quad, rad: number): Quad {
  const [cx, cy] = centre(q);
  const cs = Math.cos(rad), sn = Math.sin(rad);
  return q.map(([x, y]) => [cx + (x - cx) * cs - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * cs]) as Quad;
}

/** z -> a z + b on the video plane, a = ar + i ai (scale and rotation), b = (bx, by). */
export interface Similarity {
  ar: number;
  ai: number;
  bx: number;
  by: number;
}

export const IDENTITY: Similarity = { ar: 1, ai: 0, bx: 0, by: 0 };

/** Least-squares similarity taking the corners of the quads `src` onto those of `dst` (the pipeline's discard.similarity). */
export function fitSimilarity(src: Quad[], dst: Quad[]): Similarity {
  const z = src.flat(), w = dst.flat();
  const mean = (p: Pt[]) => p.reduce((s, q) => [s[0] + q[0] / p.length, s[1] + q[1] / p.length], [0, 0]);
  const [zx, zy] = mean(z), [wx, wy] = mean(w);
  let nr = 0, ni = 0, den = 0;
  z.forEach(([x, y], i) => {
    const dx = x - zx, dy = y - zy, ex = w[i][0] - wx, ey = w[i][1] - wy;
    // (w - w̄) · conj(z - z̄)
    nr += ex * dx + ey * dy;
    ni += ey * dx - ex * dy;
    den += dx * dx + dy * dy;
  });
  const ar = nr / den, ai = ni / den;
  return { ar, ai, bx: wx - (ar * zx - ai * zy), by: wy - (ai * zx + ar * zy) };
}

export const movePt = (s: Similarity, [x, y]: Pt): Pt => [s.ar * x - s.ai * y + s.bx, s.ai * x + s.ar * y + s.by];

export const moveQuad = (s: Similarity, q: Quad): Quad => q.map((p) => movePt(s, p)) as Quad;

export const lerpSimilarity = (a: Similarity, b: Similarity, t: number): Similarity => ({
  ar: a.ar + (b.ar - a.ar) * t,
  ai: a.ai + (b.ai - a.ai) * t,
  bx: a.bx + (b.bx - a.bx) * t,
  by: a.by + (b.by - a.by) * t,
});

export function invertSimilarity(s: Similarity): Similarity {
  const d = s.ar * s.ar + s.ai * s.ai;
  const ar = s.ar / d, ai = -s.ai / d;
  return { ar, ai, bx: -(ar * s.bx - ai * s.by), by: -(ai * s.bx + ar * s.by) };
}

export const centre = (q: Quad): Pt => [
  (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
  (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
];
