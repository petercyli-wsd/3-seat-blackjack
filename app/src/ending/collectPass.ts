import type { Quad } from "../media/manifest";
import type { CardDraw, CardPassEnv } from "../render/Compositor";
import { ATLAS_COLS, CELL_H, CELL_W, buildFaceAtlas, cellUV } from "../render/faceAtlas";
import { invert3, squareToQuad, toColumnMajor } from "../render/homography";
import { FULLSCREEN_VS } from "../render/shaders";

/** Instants a moving card is drawn at over the shutter (the most: fewer when it moves less). */
export const SAMPLES = 32;

/**
 * The atlas cell the footage deck's own back goes in (the game's atlas leaves the back row's
 * cells after its own free; this one has white faces round it, so its mips don't bleed). The
 * blanks dealt in the footage have a plain maroon back with a thin white border (the hole card face
 * down, the pile in the discard holder): a card the game turns over shows the same back.
 */
export const DECK_BACK = 4 * ATLAS_COLS + 6;
/** Its maroon, close to the footage's on the open felt as the pass draws it (x PAPER). */
const MAROON = "#7c4b5d";
/** The white border, as a share of the card's width (about 1 px of a 25 px card in the footage). */
const BORDER = 0.045;

/** A card the game draws, as the camera's shutter would see it. */
export interface ShutterCard {
  /** Its outline at instants spread evenly over the exposure (one when it is still). */
  quads: Quad[];
  /** The side showing at each: a face (faceIndex) or DECK_BACK. */
  cells: number[];
  /** The felt under it at each, where its contact shadow falls. */
  shadows: Quad[];
  alpha: number;
  /** How strong its shadow is (0..1 of a card lying on the felt's). */
  shadow: number;
  /** The light on it, per channel (1: the open felt's). */
  light: [number, number, number];
}

/**
 * One card, blurred over the shutter: for each pixel the card at every instant is looked up
 * (perspective correct, its corners rounded, its edge antialiased), and what covers the pixel is
 * averaged over them, so a moving card smears exactly as a filmed one does, its outline as well as
 * its face; under it, its soft contact shadow on the felt (only felt: not on cards, not on her),
 * blurred alike. Drawn whole over whatever lies there: these are cards on top of the table.
 */
const CARD_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uComp;
uniform sampler2D uAtlas;
uniform vec2 uSize;
uniform mat3 uInv[${SAMPLES}];
uniform mat3 uShadowInv[${SAMPLES}];
uniform vec4 uCell[${SAMPLES}];
uniform int uN;
uniform float uAlpha;
uniform float uShadow;
uniform vec3 uLight;
// the card stock as the footage's own reads on the felt, and its corners' radius (of its width)
const float PAPER = 0.97;
const float R = 0.09;
// the footage's cards are soft (lens, compression): their edge ramps over EDGE px, their faces a
// little softer than the atlas's mips (a lod bias), or a card's thin border would alias to dashes
const float EDGE = 1.6;
const float SOFT = 0.8;
// as the compositor's graphic cards' shadow
const float SHADOW = 0.45;
float feltness(vec3 c) {
  return smoothstep(0.03, 0.12, c.b - max(c.r, c.g));
}
vec2 project(mat3 m, vec2 p) {
  vec3 h = m * vec3(p, 1.0);
  return h.xy / h.z;
}
// how far (px) p lies inside the card m maps onto the unit square, by the map's own exact
// gradient there (screen-space derivatives come per 2 x 2 pixels, which steps a slanted edge)
float insideBy(mat3 m, vec2 p, out vec2 uv) {
  vec3 h = m * vec3(p, 1.0);
  uv = h.xy / h.z;
  vec2 dx = (m[0].xy - uv * m[0].z) / h.z;
  vec2 dy = (m[1].xy - uv * m[1].z) / h.z;
  vec2 g = max(vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y))), vec2(1e-6));
  vec2 edge = min(uv, 1.0 - uv) / g;
  return min(edge.x, edge.y);
}
void main() {
  // the pipeline's pixel-centre coordinates, as the quads are given in
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) - 0.5;
  vec4 under = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0);
  float cover = 0.0, shade = 0.0;
  vec3 face = vec3(0.0);
  for (int i = 0; i < ${SAMPLES}; i++) {
    if (i >= uN) break;
    vec2 uv;
    float in_ = insideBy(uInv[i], px, uv);
    vec2 d = max(abs(uv - 0.5) - (0.5 - R), 0.0);
    float w = clamp(in_ / EDGE + 0.5, 0.0, 1.0) * (1.0 - smoothstep(R - 0.03, R, length(d * vec2(1.0, 0.72))));
    cover += w;
    face += w * texture(uAtlas, mix(uCell[i].xy, uCell[i].zw, clamp(uv, 0.0, 1.0)), SOFT).rgb;
    vec2 s = max(abs(project(uShadowInv[i], px) - 0.5) - 0.38, 0.0);
    shade += 1.0 - smoothstep(0.0, 0.2, length(s));
  }
  float n = float(uN);
  vec3 base = under.rgb * (1.0 - SHADOW * uShadow * uAlpha * feltness(under.rgb) * shade / n);
  outColor = vec4(base * (1.0 - uAlpha * cover / n) + face * uLight * (PAPER * uAlpha / n), under.a);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const u = new Proxy({} as Record<string, WebGLUniformLocation | null>, {
    get: (cache, name: string) => (name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(p, name))),
  });
  return { p, u };
}

/** The game's face atlas, with the deck's back painted in. */
function atlasImage(): HTMLCanvasElement {
  const cv = buildFaceAtlas();
  const g = cv.getContext("2d")!;
  const x = (DECK_BACK % ATLAS_COLS) * CELL_W;
  const y = Math.floor(DECK_BACK / ATLAS_COLS) * CELL_H;
  g.fillStyle = "#ffffff";
  g.fillRect(x, y, CELL_W, CELL_H);
  const b = Math.round(CELL_W * BORDER);
  g.fillStyle = MAROON;
  g.fillRect(x + b, y + b, CELL_W - 2 * b, CELL_H - 2 * b);
  return cv;
}

/** Draws the collect's cards: built once per GL context, the first time a clear asks. */
export class CollectPainter {
  private prog;
  private atlas: WebGLTexture;

  private constructor(gl: WebGL2RenderingContext) {
    this.prog = compile(gl, FULLSCREEN_VS, CARD_FS);
    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasImage());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }

  private static all = new WeakMap<WebGL2RenderingContext, CollectPainter>();

  static for(gl: WebGL2RenderingContext): CollectPainter {
    let p = CollectPainter.all.get(gl);
    if (!p) CollectPainter.all.set(gl, (p = new CollectPainter(gl)));
    return p;
  }

  /** The cards as an entry in the card order (CardDraw.pass): bottom to top, over what is before it. */
  entry(cards: ShutterCard[]): CardDraw {
    return { quad: [[0, 0], [0, 0], [0, 0], [0, 0]], cell: 0, alpha: 0, mode: "graphic", pass: (env) => this.draw(env, cards) };
  }

  private draw(env: CardPassEnv, cards: ShutterCard[]) {
    const { gl, size: [w, h] } = env;
    const { p, u } = this.prog;
    gl.useProgram(p);
    gl.uniform2f(u.uSize, w, h);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.uniform1i(u.uAtlas, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, env.comp);
    gl.uniform1i(u.uComp, 0);
    gl.enable(gl.SCISSOR_TEST);
    const inv = new Float32Array(SAMPLES * 9);
    const sinv = new Float32Array(SAMPLES * 9);
    const cells = new Float32Array(SAMPLES * 4);
    for (const c of cards) {
      const n = Math.min(SAMPLES, c.quads.length);
      if (!n || c.alpha <= 0) continue;
      // the shadow as the compositor lays a graphic card's: pushed toward the camera a little and widened
      const shadows = c.shadows.slice(0, n).map((q) => {
        const s = q.map(([x, y]) => [x + 1.5, y + 2.5]);
        const cx = (s[0][0] + s[2][0]) / 2, cy = (s[0][1] + s[2][1]) / 2;
        return { at: s as Quad, grown: s.map(([x, y]) => [cx + (x - cx) * 1.18, cy + (y - cy) * 1.22]) as Quad };
      });
      for (let i = 0; i < n; i++) {
        inv.set(toColumnMajor(invert3(squareToQuad(c.quads[i]))), i * 9);
        sinv.set(toColumnMajor(invert3(squareToQuad(shadows[i].at))), i * 9);
        cells.set(cellUV(c.cells[i]), i * 4);
      }
      gl.uniformMatrix3fv(u["uInv[0]"], false, inv);
      gl.uniformMatrix3fv(u["uShadowInv[0]"], false, sinv);
      gl.uniform4fv(u["uCell[0]"], cells);
      gl.uniform1i(u.uN, n);
      gl.uniform1f(u.uAlpha, c.alpha);
      gl.uniform1f(u.uShadow, c.shadow);
      gl.uniform3fv(u.uLight, c.light);
      // only over what the card and its shadow can reach, at any instant
      const pts = [...c.quads.slice(0, n), ...shadows.map((s) => s.grown)].flat();
      const x0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[0]))) - 2);
      const x1 = Math.min(w, Math.ceil(Math.max(...pts.map((q) => q[0]))) + 3);
      const y0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[1]))) - 2);
      const y1 = Math.min(h, Math.ceil(Math.max(...pts.map((q) => q[1]))) + 3);
      if (x1 <= x0 || y1 <= y0) continue;
      // the framebuffer is bottom-up
      gl.scissor(x0, h - y1, x1 - x0, y1 - y0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // the next card (and the cards after this entry) read it
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, h - y1, x0, h - y1, x1 - x0, y1 - y0);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
}
