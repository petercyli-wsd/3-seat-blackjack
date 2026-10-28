import type { Pt, Quad } from "../media/manifest";
import { cellUV } from "./faceAtlas";
import { IDENTITY, type Similarity, invert3, invertSimilarity, squareToQuad, toColumnMajor } from "./homography";
import { BLIT_FS, CARD_FS, CARD_VS, COMPOSITE_FS, FULLSCREEN_VS, SHADOW_FS, STAGE_FS } from "./shaders";
import type { Rect, TableArt } from "./stageArt";

export interface PlateDraw {
  tex: WebGLTexture;
  /** Its matte (plates.ts): red where its cards lie, green where its third card on lies. */
  matte: WebGLTexture;
  /** x, y, w, h in video pixels: where the still was grabbed from. */
  rect: [number, number, number, number];
  /** Where it goes: still pixels -> video pixels. */
  place: Similarity;
  /**
   * whole: the whole seat (its mask) and its own cards; extras: only its cards from the third on
   * (over a take holding the hand's first two); match: over another take than the round's,
   * wherever that take (its own still of the seat, `ref`, and the still's matte) or the plate has
   * a card and the frame shows table, darkened by her shadow, so her hand and a card she is
   * dealing there (`dealing`, its outline, kept as filmed whatever it looks like) stay; dealing:
   * match at the seat being dealt to, where only the first two cards differ from the take's.
   */
  mode: "whole" | "extras" | "match" | "dealing";
  ref?: { tex: WebGLTexture; matte: WebGLTexture; rect: [number, number, number, number] };
  dealing?: Pt[] | null;
  alpha: number;
}

const PLATE_MODE = { whole: 0, extras: 1, match: 2, dealing: 3 } as const;
/** Corners a dealt card's outline can have (the shader's uNew). */
const NEW_MAX = 16;
/** Cards drawn in a frame whose outlines the stage pass spares from erasing clutter (its uCards). */
const STAGE_CARDS = 32;

/** Video pixel (GL's, edges on integers) -> a still's texture UV, back through its placing. */
function plateUV(rect: [number, number, number, number], place: Similarity): number[] {
  const s = invertSimilarity(place);
  const [rx, ry, rw, rh] = rect;
  // the placing is in the pipeline's pixel-centre coordinates: half a pixel off GL's (shaders.ts)
  return toColumnMajor([
    s.ar / rw, -s.ai / rw, (s.bx - 0.5 * s.ar + 0.5 * s.ai + 0.5 - rx) / rw,
    s.ai / rh, s.ar / rh, (s.by - 0.5 * s.ai - 0.5 * s.ar + 0.5 - ry) / rh,
    0, 0, 1,
  ]);
}

export interface CardDraw {
  quad: Quad;
  /** The card's outline a frame earlier, when it is moving: the face is motion-blurred along that move. */
  prev?: Quad;
  /** Atlas cell: faceIndex(card), or BACK_INDEX. */
  cell: number;
  alpha: number;
  /** footage: face laid on a physical card; graphic: a rendered card with no physical counterpart. */
  mode: "footage" | "graphic";
  /**
   * Not a face: a pass run over the frame at this point in the card order (the no-discard eraser,
   * ending/erasePass.ts). The cards before it are under it, the cards after it over it. Give it
   * alpha 0, so the stage pass doesn't take its quad for a card's.
   */
  pass?: (env: CardPassEnv) => void;
}

/** What a pass in the card order (CardDraw.pass) draws with. */
export interface CardPassEnv {
  gl: WebGL2RenderingContext;
  /** The composite so far, to read (texel = gl_FragCoord); the pass copies what it changes back into it. */
  comp: WebGLTexture;
  /** Bound, at the frame's size: where the pass draws. */
  target: WebGLFramebuffer;
  /** The footage as pass 1 read it (her, the table and the real cards; no plates, no faces). */
  vidA: WebGLTexture;
  vidB: WebGLTexture;
  packA: boolean;
  packB: boolean;
  mix: number;
  size: [number, number];
}

/** What the canvas shows of the composite: a crop of it, at an output size, and the studio set
 * she is put in (null keeps the set as filmed). */
export interface StageDraw {
  crop: Rect;
  out: [number, number];
  set: TexImageSource | null;
  /** The set's table in place of the one filmed (null keeps the filmed table), its felt recoloured
   * from the colour it was generated in to another, or left. */
  table: { art: TableArt; recolor: { from: [number, number, number]; to: [number, number, number] } | null } | null;
  /** Draw the painted table over the set: the input the pipeline's sets pass restyles. */
  painted?: boolean;
  /** The footage's tint toward the set's light (per channel; none: as filmed). */
  tint?: [number, number, number];
}

export interface FrameDraw {
  a: TexImageSource;
  b?: TexImageSource;
  mix: number;
  plates: (PlateDraw | null)[];
  cards: CardDraw[];
  showMasks?: boolean;
}

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

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private comp;
  private blit;
  private card;
  private shadow;
  private stage;
  private vidA: WebGLTexture;
  private vidB: WebGLTexture;
  private mask: WebGLTexture;
  private atlas: WebGLTexture;
  private black: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  /** The full-size frame with the cards on it, before the crop: what pass 3 reads. */
  private scr: WebGLFramebuffer;
  private scrTex: WebGLTexture;
  private sceneRef: WebGLTexture;
  private sceneMasks: WebGLTexture;
  private sceneClutter: WebGLTexture;
  private bgTex: WebGLTexture;
  private topTex: WebGLTexture;
  private feltTex: WebGLTexture;
  private woodTex: WebGLTexture;
  private backLine: [number, number, number] = [0, 0, 0];
  private view: StageDraw;
  private quadBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  readonly w: number;
  readonly h: number;
  /** Draw the set alone, without her: the input the pipeline's set generation restyles. */
  setOnly = false;
  /** This frame's, for a pass in the card order (CardDraw.pass). */
  private passEnv: CardPassEnv | null = null;

  constructor(canvas: HTMLCanvasElement, w: number, h: number, maskImg: TexImageSource, atlasImg: TexImageSource) {
    this.w = w;
    this.h = h;
    canvas.width = w;
    canvas.height = h;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;
    this.comp = compile(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.blit = compile(gl, FULLSCREEN_VS, BLIT_FS);
    this.card = compile(gl, CARD_VS, CARD_FS);
    this.shadow = compile(gl, CARD_VS, SHADOW_FS);
    this.stage = compile(gl, FULLSCREEN_VS, STAGE_FS);
    this.vidA = this.texture();
    this.vidB = this.texture();
    this.black = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.mask = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskImg);
    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasImg);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    this.fboTex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    this.scrTex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.scr = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scr);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scrTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sceneRef = this.black;
    this.sceneMasks = this.black;
    this.sceneClutter = this.black;
    this.bgTex = this.texture();
    this.topTex = this.texture();
    this.feltTex = this.texture();
    this.woodTex = this.black;
    this.view = { crop: [0, 0, w, h], out: [w, h], set: null, table: null };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 8 * 4, gl.DYNAMIC_DRAW);
    for (const prog of [this.card.p, this.shadow.p]) {
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
  }

  texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Upload a still (a plate grabbed from a clip) as its own texture. */
  imageTexture(src: TexImageSource): WebGLTexture {
    const gl = this.gl;
    const t = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    return t;
  }

  /** The pipeline's scene pass: the set without her, the masks she is keyed out with, the cloth's
   * back edge (a line in source px, positive toward the camera), and the skirts' wood. */
  setScene(ref: TexImageSource, masks: TexImageSource, clutter: TexImageSource, backLine: [number, number, number], wood: TexImageSource) {
    const gl = this.gl;
    this.sceneRef = this.imageTexture(ref);
    this.sceneMasks = this.imageTexture(masks);
    this.sceneClutter = this.imageTexture(clutter);
    // mipmapped: blurred, the props' outlines are their contact shadows
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.backLine = backLine;
    this.woodTex = this.imageTexture(wood);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  setView(v: StageDraw) {
    const gl = this.gl;
    this.view = v;
    const canvas = gl.canvas as HTMLCanvasElement;
    if (canvas.width !== v.out[0] || canvas.height !== v.out[1]) {
      canvas.width = v.out[0];
      canvas.height = v.out[1];
    }
    if (v.set) {
      // mipmapped: its blur is the light that wraps round her edges
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.set);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    if (v.table) {
      // the painted top and its felt are cut out (alpha): premultiplied, so their edges don't fringe
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      for (const [tex, img] of [[this.topTex, v.table.art.top], [this.feltTex, v.table.art.felt]] as const) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
  }

  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  render(f: FrameDraw) {
    const gl = this.gl;
    const { w, h } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.vidA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.a);
    if (f.b && f.mix > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.vidB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.b);
    }

    // a deck playing a clip packed with her matte is twice the frame's height
    const packed = (src: TexImageSource | undefined) => src instanceof HTMLVideoElement && src.videoHeight > h * 1.5;
    const mixing = !!f.b && f.mix > 0;
    const packA = packed(f.a);
    const packB = mixing ? packed(f.b) : packA;

    // pass 1: footage + plates -> fbo (her matte, where there is one, in alpha)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.comp.p);
    const u = this.comp.u;
    this.bind(0, this.vidA, u.uVidA);
    this.bind(1, mixing ? this.vidB : this.vidA, u.uVidB);
    gl.uniform1i(u.uPackA, packA ? 1 : 0);
    gl.uniform1i(u.uPackB, packB ? 1 : 0);
    gl.uniform1f(u.uMix, f.b ? f.mix : 0);
    this.passEnv = { gl, comp: this.fboTex, target: this.scr, vidA: this.vidA, vidB: mixing ? this.vidB : this.vidA, packA, packB, mix: f.b ? f.mix : 0, size: [w, h] };
    this.bind(2, this.mask, u.uMask);
    const uv = new Float32Array(27);
    const refUV = new Float32Array(27);
    const on = new Float32Array(3);
    const modes = new Float32Array(3);
    for (let i = 0; i < 3; i++) {
      const p = f.plates[i];
      this.bind(3 + i, p ? p.tex : this.black, u[`uPlate${i}`]);
      this.bind(6 + i, p ? p.matte : this.black, u[`uMatte${i}`]);
      this.bind(9 + i, p?.ref ? p.ref.tex : this.black, u[`uRef${i}`]);
      this.bind(12 + i, p?.ref ? p.ref.matte : this.black, u[`uRefMatte${i}`]);
      if (p) {
        uv.set(plateUV(p.rect, p.place), i * 9);
        refUV.set(plateUV(p.ref?.rect ?? p.rect, IDENTITY), i * 9);
        on[i] = p.alpha;
        modes[i] = PLATE_MODE[p.mode];
      }
    }
    gl.uniformMatrix3fv(u["uPlateUV[0]"], false, uv);
    gl.uniformMatrix3fv(u["uRefUV[0]"], false, refUV);
    gl.uniform1fv(u["uPlateOn[0]"], on);
    gl.uniform1fv(u["uPlateMode[0]"], modes);
    // one seat at a time is dealt a hit: the card coming in
    const dealing = f.plates.find((p) => p?.dealing)?.dealing?.slice(0, NEW_MAX) ?? [];
    const outline = new Float32Array(NEW_MAX * 2);
    outline.set(dealing.flat());
    gl.uniform2fv(u["uNew[0]"], outline);
    gl.uniform1i(u.uNewN, dealing.length);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform1i(u.uShowMasks, f.showMasks ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // pass 2: blit to the full-size frame, then the cards, each reading the composite beneath it
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scr);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blit.p);
    this.bind(0, this.fboTex, this.blit.u.uComp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCards(f.cards);

    // pass 3: crop it to the canvas, and put her in the set
    const v = this.view;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, v.out[0], v.out[1]);
    gl.useProgram(this.stage.p);
    const su = this.stage.u;
    this.bind(0, this.scrTex, su.uComp);
    this.bind(1, this.sceneRef, su.uRef);
    this.bind(2, this.sceneMasks, su.uMasks);
    this.bind(3, this.bgTex, su.uSet);
    this.bind(4, this.topTex, su.uTop);
    this.bind(5, this.woodTex, su.uWood);
    this.bind(6, this.sceneClutter, su.uClutter);
    this.bind(7, this.feltTex, su.uFelt);
    gl.uniform2f(su.uSize, w, h);
    gl.uniform4fv(su.uCrop, v.crop);
    gl.uniform3fv(su.uBackLine, this.backLine);
    gl.uniform1i(su.uSetOnly, this.setOnly ? 1 : 0);
    gl.uniform1i(su.uHasMatte, packA && packB ? 1 : 0);
    gl.uniform3fv(su.uTint, v.tint ?? [1, 1, 1]);
    gl.uniform1f(su.uSeed, Math.random() * 512);
    const drawn = f.cards.filter((c) => c.alpha > 0).slice(0, STAGE_CARDS);
    const outlines = new Float32Array(STAGE_CARDS * 8);
    drawn.forEach((c, i) => outlines.set(c.quad.flat(), i * 8));
    gl.uniform2fv(su["uCards[0]"], outlines);
    gl.uniform1i(su.uCardN, drawn.length);
    // the mask overlay is for the plates: show the footage as filmed under it
    gl.uniform1i(su.uHasSet, v.set && !f.showMasks ? 1 : 0);
    const table = v.table;
    gl.uniform1i(su.uSwapTable, table ? 1 : 0);
    gl.uniform1i(su.uPainted, table && v.painted ? 1 : 0);
    gl.uniform1i(su.uRecolor, table?.recolor ? 1 : 0);
    if (table) {
      const t = table.art;
      gl.uniformMatrix3fv(su.uToTop, false, toColumnMajor(t.toTop));
      gl.uniform2fv(su.uSkirt, t.skirt);
      gl.uniform3fv(su.uSkirtTint, t.skirtTint);
      gl.uniform3fv(su.uLed, t.led ?? [0, 0, 0]);
      if (table.recolor) {
        gl.uniform3fv(su.uFeltBase, table.recolor.from);
        gl.uniform3fv(su.uFeltColor, table.recolor.to);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawCards(cards: CardDraw[]) {
    const gl = this.gl;
    if (!cards.length) return;
    // Cards overlap (a hit lands on the card before it), so each card must read
    // the composite *including* the faces already drawn under it.
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    for (const c of cards) {
      if (c.pass && this.passEnv) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scr);
        c.pass(this.passEnv);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        continue;
      }
      if (c.alpha <= 0) continue;
      const invH = toColumnMajor(invert3(squareToQuad(c.quad)));
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(c.quad.flat()));
      if (c.mode === "graphic") {
        // shadow: the card's quad pushed toward the camera a little and widened
        const sq = c.quad.map(([x, y]) => [x + 1.5, y + 2.5]) as Quad;
        const grow = sq.map(([x, y], _i, all) => {
          const cx = (all[0][0] + all[2][0]) / 2, cy = (all[0][1] + all[2][1]) / 2;
          return [cx + (x - cx) * 1.18, cy + (y - cy) * 1.22];
        }) as Quad;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(grow.flat()));
        this.drawCardPass(this.shadow, toColumnMajor(invert3(squareToQuad(sq))), c, -1);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(c.quad.flat()));
      }
      this.drawCardPass(this.card, invH, c, c.mode === "graphic" ? 1 : 0);
    }
    gl.bindVertexArray(null);
  }

  /**
   * A card pass writes into the same fbo it reads from, which is undefined in
   * GL; so each pass renders to the full-size frame and the touched region
   * is copied back into the fbo before the next card.
   */
  private drawCardPass(prog: { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }, invH: number[], c: CardDraw, mode: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scr);
    gl.useProgram(prog.p);
    const u = prog.u;
    this.bind(0, this.fboTex, u.uComp);
    gl.uniformMatrix3fv(u.uInvH, false, invH);
    gl.uniform2f(u.uSize, this.w, this.h);
    gl.uniform1f(u.uAlpha, c.alpha);
    if (mode >= 0) {
      this.bind(1, this.atlas, u.uAtlas);
      gl.uniformMatrix3fv(u.uInvHPrev, false, c.prev ? toColumnMajor(invert3(squareToQuad(c.prev))) : invH);
      gl.uniform4fv(u.uCell, cellUV(c.cell));
      gl.uniform1i(u.uMode, mode);
      gl.uniform1f(u.uRefWhite, 0.9);
    }
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    // copy the card's bounding box from the frame back into the composite
    const xs = c.quad.map((p) => p[0]);
    const ys = c.quad.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 6);
    const x1 = Math.min(this.w, Math.ceil(Math.max(...xs)) + 6);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 6);
    const y1 = Math.min(this.h, Math.ceil(Math.max(...ys)) + 6);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, this.h - y1, x0, this.h - y1, x1 - x0, y1 - y0);
  }
}
