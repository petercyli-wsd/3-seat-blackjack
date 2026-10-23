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

export const centre = (q: Quad): Pt => [
  (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
  (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
];
