import { RANKS, RANK_LABEL, SUITS, SUIT_GLYPH } from "../engine/cards";

export const CELL_W = 192;
export const CELL_H = 268;
export const ATLAS_COLS = 13;
/** Rows 0-3 are suits (S, H, D, C); row 4 col 0 is the card back. */
export const ATLAS_ROWS = 5;
export const BACK_INDEX = 4 * 13;

const RED = "#c3122f";
const BLACK = "#14141a";

/**
 * Faces use real corner indices — a big rank over its suit in the top-left,
 * one large pip bottom-right. In a fanned hand each card covers the middle
 * of the one before, and the top-left index is what stays visible, exactly
 * as with physical cards. Sizes are oversized for legibility at ~30 px on
 * the table. The card stock stays pure white so the shader's shading
 * transfer (face x footage luminance) keeps the real lighting of the blank.
 */
export function buildFaceAtlas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = CELL_W * ATLAS_COLS;
  cv.height = CELL_H * ATLAS_ROWS;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, cv.width, cv.height);
  const font = `Inter, "Segoe UI", system-ui, sans-serif`;
  const symbols = `"Segoe UI Symbol", "Noto Sans Symbols 2", system-ui, sans-serif`;
  SUITS.forEach((s, row) => {
    RANKS.forEach((r, col) => {
      const x = col * CELL_W;
      const y = row * CELL_H;
      g.fillStyle = s === "H" || s === "D" ? RED : BLACK;
      const lab = RANK_LABEL[r];
      g.textBaseline = "alphabetic";
      g.textAlign = "left";
      g.font = `800 ${lab.length > 1 ? 84 : 104}px ${font}`;
      g.save();
      if (lab.length > 1) {
        g.translate(x + 10, y + 96);
        g.scale(0.82, 1);
        g.fillText(lab, 0, 0);
      } else {
        g.fillText(lab, x + 16, y + 96);
      }
      g.restore();
      g.textAlign = "center";
      g.font = `78px ${symbols}`;
      g.fillText(SUIT_GLYPH[s], x + 52, y + 168);
      g.font = `128px ${symbols}`;
      g.fillText(SUIT_GLYPH[s], x + CELL_W - 58, y + CELL_H - 18);
    });
  });
  drawBack(g, 0, 4 * CELL_H);
  return cv;
}

function drawBack(g: CanvasRenderingContext2D, x: number, y: number) {
  const grd = g.createLinearGradient(x, y, x + CELL_W, y + CELL_H);
  grd.addColorStop(0, "#1e1e1e");
  grd.addColorStop(1, "#0a0a0a");
  g.fillStyle = grd;
  g.fillRect(x, y, CELL_W, CELL_H);
  g.strokeStyle = "#d4af37";
  g.lineWidth = 6;
  g.strokeRect(x + 14, y + 14, CELL_W - 28, CELL_H - 28);
  g.save();
  g.translate(x + CELL_W / 2, y + CELL_H / 2);
  g.fillStyle = "#d4af37";
  for (let i = 0; i < 8; i++) {
    g.rotate(Math.PI / 4);
    g.beginPath();
    g.moveTo(0, -70);
    g.lineTo(9, -10);
    g.lineTo(-9, -10);
    g.closePath();
    g.fill();
  }
  g.restore();
}

export function cellUV(index: number): [number, number, number, number] {
  const col = index % ATLAS_COLS;
  const row = Math.floor(index / ATLAS_COLS);
  const W = CELL_W * ATLAS_COLS;
  const H = CELL_H * ATLAS_ROWS;
  const inset = 2;
  return [
    (col * CELL_W + inset) / W,
    (row * CELL_H + inset) / H,
    ((col + 1) * CELL_W - inset) / W,
    ((row + 1) * CELL_H - inset) / H,
  ];
}
