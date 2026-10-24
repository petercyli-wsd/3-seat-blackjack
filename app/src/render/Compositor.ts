import type { Quad } from "../media/manifest";
import { cellUV } from "./faceAtlas";
import { invert3, squareToQuad, toColumnMajor } from "./homography";
import { BLIT_FS, CARD_FS, CARD_VS, COMPOSITE_FS, FULLSCREEN_VS, SHADOW_FS } from "./shaders";

export interface PlateDraw {
  tex: WebGLTexture;
  /** x, y, w, h in video pixels. */
  rect: [number, number, number, number];
  alpha: number;
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
  private vidA: WebGLTexture;
  private vidB: WebGLTexture;
  private mask: WebGLTexture;
  private atlas: WebGLTexture;
  private black: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;
  private quadBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  readonly w: number;
  readonly h: number;

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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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

    // pass 1: footage + plates -> fbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.comp.p);
    const u = this.comp.u;
    this.bind(0, this.vidA, u.uVidA);
    this.bind(1, f.b && f.mix > 0 ? this.vidB : this.vidA, u.uVidB);
    gl.uniform1f(u.uMix, f.b ? f.mix : 0);
    this.bind(2, this.mask, u.uMask);
    const rects = new Float32Array(12);
    const on = new Float32Array(3);
    for (let i = 0; i < 3; i++) {
      const p = f.plates[i];
      this.bind(3 + i, p ? p.tex : this.black, u[`uPlate${i}`]);
      if (p) {
        rects.set(p.rect, i * 4);
        on[i] = p.alpha;
      }
    }
    gl.uniform4fv(u["uPlateRect[0]"], rects);
    gl.uniform1fv(u["uPlateOn[0]"], on);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform1i(u.uShowMasks, f.showMasks ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // pass 2: blit to screen, then the cards, each reading the composite beneath it
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.blit.p);
    this.bind(0, this.fboTex, this.blit.u.uComp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!f.cards.length) return;

    // Cards overlap (a hit lands on the card before it), so each card must read
    // the composite *including* the faces already drawn under it.
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    for (const c of f.cards) {
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
   * GL; so each pass renders to the default framebuffer and the touched region
   * is copied back into the fbo before the next card.
   */
  private drawCardPass(prog: { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }, invH: number[], c: CardDraw, mode: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    // copy the card's bounding box from the screen back into the composite
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
