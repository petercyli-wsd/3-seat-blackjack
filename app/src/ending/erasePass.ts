import type { BarePlate } from "../media/barePlate";
import type { Manifest, Quad, SeatId } from "../media/manifest";
import type { CardDraw, CardPassEnv } from "../render/Compositor";
import { FULLSCREEN_VS } from "../render/shaders";

/** A hand on the table: the eraser's unit. */
export type Hand = SeatId | "dealer";
export const HANDS: Hand[] = ["seat1", "seat2", "seat3", "dealer"];

/** What one frame's erase covers: per hand (HANDS order) how far it is erased, and where its cards lie. */
export interface EraseJob {
  alpha: [number, number, number, number];
  /** Each card of a hand (and a graphic card's shadow), as an outline in video pixels; HANDS index. */
  quads: { quad: Quad; hand: number }[];
  /** Seats laid in whole from a plate (another take's still of the seat): its whole mask goes too. */
  whole: [boolean, boolean, boolean];
}

/** Outlines one pass takes (the uniform arrays' size): three full seats of six and the dealer's seven. */
const QUADS = 32;

/** Shared by both passes: the footage as pass 1 reads it, the keys, and the hands' outlines. */
const COMMON = /* glsl */ `
uniform sampler2D uVidA;
uniform sampler2D uVidB;
uniform int uPackA;
uniform int uPackB;
uniform float uMix;
uniform sampler2D uBare;
uniform vec4 uBareRect;
uniform vec2 uSize;
uniform vec2 uQuads[${QUADS * 4}];
uniform float uQuadHand[${QUADS}];
uniform int uQuadN;
// a card's contact shadow and the pipeline's outline error, then a soft edge
const float GROW = 3.5;
const float FEATHER = 4.0;
// as shaders.ts KEYS
float feltness(vec3 c) {
  return smoothstep(0.03, 0.12, c.b - max(c.r, c.g));
}
float stockness(vec3 c) {
  float notFelt = 1.0 - smoothstep(0.12, 0.22, c.b - max(c.r, c.g));
  float notSkin = 1.0 - smoothstep(0.03, 0.09, c.r - c.b);
  float lit = smoothstep(0.30, 0.45, min(min(c.r, c.g), c.b));
  return notFelt * notSkin * lit;
}
// as pass 1 reads the footage (a packed deck's picture is its top half)
vec2 picture(sampler2D v, int packed, vec2 uv) {
  if (packed == 0) return uv;
  return vec2(uv.x, min(uv.y * 0.5, 0.5 - 0.5 / float(textureSize(v, 0).y)));
}
vec3 frameAt(vec2 uv) {
  return mix(texture(uVidA, picture(uVidA, uPackA, uv)).rgb, texture(uVidB, picture(uVidB, uPackB, uv)).rgb, uMix);
}
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
float side(vec2 a, vec2 b, vec2 p) { return cross2(b - a, p - a) / max(length(b - a), 1e-3); }
// how far inside outline i p is, in px (negative: outside), whichever way round it runs
float inQuad(int i, vec2 p) {
  vec2 q0 = uQuads[i * 4], q1 = uQuads[i * 4 + 1], q2 = uQuads[i * 4 + 2], q3 = uQuads[i * 4 + 3];
  float o = sign(cross2(q2 - q0, q3 - q1));
  return min(min(o * side(q0, q1, p), o * side(q1, q2, p)), min(o * side(q2, q3, p), o * side(q3, q0, p)));
}
// per hand (seat 1-3, dealer), how much p (pipeline pixel coordinates) lies on its cards, grown and feathered
vec4 handsAt(vec2 p) {
  vec4 reg = vec4(0.0);
  for (int i = 0; i < ${QUADS}; i++) {
    if (i >= uQuadN) break;
    float r = 1.0 - smoothstep(GROW, GROW + FEATHER, -inQuad(i, p));
    reg = max(reg, r * vec4(equal(vec4(uQuadHand[i]), vec4(0.0, 1.0, 2.0, 3.0))));
  }
  return reg;
}
`;

/**
 * Pass A, over the bare plate's rect: the felt the frame and the plate both show there, away from
 * every hand's cards (their contact shadows would read as the light), each weighted by how surely
 * it is felt in both: the frame's colour and the plate's, premultiplied by that weight, into two
 * targets that are then mipmapped. A mip level's texel over either is a felt average over its
 * cell, the same pixels on both sides: how the felt is lit there, in the frame and in the plate.
 */
const STATS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
layout(location = 0) out vec4 outLive;
layout(location = 1) out vec4 outBare;
${COMMON}
void main() {
  // (the target is bottom-up: its row 0 holds the rect's bottom row, vUV.y = 1)
  vec2 px = uBareRect.xy + vUV * uBareRect.zw;
  vec3 l = frameAt(px / uSize);
  vec3 b = texture(uBare, vUV).rgb;
  vec4 reg = handsAt(px - 0.5);
  float w = feltness(l) * feltness(b) * (1.0 - max(max(reg.x, reg.y), max(reg.z, reg.w)));
  outLive = vec4(l * w, w);
  outBare = vec4(b * w, w);
}`;

/** Mip levels the light is read from (cells of 4 to 128 px) and how much each counts: the nearest felt most. */
const LIGHT_LEVELS = [2, 3, 4, 5, 6, 7];
const LIGHT_WEIGHTS = [1.6, 1.2, 0.9, 0.7, 0.5, 0.35];

/**
 * Pass B, the erase: run in the card order (CardDraw.pass) after the round's cards, so the
 * physical cards, the plates laid in for them and their faces are all dissolved together, as one
 * picture, into the bare felt (a clean crossfade: no face lingering over a fading card).
 *
 * Over each hand's cards (their outlines grown by GROW for the contact shadow, feathered over
 * FEATHER) the composite is mixed, by that hand's alpha, toward the bare plate (media/barePlate.ts)
 * lit as the frame on screen is: brought to the frame's own felt round the pixel (pass A's mips,
 * from cells of 4 px, which a hand's cards leave empty, out to 128 px, the finer counting for
 * more). The light so read is smooth everywhere, through the cards and out past them, and carries the frame's exposure (the takes differ by up to a tenth from the plate's) and
 * her shadow where it falls across the cards, so the plate has no edge anywhere. Only table goes,
 * as the footage shows it (felt, or card stock lit or in shade): her hands, arms and anything else
 * over the cards stay in front as filmed, as pass 1 keys a plate.
 */
const ERASE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uComp;
uniform sampler2D uMask;
uniform sampler2D uLive;
uniform sampler2D uLit;
uniform vec4 uAlpha;
uniform vec3 uWhole;
const int LEVELS = ${LIGHT_LEVELS.length};
const float LEVEL[LEVELS] = float[LEVELS](${LIGHT_LEVELS.map((l) => l.toFixed(1)).join(", ")});
const float LEVEL_W[LEVELS] = float[LEVELS](${LIGHT_WEIGHTS.map((l) => l.toFixed(2)).join(", ")});
// felt coverage (summed over the levels) below which the light read is taken as unsure
const float SURE = 0.01;
${COMMON}
void main() {
  vec2 px = vUV * uSize;
  vec4 reg = handsAt(px - 0.5);
  if (any(greaterThan(uWhole, vec3(0.0)))) {
    // a seat laid in whole: its mask, grown past its soft edge
    vec3 m = texture(uMask, vUV).rgb;
    for (int i = 0; i < 8; i++) {
      float t = float(i) * 0.7853982;
      m = max(m, texture(uMask, (px + 4.0 * vec2(cos(t), sin(t))) / uSize).rgb);
    }
    reg.rgb = max(reg.rgb, uWhole * smoothstep(0.0, 0.35, m));
  }
  vec4 by = reg * uAlpha;
  float w = max(max(by.x, by.y), max(by.z, by.w));
  if (w <= 0.0) discard;
  vec2 uv = (px - uBareRect.xy) / uBareRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
  vec3 plate = texture(uBare, uv).rgb;

  // what goes: table as the footage shows it, felt or card stock, dilated a pixel so the
  // compression rings round a card's edge go with it (pass 1's key)
  vec2 o = 1.25 / uSize;
  vec3 c = frameAt(vUV);
  float table = max(feltness(c), stockness(c));
  for (int i = 0; i < 4; i++) {
    vec3 s = frameAt(vUV + o * vec2(i == 0 || i == 2 ? 1.0 : -1.0, i < 2 ? 1.0 : -1.0));
    table = max(table, max(feltness(s), stockness(s)));
  }
  if (table <= 0.0) discard;

  // the plate's light matched to the frame's (pass A's targets are bottom-up)
  vec2 suv = vec2(uv.x, 1.0 - uv.y);
  vec4 live = vec4(0.0);
  vec3 bareFelt = vec3(0.0);
  for (int i = 0; i < LEVELS; i++) {
    live += LEVEL_W[i] * textureLod(uLive, suv, LEVEL[i]);
    bareFelt += LEVEL_W[i] * textureLod(uLit, suv, LEVEL[i]).rgb;
  }
  float n = live.a;
  // The felt round here, in the frame and in the plate: the plate is brought to the frame's mean,
  // per channel (an offset: the felt's red is near black, where the takes differ by a level or
  // two, which no gain could carry), its weave scaled by the change in light (her shadow darkens
  // the weave with the felt). Where there is little felt to read, the plate as it is.
  float sure = n / (n + SURE);
  vec3 mL = live.rgb / max(n, 1e-5), mP = bareFelt / max(n, 1e-5);
  float k = clamp(dot(mL, vec3(0.299, 0.587, 0.114)) / max(dot(mP, vec3(0.299, 0.587, 0.114)), 1e-3), 0.5, 1.5);
  vec3 felt = mix(plate, mL + k * (plate - mP), sure);
  vec4 under = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0);
  outColor = vec4(mix(under.rgb, clamp(felt, 0.0, 1.0), w * table), under.a);
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

function texture(gl: WebGL2RenderingContext, src: TexImageSource): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  return t;
}

/**
 * The table eraser: the bare plate, the seat masks (on the GPU for the pass, and on the CPU to
 * tell which hand a card is in), and the pass itself. Built once in table.ts; the bare plate comes
 * in a moment after the table opens (grabBarePlate), and until then nothing can be erased.
 */
export class TableEraser {
  private prog;
  private stats;
  private mask: WebGLTexture;
  private bare: {
    tex: WebGLTexture;
    rect: [number, number, number, number];
    /** Pass A's targets (the frame's felt and the plate's, premultiplied; mipmapped) and their framebuffer. */
    live: WebGLTexture;
    lit: WebGLTexture;
    fbo: WebGLFramebuffer;
  } | null = null;
  /** The seat masks' pixels (R, G, B = seat 1, 2, 3). */
  private maskPx: Uint8ClampedArray;

  constructor(
    private gl: WebGL2RenderingContext,
    private m: Manifest,
    mask: HTMLImageElement,
    private seatRects: Record<SeatId, [number, number, number, number]>,
  ) {
    this.prog = compile(gl, FULLSCREEN_VS, ERASE_FS);
    this.stats = compile(gl, FULLSCREEN_VS, STATS_FS);
    this.mask = texture(gl, mask);
    const cv = document.createElement("canvas");
    cv.width = m.width;
    cv.height = m.height;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(mask, 0, 0, m.width, m.height);
    this.maskPx = g.getImageData(0, 0, m.width, m.height).data;
  }

  /** The bare plate is in: erasing can start. */
  setBare(p: BarePlate) {
    const gl = this.gl;
    const [, , w, h] = p.rect;
    const target = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const live = target();
    const lit = target();
    const fbo = gl.createFramebuffer()!;
    const was = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, live, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, lit, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, was);
    this.bare = { tex: texture(gl, p.image), rect: p.rect, live, lit, fbo };
    if (import.meta.env.DEV) Object.assign(window, { __bare: p.image });
  }

  get ready() {
    return !!this.bare;
  }

  /** The seat whose mask holds video pixel (x, y) most, if any does. */
  seatAt(x: number, y: number): SeatId | null {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.m.width || yi >= this.m.height) return null;
    const i = (yi * this.m.width + xi) * 4;
    let best = -1, v = 32;
    for (let ch = 0; ch < 3; ch++) {
      if (this.maskPx[i + ch] > v) {
        v = this.maskPx[i + ch];
        best = ch;
      }
    }
    return best >= 0 ? this.m.seats[best] : null;
  }

  /** A seat's mask box (video px). */
  seatRect(seat: SeatId) {
    return this.seatRects[seat];
  }

  /** The job as an entry in the card order: the cards before it are erased, those after it are not. */
  entry(job: EraseJob): CardDraw {
    const quads = job.quads.slice(0, QUADS);
    // what the pass can touch: its outlines grown by as much as the shader grows them, and any
    // whole seat's mask box; the rest of the frame is left alone
    const xs: number[] = [], ys: number[] = [];
    for (const { quad, hand } of quads) {
      if (job.alpha[hand] <= 0) continue;
      for (const [x, y] of quad) {
        xs.push(x);
        ys.push(y);
      }
    }
    const pad = 10;
    job.whole.forEach((on, i) => {
      if (!on || job.alpha[i] <= 0) return;
      const [x, y, w, h] = this.seatRects[this.m.seats[i]];
      xs.push(x - pad, x + w + pad);
      ys.push(y - pad, y + h + pad);
    });
    const box = xs.length
      ? [Math.floor(Math.min(...xs)) - pad, Math.floor(Math.min(...ys)) - pad, Math.ceil(Math.max(...xs)) + pad, Math.ceil(Math.max(...ys)) + pad]
      : null;
    return {
      quad: [[0, 0], [0, 0], [0, 0], [0, 0]],
      cell: 0,
      alpha: 0,
      mode: "graphic",
      pass: (env) => {
        if (box) this.draw(env, { ...job, quads }, box);
      },
    };
  }

  private draw(env: CardPassEnv, job: EraseJob, box: number[]) {
    const { gl, size: [w, h] } = env;
    const bare = this.bare;
    if (!bare) return;
    const x0 = Math.max(0, box[0]), y0 = Math.max(0, box[1]);
    const x1 = Math.min(w, box[2]), y1 = Math.min(h, box[3]);
    if (x1 <= x0 || y1 <= y0) return;
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    };
    const outlines = new Float32Array(QUADS * 8);
    const hands = new Float32Array(QUADS);
    job.quads.forEach(({ quad, hand }, i) => {
      outlines.set(quad.flat(), i * 8);
      hands[i] = hand;
    });
    // the uniforms both passes share
    const common = (u: Record<string, WebGLUniformLocation | null>) => {
      bind(1, env.vidA, u.uVidA);
      bind(2, env.vidB, u.uVidB);
      bind(3, bare.tex, u.uBare);
      gl.uniform1i(u.uPackA, env.packA ? 1 : 0);
      gl.uniform1i(u.uPackB, env.packB ? 1 : 0);
      gl.uniform1f(u.uMix, env.mix);
      gl.uniform4fv(u.uBareRect, bare.rect);
      gl.uniform2f(u.uSize, w, h);
      gl.uniform2fv(u["uQuads[0]"], outlines);
      gl.uniform1fv(u["uQuadHand[0]"], hands);
      gl.uniform1i(u.uQuadN, job.quads.length);
    };

    // pass A: the felt round the hands, frame and plate, mipmapped
    gl.useProgram(this.stats.p);
    common(this.stats.u);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bare.fbo);
    gl.viewport(0, 0, bare.rect[2], bare.rect[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (const t of [bare.live, bare.lit]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, env.target);
    gl.viewport(0, 0, w, h);

    // pass B: the erase
    const { p, u } = this.prog;
    gl.useProgram(p);
    common(u);
    bind(0, env.comp, u.uComp);
    bind(4, this.mask, u.uMask);
    bind(5, bare.live, u.uLive);
    bind(6, bare.lit, u.uLit);
    gl.uniform4fv(u.uAlpha, job.alpha);
    gl.uniform3fv(u.uWhole, job.whole.map((on) => (on ? 1 : 0)));
    // the framebuffer is bottom-up
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, h - y1, x1 - x0, y1 - y0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    // the cards after this one read the erased composite
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, env.comp);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, h - y1, x0, h - y1, x1 - x0, y1 - y0);
  }
}
