/**
 * Pixel classes on the blue-screen table, as smooth weights so edges blend:
 * felt is strongly blue (B - max(R,G) ≈ 0.33), card stock is bright and
 * neutral-to-cool, and skin is bright too but warm (R > B), which is the only
 * thing separating a lit knuckle from a card.
 */
const KEYS = /* glsl */ `
float feltness(vec3 c) {
  // a card/felt rim pixel (half white, half blue) still reads ~0.18, so it counts as felt
  return smoothstep(0.03, 0.12, c.b - max(c.r, c.g));
}
float cardness(vec3 c) {
  float bright = smoothstep(0.55, 0.70, min(min(c.r, c.g), c.b));
  float notWarm = 1.0 - smoothstep(0.02, 0.06, c.r - c.b);
  return bright * notWarm;
}
float tableness(vec3 c) {
  return max(feltness(c), cardness(c));
}
// Card stock to lay a face on, inside a card's own outline: by colour, not brightness (not felt
// blue, not skin warm, not her dark sleeve). A card in the shade of her arm, or under the
// exposure dipping as she leans in, reads ~0.6 where a lit one reads 0.85, and must keep its face.
float stockness(vec3 c) {
  float notFelt = 1.0 - smoothstep(0.12, 0.22, c.b - max(c.r, c.g));
  float notSkin = 1.0 - smoothstep(0.03, 0.09, c.r - c.b);
  float lit = smoothstep(0.30, 0.45, min(min(c.r, c.g), c.b));
  return notFelt * notSkin * lit;
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUV;
void main() {
  vec2 p = P[gl_VertexID];
  vUV = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * Pass 1: footage (optionally crossfading two decks), then each seat's
 * plate laid in — but only where the live pixel is felt or card. Wherever the
 * dealer's arm or hand is, the live frame wins, so she always passes in front
 * of the cards. A plate is a still moved onto the take's own cards (uPlateUV
 * takes a video pixel back to it). A whole hand covers the seat mask, hiding
 * whatever cards the footage has there, and its own cards (matte red) even
 * where the move takes them past the mask; over a take that holds the hand's
 * first two cards, only the cards from the third on (matte green) are laid in.
 *
 * A deck playing a packed clip (the dealer's matte stacked below the picture) is read from its
 * top half, and its matte goes on in the alpha channel for pass 3; an unpacked deck gives 1.
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uVidA;
uniform sampler2D uVidB;
uniform float uMix;
uniform sampler2D uMask;
uniform sampler2D uPlate0;
uniform sampler2D uPlate1;
uniform sampler2D uPlate2;
uniform sampler2D uMatte0;
uniform sampler2D uMatte1;
uniform sampler2D uMatte2;
uniform mat3 uPlateUV[3];
uniform float uPlateOn[3];
uniform float uPlateExtras[3];
uniform vec2 uSize;
uniform int uShowMasks;
uniform int uPackA;
uniform int uPackB;
${KEYS}
// a packed deck's picture is its top half; its last row stops short of the matte's first
vec2 picture(sampler2D v, int packed, vec2 uv) {
  if (packed == 0) return uv;
  return vec2(uv.x, min(uv.y * 0.5, 0.5 - 0.5 / float(textureSize(v, 0).y)));
}
vec3 frameAt(vec2 uv) {
  return mix(texture(uVidA, picture(uVidA, uPackA, uv)).rgb, texture(uVidB, picture(uVidB, uPackB, uv)).rgb, uMix);
}
float matteAt(vec2 uv) {
  vec2 m = vec2(uv.x, max(0.5 + uv.y * 0.5, 0.5 + 0.5 / float(textureSize(uVidA, 0).y)));
  float a = uPackA == 1 ? texture(uVidA, m).g : 1.0;
  float b = uPackB == 1 ? texture(uVidB, m).g : 1.0;
  return mix(a, b, uMix);
}
// sampler arrays can't be indexed by a loop variable in GLSL ES 3.0, hence one call per seat
vec3 layPlate(vec3 c, sampler2D plate, sampler2D matte, mat3 uv, float on, float extras, float m, float key, vec2 px) {
  if (on <= 0.0) return c;
  vec2 q = (uv * vec3(px, 1.0)).xy;
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return c;
  vec2 mt = texture(matte, q).rg;
  float w = extras > 0.5 ? mt.g : max(m, mt.r);
  return mix(c, texture(plate, q).rgb, w * key * on);
}
void main() {
  vec3 c = frameAt(vUV);
  vec3 m = texture(uMask, vUV).rgb;
  vec2 px = vUV * uSize;
  // Dilate the key by a pixel: compression rings around the physical cards'
  // edges otherwise survive the plate as a faint outline. The cost is a
  // one-pixel plate halo on the dealer's hand edge, which reads as motion blur.
  vec2 o = 1.25 / uSize;
  vec3 a1 = frameAt(vUV + vec2(o.x, o.y));
  vec3 a2 = frameAt(vUV + vec2(-o.x, o.y));
  vec3 a3 = frameAt(vUV + vec2(o.x, -o.y));
  vec3 a4 = frameAt(vUV - o);
  float key = max(max(tableness(c), tableness(a1)), max(max(tableness(a2), tableness(a3)), tableness(a4)));
  c = layPlate(c, uPlate0, uMatte0, uPlateUV[0], uPlateOn[0], uPlateExtras[0], m.r, key, px);
  c = layPlate(c, uPlate1, uMatte1, uPlateUV[1], uPlateOn[1], uPlateExtras[1], m.g, key, px);
  c = layPlate(c, uPlate2, uMatte2, uPlateUV[2], uPlateOn[2], uPlateExtras[2], m.b, key, px);
  if (uShowMasks == 1) {
    c = mix(c, vec3(1.0, 0.75, 0.2), 0.35 * m.r);
    c = mix(c, vec3(0.3, 1.0, 0.4), 0.35 * m.g);
    c = mix(c, vec3(0.3, 0.6, 1.0), 0.35 * m.b);
    for (int i = 0; i < 3; i++) if (uPlateOn[i] > 0.0) c = mix(c, vec3(1.0, 0.1, 0.4), 0.25 * m[i]);
  }
  outColor = vec4(c, matteAt(vUV));
}`;

export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uComp;
void main() {
  outColor = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0);
}`;

/**
 * Quads are in the pipeline's (OpenCV's) pixel coordinates, where pixel (i, j)
 * is centred on (i, j). GL centres it on (i + 0.5, j + 0.5), so both the
 * vertices and the fragment positions are shifted by half a pixel to match.
 */
const PIXEL = /* glsl */ `
vec2 videoPixel() {
  return vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) - 0.5;
}
`;

export const CARD_VS = /* glsl */ `#version 300 es
in vec2 aPos;
uniform vec2 uSize;
void main() {
  vec2 p = aPos + 0.5;
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
}`;

/**
 * Pass 2: one card face. The fragment's video-pixel position goes through
 * the inverse homography of the card's outline to get face UVs (perspective
 * correct). Mode 0 (footage card): the face is laid only where the
 * composite shows card stock and takes that stock's luminance as shading,
 * so the real lighting, motion blur and any occluding hand carry over.
 * Mode 1 (graphic card, no physical card under it): drawn opaque with a
 * rounded outline, hidden only where something that isn't felt covers it.
 *
 * A moving card (uInvHPrev is last frame's outline) is blurred in the footage,
 * so its face is too: averaged along the card's own motion over half a frame,
 * centred on this frame, as a 180-degree shutter would see it.
 */
export const CARD_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uComp;
uniform sampler2D uAtlas;
uniform mat3 uInvH;
uniform mat3 uInvHPrev;
uniform vec4 uCell;
uniform float uAlpha;
uniform int uMode;
uniform vec2 uSize;
uniform float uRefWhite;
${KEYS}
${PIXEL}
const int BLUR_TAPS = 7;
void main() {
  vec2 px = videoPixel();
  vec3 h = uInvH * vec3(px, 1.0);
  vec2 uv = h.xy / h.z;
  vec3 hp = uInvHPrev * vec3(px, 1.0);
  // the face point under this pixel a frame ago, minus now: the face's motion here, in UV
  vec2 duv = hp.xy / hp.z - uv;
  vec4 under = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0);
  vec3 base = under.rgb;
  vec2 g = fwidth(uv);
  vec2 edge = min(uv, 1.0 - uv) / max(g, vec2(1e-5));
  float inside = clamp(min(edge.x, edge.y), 0.0, 1.0);
  if (inside <= 0.0) discard;
  vec3 face = vec3(0.0);
  for (int i = 0; i < BLUR_TAPS; i++) {
    float t = (float(i) / float(BLUR_TAPS - 1) - 0.5) * 0.5;
    face += texture(uAtlas, mix(uCell.xy, uCell.zw, clamp(uv + duv * t, 0.0, 1.0))).rgb;
  }
  face /= float(BLUR_TAPS);
  if (uMode == 0) {
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    // the face takes the stock's own light, down into shade
    float shade = clamp(lum / uRefWhite, 0.35, 1.08);
    float w = stockness(base) * uAlpha * inside;
    outColor = vec4(mix(base, face * shade, w), under.a);
  } else {
    float r = 0.09;
    vec2 d = max(abs(uv - 0.5) - (0.5 - r), 0.0);
    float corner = 1.0 - smoothstep(r - 0.03, r, length(d * vec2(1.0, 0.72)));
    float visible = feltness(base) + cardness(base);
    float w = clamp(visible, 0.0, 1.0) * uAlpha * inside * corner;
    outColor = vec4(mix(base, face * 0.94, w), under.a);
  }
}`;

/** Soft contact shadow under a graphic card. */
export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uComp;
uniform mat3 uInvH;
uniform float uAlpha;
uniform vec2 uSize;
${KEYS}
${PIXEL}
void main() {
  vec3 h = uInvH * vec3(videoPixel(), 1.0);
  vec2 uv = h.xy / h.z;
  vec4 under = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0);
  vec3 base = under.rgb;
  vec2 d = max(abs(uv - 0.5) - 0.38, 0.0);
  float s = 1.0 - smoothstep(0.0, 0.2, length(d));
  float w = s * uAlpha * 0.45 * feltness(base);
  outColor = vec4(base * (1.0 - w), under.a);
}`;

/**
 * Pass 3: the frame as the player sees it, cropped to `uCrop` (source px), and with a set (a
 * generated studio, room and table together, from the pipeline's sets pass) in place of the one
 * filmed. Masks and reference come from the pipeline's scene pass; the reference is the set as
 * filmed without her.
 *
 * The footage is taken as her (and what she holds, the cards, the shoe, her shadows) over the
 * filmed set, with a coverage `a` per pixel; her colour is unmixed from the reference by that
 * coverage, F = (C - (1 - a) * ref) / a, and laid over the new set. So an edge pixel half hair and
 * half wall loses the wall's grey, a card's edge loses the felt's blue, and her shadow on the
 * felt, which is the felt darkened, becomes black at partial coverage: the new felt darkened alike.
 * - Above the cloth: her matte (MatAnyone, packed with the clip), or for footage without one
 *   (the generated bridges) how unlike the wall she is, inside her envelope. Cards she carries
 *   are far brighter than the wall; the tops of the shoe and discard holder are keyed as unlike it.
 * - On the cloth within her reach: the share of the bare felt's blue that is missing (cards, her
 *   hands, her shadows), and her matte; clutter lying still on it is erased wherever it looks as it
 *   always does. Past her reach the cloth is always replaced.
 * - With the table kept as filmed, everything below the cloth's back edge stays.
 * The set's felt is generated blue; another table's felt is recoloured by its own blue, light kept.
 */
export const STAGE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uComp;
uniform sampler2D uRef;
uniform sampler2D uMasks;
uniform sampler2D uClutter;
uniform sampler2D uSet;
uniform sampler2D uFelt;
uniform sampler2D uTop;
uniform sampler2D uWood;
uniform vec2 uSize;
uniform vec4 uCrop;
uniform int uHasSet;
uniform int uSwapTable;
uniform int uHasMatte;
uniform int uRecolor;
uniform vec3 uFeltBase;
uniform vec3 uFeltColor;
uniform int uPainted;
uniform int uSetOnly;
uniform vec3 uBackLine;
uniform mat3 uToTop;
uniform vec2 uSkirt;
uniform vec3 uSkirtTint;
uniform vec3 uLed;
const int SKIRT_TAPS = 12;
vec4 live(vec2 s) {
  // the composite is a framebuffer: row 0 is the bottom
  return texture(uComp, vec2(s.x / uSize.x, 1.0 - s.y / uSize.y));
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float blueness(vec3 c) { return c.b - max(c.r, c.g); }
// How unlike the wall behind her a pixel is, 0 to 1, linear enough to read as coverage at edges.
float aboveKey(vec3 c, vec3 r) {
  float ratio = lum(c) / (lum(r) + 1e-3);
  vec3 cc = c / (c.r + c.g + c.b + 0.05);
  vec3 rc = r / (r.r + r.g + r.b + 0.05);
  float hue = max(length(cc - rc) * 8.0, ((c.r - c.b) - (r.r - r.b)) * 6.0);
  float a = clamp((hue - 0.16) / 0.24, 0.0, 1.0);
  a = max(a, clamp((1.0 - ratio - 0.12) / 0.55, 0.0, 1.0));
  return max(a, clamp((ratio - 1.22) / 0.3, 0.0, 1.0));
}
// Far brighter than the wall: a card in her hand.
float brighter(vec3 c, vec3 r) {
  return clamp((lum(c) / (lum(r) + 1e-3) - 1.22) / 0.3, 0.0, 1.0);
}
// The wall she uncovers by leaning in: barely saturated (up to 0.1; her palest skin is 0.11 up) and
// not far off the wall around her in brightness (her own shadow darkens it); the cards she
// carries are as grey but far brighter.
float uncoveredWall(vec3 c, vec3 r) {
  float hi = max(c.r, max(c.g, c.b));
  float sat = (hi - min(c.r, min(c.g, c.b))) / (hi + 1e-3);
  float ratio = lum(c) / (lum(r) + 1e-3);
  return (1.0 - smoothstep(0.085, 0.11, sat)) * smoothstep(0.25, 0.32, lum(c)) * smoothstep(0.6, 0.75, ratio) * (1.0 - smoothstep(1.18, 1.3, ratio));
}
// The share of the bare felt's blue missing here (a card, her hand, her shadow), past the grain.
float clothKey(vec3 c, vec3 r) {
  return clamp((1.0 - blueness(c) / max(blueness(r), 0.06) - 0.1) / 0.8, 0.0, 1.0);
}
float same(vec3 c, vec3 r) {
  vec3 d = abs(c - r);
  return 1.0 - smoothstep(0.07, 0.16, max(d.r, max(d.g, d.b)));
}
vec2 topUV(vec2 s) {
  vec3 h = uToTop * vec3(s, 1.0);
  return h.z <= 0.0 ? vec2(-1.0) : h.xy / h.z;
}
vec4 inTop(sampler2D t, vec2 s) {
  vec2 uv = topUV(s);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(t, uv);
}
// The painted table over the set at s, its top or the skirt below its rail (the input the sets
// pass restyles; the app shows the generated sets).
vec3 painted(vec2 s, vec3 under) {
  vec4 top = inTop(uTop, s);
  if (top.a < 0.999) {
    float k = uSkirt.x + uSkirt.y * s.y;
    for (int i = 1; i <= SKIRT_TAPS; i++) {
      float t = float(i) / float(SKIRT_TAPS);
      if (inTop(uTop, s - vec2(0.0, k * t)).a > 0.5) {
        vec3 wood = texture(uWood, vec2(s.x / 420.0, t * 0.18)).rgb * uSkirtTint * 1.25;
        vec3 sk = wood * mix(1.0, 0.4, t);
        sk = mix(sk, vec3(0.85, 0.68, 0.32), (1.0 - smoothstep(0.05, 0.12, t)) * 0.85);
        sk += uLed * (exp(-pow((t - 0.86) / 0.035, 2.0)) * 1.2 + exp(-pow((t - 0.86) / 0.12, 2.0)) * 0.25);
        under = sk;
        break;
      }
    }
  }
  return top.rgb + under * (1.0 - top.a);
}
void main() {
  vec2 s = uCrop.xy + vUV * uCrop.zw;
  vec4 lv = live(s);
  vec3 c = lv.rgb;
  if (uHasSet == 0) {
    outColor = vec4(c, 1.0);
    return;
  }
  vec2 st = s / uSize;
  vec3 ref = texture(uRef, st).rgb;
  vec3 mk = texture(uMasks, st).rgb;
  vec2 cp = texture(uClutter, st).rg;
  float env = clamp(mk.r / 0.6, 0.0, 1.0);
  float core = smoothstep(0.75, 0.95, mk.r);
  float cloth = mk.g;
  float reach = mk.b;
  float clutter = cp.r;
  float props = cp.g;
  float matte = uHasMatte == 1 ? lv.a * env : 0.0;

  // how far above the cloth's back edge this is, in source px
  float rise = -dot(uBackLine, vec3(s, 1.0));
  // The matte fades her out over the last few pixels before the table, which hides her below
  // them; where it has her body just above, the colour key fills those rows back in.
  float bodyAbove = live(s - vec2(0.0, 10.0)).a;
  float edgeFill = (1.0 - smoothstep(8.0, 12.0, rise)) * bodyAbove * env * aboveKey(c, ref);
  float above = uHasMatte == 1
    ? max(max(matte, edgeFill), max(env * brighter(c, ref), props * aboveKey(c, ref)))
    : max(core, env * aboveKey(c, ref)) * (1.0 - uncoveredWall(c, ref));
  // just past the cloth's back edge a pixel can still be half felt: that is the table's, not hers
  float pastEdge = 1.0 - smoothstep(0.0, 4.0, rise);
  above *= 1.0 - pastEdge * smoothstep(0.03, 0.1, blueness(c));
  float onCloth = uSwapTable == 1 ? max(reach * clothKey(c, ref) * (1.0 - clutter * same(c, ref)), lv.a * reach * float(uHasMatte)) : 1.0;
  // a kept table keeps everything below the cloth's back edge (its drape, the floor under it)
  float tableZone = uSwapTable == 1 ? cloth : max(cloth, smoothstep(-1.0, 1.0, dot(uBackLine, vec3(s, 1.0))));
  float a = uSetOnly == 1 ? 0.0 : mix(above, onCloth, tableZone);
  vec3 fg = clamp((c - (1.0 - a) * ref) / max(a, 0.04), 0.0, 1.0);

  vec3 set = texture(uSet, vUV).rgb;
  if (uPainted == 1) {
    set = painted(s, set);
  } else if (uRecolor == 1) {
    // the generated felt (blue) recoloured to this table's: a pixel's share of felt is its share of
    // the felt's blue (its light and grain with it), and only that share changes, so the print's
    // anti-aliased edges keep their own colour
    float f = clamp(blueness(set) / max(blueness(uFeltBase), 0.05), 0.0, 1.3) * inTop(uFelt, s).a;
    set = clamp(set + f * (uFeltColor - uFeltBase), 0.0, 1.0);
  }
  outColor = vec4(mix(set, fg, a), 1.0);
}`;
