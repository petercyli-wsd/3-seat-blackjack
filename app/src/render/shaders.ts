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
 * plate laid in under the seat mask — but only where the live pixel is felt
 * or card. Wherever the dealer's arm or hand is, the live frame wins, so she
 * always passes in front of the cards.
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
uniform vec4 uPlateRect[3];
uniform float uPlateOn[3];
uniform vec2 uSize;
uniform int uShowMasks;
${KEYS}
// sampler arrays can't be indexed by a loop variable in GLSL ES 3.0, hence one call per seat
vec3 layPlate(vec3 c, sampler2D plate, vec4 r, float on, float m, float key, vec2 px) {
  if (on <= 0.0) return c;
  vec2 q = (px - r.xy) / r.zw;
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return c;
  return mix(c, texture(plate, q).rgb, m * key * on);
}
void main() {
  vec3 a = texture(uVidA, vUV).rgb;
  vec3 b = texture(uVidB, vUV).rgb;
  vec3 c = mix(a, b, uMix);
  vec3 m = texture(uMask, vUV).rgb;
  vec2 px = vUV * uSize;
  // Dilate the key by a pixel: compression rings around the physical cards'
  // edges otherwise survive the plate as a faint outline. The cost is a
  // one-pixel plate halo on the dealer's hand edge, which reads as motion blur.
  vec2 o = 1.25 / uSize;
  vec3 a1 = mix(texture(uVidA, vUV + vec2(o.x, o.y)).rgb, texture(uVidB, vUV + vec2(o.x, o.y)).rgb, uMix);
  vec3 a2 = mix(texture(uVidA, vUV + vec2(-o.x, o.y)).rgb, texture(uVidB, vUV + vec2(-o.x, o.y)).rgb, uMix);
  vec3 a3 = mix(texture(uVidA, vUV + vec2(o.x, -o.y)).rgb, texture(uVidB, vUV + vec2(o.x, -o.y)).rgb, uMix);
  vec3 a4 = mix(texture(uVidA, vUV - o).rgb, texture(uVidB, vUV - o).rgb, uMix);
  float key = max(max(tableness(c), tableness(a1)), max(max(tableness(a2), tableness(a3)), tableness(a4)));
  c = layPlate(c, uPlate0, uPlateRect[0], uPlateOn[0], m.r, key, px);
  c = layPlate(c, uPlate1, uPlateRect[1], uPlateOn[1], m.g, key, px);
  c = layPlate(c, uPlate2, uPlateRect[2], uPlateOn[2], m.b, key, px);
  if (uShowMasks == 1) {
    c = mix(c, vec3(1.0, 0.75, 0.2), 0.35 * m.r);
    c = mix(c, vec3(0.3, 1.0, 0.4), 0.35 * m.g);
    c = mix(c, vec3(0.3, 0.6, 1.0), 0.35 * m.b);
    for (int i = 0; i < 3; i++) if (uPlateOn[i] > 0.0) c = mix(c, vec3(1.0, 0.1, 0.4), 0.25 * m[i]);
  }
  outColor = vec4(c, 1.0);
}`;

export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uComp;
void main() {
  outColor = vec4(texelFetch(uComp, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
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
  vec3 base = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0).rgb;
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
    float shade = clamp(lum / uRefWhite, 0.55, 1.08);
    float w = cardness(base) * uAlpha * inside;
    outColor = vec4(mix(base, face * shade, w), 1.0);
  } else {
    float r = 0.09;
    vec2 d = max(abs(uv - 0.5) - (0.5 - r), 0.0);
    float corner = 1.0 - smoothstep(r - 0.03, r, length(d * vec2(1.0, 0.72)));
    float visible = feltness(base) + cardness(base);
    float w = clamp(visible, 0.0, 1.0) * uAlpha * inside * corner;
    outColor = vec4(mix(base, face * 0.94, w), 1.0);
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
  vec3 base = texelFetch(uComp, ivec2(gl_FragCoord.xy), 0).rgb;
  vec2 d = max(abs(uv - 0.5) - 0.38, 0.0);
  float s = 1.0 - smoothstep(0.0, 0.2, length(d));
  float w = s * uAlpha * 0.45 * feltness(base);
  outColor = vec4(base * (1.0 - w), 1.0);
}`;
