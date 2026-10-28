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
 * Over another take than the round's (a hit), a seat is laid in wherever that
 * take or the round has a card (the mattes of the take's own still of the seat,
 * uRef, and of the plate) and the frame shows the table just as the still does,
 * up to her shadow: darker, by as much as the frame is over a few pixels, and on
 * white a little bluer (the felt's light). Her hand, and a card she is dealing
 * (unlike the still where it crosses the felt; uNew, its outline, once it has
 * all but come to rest on the cards), stay as filmed; the plate takes her shadow.
 * So do the take's own cards from the third on at that seat (uKept, their
 * outlines), out to the same rim, so their edges are their own, not the still's.
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
uniform float uPlateMode[3];
uniform sampler2D uRef0;
uniform sampler2D uRef1;
uniform sampler2D uRef2;
uniform sampler2D uRefMatte0;
uniform sampler2D uRefMatte1;
uniform sampler2D uRefMatte2;
uniform mat3 uRefUV[3];
uniform vec2 uNew[16];
uniform int uNewN;
uniform vec2 uKept[16];
uniform int uKeptN;
uniform vec2 uSize;
uniform int uShowMasks;
uniform int uPackA;
uniform int uPackB;
${KEYS}
const float NEW_GROW = 2.5;
// signed distance from p to the line a->b, positive on the quad's inside (orientation s)
float edgeIn(vec2 a, vec2 b, vec2 p, float s) {
  vec2 e = b - a;
  return s * (e.x * (p.y - a.y) - e.y * (p.x - a.x)) / max(length(e), 1e-3);
}
// how far p (pipeline pixel coordinates) lies inside the card being dealt (its convex outline), in px
float inNewCard(vec2 p) {
  if (uNewN < 3) return -1e9;
  float area = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uNewN) break;
    vec2 a = uNew[i], b = uNew[i + 1 < uNewN ? i + 1 : 0];
    area += a.x * b.y - b.x * a.y;
  }
  float s = sign(area);
  float e = 1e9;
  for (int i = 0; i < 16; i++) {
    if (i >= uNewN) break;
    e = min(e, edgeIn(uNew[i], uNew[i + 1 < uNewN ? i + 1 : 0], p, s));
  }
  return e;
}
// how far p lies inside the nearest of the take's own cards from the third on (uKept, four corners each), in px
float inKept(vec2 p) {
  float e = -1e9;
  for (int k = 0; k < 4; k++) {
    if (k >= uKeptN) break;
    vec2 a = uKept[k * 4], b = uKept[k * 4 + 1], c = uKept[k * 4 + 2], d = uKept[k * 4 + 3];
    float s = sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    e = max(e, min(min(edgeIn(a, b, p, s), edgeIn(b, c, p, s)), min(edgeIn(c, d, p, s), edgeIn(d, a, p, s))));
  }
  return e;
}
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
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 layPlate(vec3 c, sampler2D plate, sampler2D matte, mat3 uv, sampler2D still, sampler2D stillMatte, mat3 stillUV, float on, float mode, float m, float key, vec2 px) {
  if (on <= 0.0) return c;
  vec2 q = (uv * vec3(px, 1.0)).xy;
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return c;
  vec2 mt = texture(matte, q).rg;
  if (mode > 1.5) {
    // match (2), or dealing (3): over another take than the round's
    vec2 r = (stillUV * vec3(px, 1.0)).xy;
    if (any(lessThan(r, vec2(0.0))) || any(greaterThan(r, vec2(1.0)))) return c;
    vec3 ref = texture(still, r).rgb;
    // her shadow: how much darker the table is here than in the still, over a few pixels
    float lc = 0.0, lr = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec2 o = vec2(float(i), float(j)) * 3.0;
        lc += lum(frameAt((px + o) / uSize));
        lr += lum(texture(still, (stillUV * vec3(px + o, 1.0)).xy).rgb);
      }
    }
    float k = clamp(lc / max(lr, 0.36), 0.3, 1.05);
    vec3 d = c - ref * k;
    d.b = max(d.b - 0.12 * step(0.0, d.b), min(d.b, 0.0));
    float asStill = 1.0 - smoothstep(0.06, 0.12, length(d));
    // at the seat being dealt to, and while a card is being dealt (its outline marks it out), whatever
    // looks like table, felt or card stock, lit or in a shadow, is this take's own cards and felt
    float table = mode > 2.5 || uNewN >= 3 ? max(asStill, max(feltness(c), stockness(c))) : asStill;
    // wherever the take or the round has a card; at the seat being dealt to, only its first two (the
    // rest lie where this take has them in the round too, and stay as filmed, the new card on them)
    vec2 sm = texture(stillMatte, r).rg;
    float cards = mode > 2.5 ? max(sm.r * (1.0 - sm.g), mt.r * (1.0 - mt.g)) : max(sm.r, mt.r);
    // the card being dealt, and the take's own from the third on, stay as filmed, grown by NEW_GROW
    // for their soft edge; but at the seat being dealt to, where that rim lies on this take's own first
    // cards (white on white: their own edge, or the card's shadow line on them), or on the soft edge
    // of any card the still has there (half felt blue, but brighter than felt), it is laid in as the
    // same shade of the round's table, so the card's edge is its outline all along
    float e = max(inNewCard(px - 0.5), inKept(px - 0.5));
    float onCard = smoothstep(0.10, 0.20, min(min(ref.r, ref.g), ref.b)) * (1.0 - smoothstep(0.03, 0.09, ref.r - ref.b));
    float line = mode > 2.5 ? step(-NEW_GROW - 0.5, e) * (1.0 - clamp(e + 0.5, 0.0, 1.0)) * sm.r * (1.0 - sm.g) * onCard : 0.0;
    float shade = k;
    if (line > 0.0) {
      // how much darker than the still, over the pixel and its neighbours (one alone is too noisy)
      float sc = 0.0, sr = 0.0;
      for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
          vec2 o = vec2(float(i), float(j));
          sc += lum(frameAt((px + o) / uSize));
          sr += lum(texture(still, (stillUV * vec3(px + o, 1.0)).xy).rgb);
        }
      }
      shade = min(k, sc / max(sr, 0.45));
    }
    float w = cards * table * max(1.0 - clamp(e + NEW_GROW + 0.5, 0.0, 1.0), line);
    return mix(c, texture(plate, q).rgb * mix(k, shade, line), w * on);
  }
  float w = mode > 0.5 ? mt.g : max(m, mt.r);
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
  c = layPlate(c, uPlate0, uMatte0, uPlateUV[0], uRef0, uRefMatte0, uRefUV[0], uPlateOn[0], uPlateMode[0], m.r, key, px);
  c = layPlate(c, uPlate1, uMatte1, uPlateUV[1], uRef1, uRefMatte1, uRefUV[1], uPlateOn[1], uPlateMode[1], m.g, key, px);
  c = layPlate(c, uPlate2, uMatte2, uPlateUV[2], uRef2, uRefMatte2, uRefUV[2], uPlateOn[2], uPlateMode[2], m.b, key, px);
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
 *   are far brighter than the wall (looked for only next to her). Her colour is unmixed by all of
 *   her matte, but laid in by the middle of its ramp, so her outline is as crisp as the footage's.
 * - On the cloth within her reach: the share of the bare felt's blue that is missing (cards, her
 *   hands, her shadows), and her matte; clutter lying on it is erased, never on a card drawn this
 *   frame: on the open felt all of it but her and card stock (where she has a matte), by the shoe
 *   and the discard holder wherever it looks as it always does. Past her reach the cloth is always
 *   replaced.
 * - The shoe and the discard holder never move: each has a crisp outline (the scene pass's), inside
 *   which the footage is kept as it is.
 * - With the table kept as filmed, everything below the cloth's back edge stays.
 * The set's felt is generated blue; another table's felt is recoloured by its own blue, light kept.
 * The footage, enlarged about 1.5x, is sharpened back a little, tinted toward the set's light
 * (`uTint`) with a little more contrast, and the room behind her, blurred, wraps round her edges;
 * one film grain goes over it all, so the generated set and the footage read as one picture.
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
uniform vec3 uTint;
uniform float uSeed;
// the outlines of the cards whose faces are drawn this frame (pipeline pixel-centre coordinates)
const int CARDS = 32;
uniform vec2 uCards[CARDS * 4];
uniform int uCardN;
${KEYS}
const int SKIRT_TAPS = 12;
// The footage is enlarged about 1.5x into the dealer framing: filtered Catmull-Rom (sharper than
// bilinear) and sharpened back a little.
const float SHARPEN = 0.3;
// How dark the shoe and discard holder's contact shadow on the new felt is.
const float PROP_SHADOW = 0.45;
// Her matte's edge is drawn over the middle of its ramp (her colour is still unmixed by all of it),
// once smoothed over a pixel or so: tightened as it comes, its compression blocks would show as steps.
const vec2 MATTE_EDGE = vec2(0.15, 0.85);
// How far (source px) the set's light wraps round her edges, and how strongly.
const float WRAP_PX = 6.0;
const float WRAP = 0.45;
// The footage is flatter than the sets: a gentle S-curve.
const float CONTRAST = 0.22;
const float GRAIN = 0.018;
vec4 live(vec2 s) {
  // the composite is a framebuffer: row 0 is the bottom
  return texture(uComp, vec2(s.x / uSize.x, 1.0 - s.y / uSize.y));
}
// live(s) through a Catmull-Rom filter: nine bilinear taps weighted to the cubic's sixteen texels
vec4 liveCubic(vec2 s) {
  vec2 p = vec2(s.x, uSize.y - s.y) - 0.5;
  vec2 f = fract(p);
  vec2 c1 = floor(p) + 0.5;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c1 - 1.0) / uSize, t12 = (c1 + w2 / w12) / uSize, t3 = (c1 + 2.0) / uSize;
  vec4 r = (texture(uComp, vec2(t0.x, t0.y)) * w0.x + texture(uComp, vec2(t12.x, t0.y)) * w12.x + texture(uComp, vec2(t3.x, t0.y)) * w3.x) * w0.y
    + (texture(uComp, vec2(t0.x, t12.y)) * w0.x + texture(uComp, vec2(t12.x, t12.y)) * w12.x + texture(uComp, vec2(t3.x, t12.y)) * w3.x) * w12.y
    + (texture(uComp, vec2(t0.x, t3.y)) * w0.x + texture(uComp, vec2(t12.x, t3.y)) * w12.x + texture(uComp, vec2(t3.x, t3.y)) * w3.x) * w3.y;
  return clamp(r, 0.0, 1.0);
}
// sharpened by k (only well inside what is kept: at its edge the overshoot would unmix as a bright fringe)
vec3 sharpened(vec2 s, vec3 c, float k) {
  vec3 n = live(s + vec2(1.0, 0.0)).rgb + live(s - vec2(1.0, 0.0)).rgb + live(s + vec2(0.0, 1.0)).rgb + live(s - vec2(0.0, 1.0)).rgb;
  return clamp(c + k * SHARPEN * (c - 0.25 * n), 0.0, 1.0);
}
float smoothMatte(vec2 s, float a) {
  float d = 0.8;
  return (2.0 * a + live(s + vec2(d, d)).a + live(s + vec2(-d, d)).a + live(s + vec2(d, -d)).a + live(s + vec2(-d, -d)).a) / 6.0;
}
// Her matte round s: its mean on a ring (1 deep inside her, about a half at her edge) and its most.
vec2 matteRing(vec2 s, float r) {
  float sum = 0.0, hi = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = float(i) * 0.7853982;
    float a = live(s + r * vec2(cos(t), sin(t))).a;
    sum += a;
    hi = max(hi, a);
  }
  return vec2(sum / 8.0, hi);
}
// Filmed under the studio's flat daylight: tinted toward the set's light, with a little more contrast.
vec3 grade(vec3 c) {
  c = clamp(c * uTint, 0.0, 1.0);
  return mix(c, c * c * (3.0 - 2.0 * c), CONTRAST);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
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
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
// signed distance (px) of p from the line a -> b
float side(vec2 a, vec2 b, vec2 p) { return cross2(b - a, p - a) / max(length(b - a), 1e-3); }
// How far inside the deepest of the cards drawn this frame p is, in px (negative: outside them all).
float inCards(vec2 p) {
  float best = -1e3;
  for (int i = 0; i < CARDS; i++) {
    if (i >= uCardN) break;
    vec2 q0 = uCards[i * 4], q1 = uCards[i * 4 + 1], q2 = uCards[i * 4 + 2], q3 = uCards[i * 4 + 3];
    // inside is on the same side of all four edges, whichever way round the outline runs
    float o = sign(cross2(q2 - q0, q3 - q1));
    float d = min(min(o * side(q0, q1, p), o * side(q1, q2, p)), min(o * side(q2, q3, p), o * side(q3, q0, p)));
    if (o != 0.0) best = max(best, d);
  }
  return best;
}
// Card stock with no face drawn on it (the cards she gathers up): stock-coloured, and so on most of
// a ring a few pixels round, where a bet marker's glint is a line a pixel or two wide.
float faceless(vec2 s, vec3 c) {
  float n = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = float(i) * 0.7853982;
    n += stockness(live(s + 3.0 * vec2(cos(t), sin(t))).rgb);
  }
  return stockness(c) * smoothstep(0.3, 0.6, n / 8.0);
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
  vec4 lv = liveCubic(s);
  vec3 c = lv.rgb;
  if (uHasSet == 0) {
    outColor = vec4(c, 1.0);
    return;
  }
  vec2 st = s / uSize;
  vec3 ref = texture(uRef, st).rgb;
  vec3 mk = texture(uMasks, st).rgb;
  vec3 cp = texture(uClutter, st).rgb;
  float env = clamp(mk.r / 0.6, 0.0, 1.0);
  float core = smoothstep(0.75, 0.95, mk.r);
  float cloth = mk.g;
  float reach = mk.b;
  // clutter: 1 on the open felt, a half by the shoe and the discard holder; never on a card drawn
  // this frame. On the open felt, with her matte to keep her by, all of it goes but her and the
  // faceless cards she carries over it (the bet marker she knocks askew looks like itself in
  // neither place); elsewhere only where it looks as it always does.
  float clutter = min(cp.r * 2.0, 1.0);
  float openFelt = 0.0;
  if (uSwapTable == 1 && cp.r > 0.0) {
    clutter *= 1.0 - smoothstep(-1.0, 1.0, inCards(s - 0.5));
    if (uHasMatte == 1 && cp.r > 0.5) openFelt = clamp(cp.r * 2.0 - 1.0, 0.0, 1.0) * (1.0 - faceless(s, c));
  }
  // the shoe and the discard holder, crisp: kept as filmed, her hands and the cards on them with them
  float props = uSetOnly == 1 ? 0.0 : cp.b;
  float matte = uHasMatte == 1 ? lv.a * env : 0.0;
  vec2 ring = uHasMatte == 1 ? matteRing(s, WRAP_PX) : vec2(0.0);

  // how far above the cloth's back edge this is, in source px
  float rise = -dot(uBackLine, vec3(s, 1.0));
  // The matte fades her out over the last few pixels before the table, which hides her below
  // them; where it has her body just above, the colour key fills those rows back in.
  float bodyAbove = live(s - vec2(0.0, 10.0)).a;
  float edgeFill = (1.0 - smoothstep(8.0, 12.0, rise)) * bodyAbove * env * aboveKey(c, ref);
  // a card in her hand, far brighter than the wall, next to her (elsewhere that is the wall lit
  // brighter than the reference has it, and would show as grey round her)
  float card = env * brighter(c, ref) * smoothstep(0.3, 0.6, matteRing(s, 18.0).y);
  float above = uHasMatte == 1
    ? max(max(matte, edgeFill), card)
    : max(core, env * aboveKey(c, ref)) * (1.0 - uncoveredWall(c, ref));
  float matteEdge = uHasMatte == 1 ? smoothstep(MATTE_EDGE.x, MATTE_EDGE.y, smoothMatte(s, lv.a) * env) : 0.0;
  float aboveEdge = uHasMatte == 1 ? max(max(matteEdge, edgeFill), card) : above;
  // just past the cloth's back edge a pixel can still be half felt: that is the table's, not hers
  float pastEdge = 1.0 - smoothstep(0.0, 4.0, rise);
  float notFelt = 1.0 - pastEdge * smoothstep(0.03, 0.1, blueness(c));
  above *= notFelt;
  aboveEdge *= notFelt;
  float erase = clutter * max(same(c, ref), openFelt);
  float onCloth = uSwapTable == 1 ? max(reach * clothKey(c, ref) * (1.0 - erase), lv.a * reach * float(uHasMatte)) : 1.0;
  // Just outside the props' crisp outlines the footage still has their soft edge, darker than the
  // felt, which the felt key would keep as a blur round them: there it keeps only her (her matte,
  // or skin's warmth) and a card coming out of the shoe (far brighter than the felt).
  float roundProps = cp.g * (1.0 - smoothstep(0.0, 0.5, props));
  float notBlur = max(lv.a * float(uHasMatte), max(smoothstep(1.15, 1.35, lum(c) / max(lum(ref), 0.02)), smoothstep(0.03, 0.08, c.r - c.b)));
  onCloth *= mix(1.0, notBlur, roundProps * float(uSwapTable));
  // a kept table keeps everything below the cloth's back edge (its drape, the floor under it)
  float tableZone = uSwapTable == 1 ? cloth : max(cloth, smoothstep(-1.0, 1.0, dot(uBackLine, vec3(s, 1.0))));
  // her colour is unmixed from the set as filmed by all of her coverage, and laid in by its tighter edge
  float a = uSetOnly == 1 ? 0.0 : mix(above, onCloth, tableZone);
  float aOut = uSetOnly == 1 ? 0.0 : mix(aboveEdge, onCloth, tableZone);
  vec3 cs = sharpened(s, c, smoothstep(0.85, 1.0, max(a, props)));
  vec3 fg = grade(clamp((cs - (1.0 - a) * ref) / max(a, 0.04), 0.0, 1.0));

  vec3 set = texture(uSet, vUV).rgb;
  if (uPainted == 1) {
    set = painted(s, set);
  } else if (uRecolor == 1) {
    // the generated felt (blue) recoloured to this table's: a pixel's share of felt is how much of
    // its colour is the felt's blue, lit or in shade; its light and grain (its luminance) are kept,
    // and the print's anti-aliased edges keep their own colour
    float chroma = blueness(set) / max(set.b, 0.02);
    float f = clamp(chroma / max(blueness(uFeltBase) / uFeltBase.b, 0.05), 0.0, 1.0) * inTop(uFelt, s).a;
    vec3 felt = uFeltColor * lum(set) / max(lum(uFeltBase), 0.02);
    set = mix(set, clamp(felt, 0.0, 1.0), f);
  }
  // the props stand on the new felt: a soft contact shadow round their feet (their outline, blurred
  // over a few pixels and nudged a little away from the camera, as the key light in front throws it)
  if (uSwapTable == 1) set *= 1.0 - PROP_SHADOW * textureLod(uClutter, st + vec2(0.0, 1.5) / uSize, 2.0).b * tableZone * (1.0 - props);
  // the set's light wraps round her edges: the room behind her, blurred, over the rim of her matte
  float rim = uHasMatte == 1 ? pow(clamp(1.0 - ring.x, 0.0, 1.0), 2.0) * (1.0 - tableZone) : 0.0;
  vec3 glow = textureLod(uSet, vUV, 4.5).rgb;
  fg = 1.0 - (1.0 - fg) * (1.0 - WRAP * rim * glow);
  vec3 o = mix(set, fg, aOut);
  // the props' glossy black mirrors the filmed felt's blue, worst along their edges: taken out
  vec3 pc = vec3(cs.rg, mix(cs.b, min(cs.b, max(cs.r, cs.g) + 0.02), 0.75));
  o = mix(o, grade(pc), props);
  // one grain over the set and the footage alike (not on the set alone: the sets pass's input)
  if (uSetOnly == 0) o += (hash(gl_FragCoord.xy + uSeed) - 0.5) * GRAIN;
  outColor = vec4(o, 1.0);
}`;
