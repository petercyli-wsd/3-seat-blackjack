import { type Card, faceIndex } from "../engine/cards";
import type { Manifest, Pt, Quad } from "../media/manifest";
import type { CardDraw } from "../render/Compositor";
import { centre } from "../render/homography";
import type { SceneResult } from "../render/scene";
import { CollectPainter, DECK_BACK, SAMPLES, type ShutterCard } from "./collectPass";
import { type EraseAlpha, HANDS, type Hand, eraseTable, handOfCard } from "./eraser";
import { CARD_W, CORNERS, type Pose, TableSpace, turn } from "./tableSpace";
import type { Clearing, EndingContext, RenderStyle } from "./types";

/**
 * The collect: the game clears the table itself, with cards it draws in the table's perspective.
 * Each hand in turn (dealing order: the seats from her left, then her own) is taken over by
 * graphic copies of its cards laid exactly on the real ones, which are erased under them; its
 * cards slide together onto its first card and the squared hand turns face down. The seats' piles
 * slide in, one after another, onto hers, squared in front of her, and the pile slides on round
 * her hand into the discard holder, up onto the cards already in it, and is gone into them.
 *
 * Every card is a 63 x 88 mm card on the table plane (tableSpace.ts), so it keeps its size and
 * shape in perspective wherever it goes; it turns over about its long axis through edge-on, its
 * far edge lifting off the felt; its shadow stays on the felt under it. Moving, it is drawn as
 * the footage would show it: blurred over half a frame (a 180-degree shutter at the footage's
 * frame rate), outline, face and shadow alike (collectPass.ts). Her hands rest by her cards: the
 * cards gather in front of them, and the pile's way to the holder bows round her hand.
 */

// --- timing (ms from the clear's start) ---
/** The first hand taken over, and the gap to each next one. */
const FIRST = 110;
const HAND_GAP = 45;
/** Its copies fade in over the real cards, which are then erased under them, before it moves. */
const TAKE_OVER = 70;
const ERASE = 30;
/** Squaring a hand: each card slides onto the first, the last one first, taking longer the farther it goes. */
const SQUARE_MS = 170;
const SQUARE_MS_PER_PX = 1.2;
const CARD_GAP = 22;
/** Turning the squared hand over: begun as its last card settles. */
const FLIP = 260;
const FLIP_OVERLAP = 40;
/** A seat's pile sliding to hers: after its turn, at least this long after the previous one. */
const GATHER_GAP = 75;
const GATHER_MS = 210;
const GATHER_MS_PER_PX = 1;
/** Each pile lands at least this long after the one before (so they stack in order). */
const LAND_GAP = 45;
/** The whole pile to the holder: it sets off as the last pile settles onto it. */
const HANDOFF = 60;
const HOLDER_MS = 260;
const HOLDER_MS_PER_PX = 0.85;
/** It is gone into the holder's cards over this, ending this long after it lies on them. */
const SINK = 160;
const SINK_AFTER = 70;

// --- the table (mm on it, px on the video) ---
/** Where the hands are gathered: in front of her two cards, clear of her resting hands. */
const GATHER_FORWARD = 105;
/** How far toward the camera the pile's way to the holder bows, round her hand. */
const HOLDER_DIP = 150;
/** A gathering pile's way bows sideways by this share of its length, toward the camera. */
const GATHER_BOW = 0.12;
/**
 * The top of the cards in the discard holder, about discardTray (TL, TR, BR, BL, as a card lying
 * the way hers do), and how far it is above the felt: measured on the holds' footage.
 */
const HOLDER_TOP: Quad = [[-8.5, -10], [14.5, -9.5], [10.5, 6.5], [-15.5, 6.5]];
const HOLDER_HEIGHT = 6.5;
/** The light in the holder (on the cards in it, per channel, as on the open felt): the pile takes it as it goes in. */
const HOLDER_LIGHT: [number, number, number] = [0.82, 0.94, 0.88];
/** The pile rises a little over the holder's cards before it settles on them. */
const HOLDER_HOP = 2.5;
/** How far a turning card's far edge lifts, as a share of how far a card turned on its edge would. */
const FLIP_LIFT = 0.55;

// --- drawing ---
/** A moving card is drawn at instants over the shutter about this far (px) apart. */
const BLUR_PX = 0.6;
/** The alpha of a card standing in for one drawn in the pass (for the stage pass): nothing to see. */
const SPARE = 0.002;

/** Graphic cards ease as pushed ones do: off quickly, then slowing as they settle. */
const SLIDE = bezier(0.4, 0, 0.2, 1);
const SETTLE = bezier(0.3, 0, 0.2, 1);
const TURN = bezier(0.4, 0, 0.3, 1);

/** One card of the round, as it lay when the clear began. */
interface Piece {
  cell: number;
  pose: Pose;
  /** Its quad minus its pose drawn on the table plane, per corner: where the footage has it, exactly. */
  off: Pt[];
  /** Which way round its face is drawn (its quad's winding). */
  wind: number;
  /** When it starts to slide onto the first card (Infinity: it is the first card), and for how long. */
  square: number;
  squareMs: number;
}

interface HandPlan {
  hand: Hand;
  pieces: Piece[];
  /** The hand squared up: on its first card, or (hers) where the hands are gathered. */
  base: Pose;
  baseOff: Pt[];
  /** How it lies on the gathered pile: the pile's way, or turned half round, whichever is nearer its own. */
  pileA: number;
  /** When it is taken over (and starts to move). */
  start: number;
  turn: number;
  /** Which way it turns over (+1: its -x edge lifts and it falls toward +x): toward where it goes next. */
  side: number;
  /** A seat's slide to the gathered pile (gather: Infinity for hers, which is squared there). */
  gather: number;
  gatherMs: number;
  via: Pt;
  /** When it lies on the gathered pile. */
  landed: number;
  /** Its offsets on the holder's cards, per corner of its pile as it lies there. */
  endOff: Pt[];
}

interface Plan {
  startedAt: number;
  /** When its clock starts: as it is made (the first clear builds the painter, which takes a moment). */
  t0: number;
  space: TableSpace;
  /** In drawing order: hers (at the bottom of the pile), then the seats in dealing order. */
  hands: HandPlan[];
  gathered: Pose;
  holder: Pose;
  holderVia: Pt;
  holderAt: number;
  holderMs: number;
  end: number;
  painter: CollectPainter;
}

const spaces = new WeakMap<Manifest, TableSpace>();
let plan: Plan | null = null;

export const collect: RenderStyle = {
  timing: { readMs: 1500, duration: 1700 },
  apply(res, c, _t, now, ctx) {
    if (plan?.startedAt !== c.startedAt) plan = makePlan(res, c, ctx);
    const p = plan;
    const ms = c.done ? Infinity : now - p.t0;
    const erase = { seat1: 0, seat2: 0, seat3: 0, dealer: 0 } as EraseAlpha;
    for (const h of HANDS) {
      const start = p.hands.find((x) => x.hand === h)?.start ?? FIRST;
      erase[h] = clamp01((ms - (start - ERASE)) / ERASE);
    }
    const out = eraseTable(res, erase, ctx);
    // the HUD counts a hand's cards until it turns face down (one with none drawn: until it is erased)
    const visible = { ...out.visible };
    for (const h of HANDS) {
      const hand = p.hands.find((x) => x.hand === h);
      if (ms >= p.end || (hand ? turned(hand, ms) >= Math.PI / 2 : erase[h] >= 0.5)) visible[h] = 0;
    }
    if (ms >= p.end) return { ...out, visible };
    const cards = draws(p, ms);
    // the stage pass spares the cards drawn this frame from erasing the felt's clutter: these are
    // drawn in a pass, so each also goes in as a card that draws nothing, where it lies at the
    // shutter's start, middle and end
    const spare = cards.flatMap((c) => [...new Set([0, c.quads.length >> 1, c.quads.length - 1])].map((i): CardDraw => ({
      quad: c.quads[i], cell: DECK_BACK, alpha: SPARE, mode: "graphic",
    })));
    return { ...out, visible, cards: [...out.cards, ...spare, p.painter.entry(cards)] };
  },
};

/** The clear's choreography, from the table as it lies when it begins. */
function makePlan(res: SceneResult, c: Clearing, ctx: EndingContext): Plan {
  const { m } = ctx;
  let space = spaces.get(m);
  if (!space) spaces.set(m, (space = TableSpace.fit(m)));
  const S = space;
  const order: Hand[] = [...m.playOrder, "dealer"];

  // each hand's cards as drawn now, by where they lie, in the hand's order by their faces
  const found = new Map<Hand, { i: number; d: CardDraw }[]>();
  for (const d of res.cards) {
    if (d.pass || d.alpha <= 0) continue;
    const h = handOfCard(d, ctx);
    if (!h) continue;
    const hand: Card[] = h === "dealer" ? c.dealer : c.seats[h];
    const taken = found.get(h) ?? [];
    const i = hand.findIndex((card, k) => faceIndex(card) === d.cell && !taken.some((t) => t.i === k));
    if (i < 0) continue;
    found.set(h, [...taken, { i, d }]);
  }

  // the dealer's first card, as the footage has it: the hands are gathered in front of it
  const up = found.get("dealer")?.find((x) => x.i === 0)?.d.quad ?? m.dealer.up;
  const upPose = S.pose(up);
  const fwd = turn([0, 1], upPose.a);
  const gathered: Pose = { x: upPose.x + fwd[0] * GATHER_FORWARD, y: upPose.y + fwd[1] * GATHER_FORWARD, a: upPose.a };
  const [tx, ty] = m.dealer.discardTray;
  const top = HOLDER_TOP.map(([x, y]) => [tx + x, ty + y]) as Quad;
  const holder = S.pose(top.map(([x, y]) => [x, y + HOLDER_HEIGHT]) as Quad);
  holder.a = nearTurn(gathered.a, holder.a);

  const hands: HandPlan[] = [];
  let at = FIRST;
  for (const h of order) {
    const cards = (found.get(h) ?? []).sort((a, b) => a.i - b.i);
    if (!cards.length) continue;
    const dealer = h === "dealer";
    const first = S.pose(cards[0].d.quad);
    const base = dealer ? gathered : first;
    const baseOff = dealer ? CORNERS.map((): Pt => [0, 0]) : offsets(S, cards[0].d.quad, first);
    const n = cards.length;
    const pieces = cards.map(({ d }, k): Piece => {
      const pose = S.pose(d.quad);
      pose.a = nearTurn(base.a, pose.a);
      const moves = dealer || k > 0;
      const [x0, y0] = centre(d.quad);
      const [x1, y1] = S.toImage([base.x, base.y]);
      return {
        cell: d.cell, pose, off: offsets(S, d.quad, pose), wind: Math.sign(area(d.quad)),
        square: moves ? at + (n - 1 - k) * CARD_GAP : Infinity, squareMs: SQUARE_MS + SQUARE_MS_PER_PX * Math.hypot(x1 - x0, y1 - y0),
      };
    });
    const moving = pieces.filter((x) => x.square < Infinity);
    const settled = moving.length ? Math.max(...moving.map((x) => x.square + x.squareMs)) : at;
    const turnAt = Math.max(at, settled - FLIP_OVERLAP);
    // it falls toward where it goes next
    const next = dealer ? holder : gathered;
    const dir = turn([next.x - base.x, next.y - base.y], -base.a);
    hands.push({
      hand: h, pieces, base, baseOff, pileA: nearTurn(base.a, gathered.a), start: at, turn: turnAt, side: dir[0] < 0 ? -1 : 1,
      gather: Infinity, gatherMs: 0, via: [0, 0], landed: dealer ? settled : Infinity, endOff: [],
    });
    at += HAND_GAP;
  }

  // the seats' piles slide onto hers in dealing order, each landing after the one before
  const dealer = hands.find((h) => h.hand === "dealer");
  let gatherAt = -Infinity;
  let landed = dealer ? dealer.landed : 0;
  for (const h of hands) {
    if (h.hand === "dealer") continue;
    const from = S.toImage([h.base.x, h.base.y]);
    const to = S.toImage([gathered.x, gathered.y]);
    h.gatherMs = GATHER_MS + GATHER_MS_PER_PX * Math.hypot(to[0] - from[0], to[1] - from[1]);
    h.gather = Math.max(h.turn + FLIP + 20, gatherAt + GATHER_GAP, landed + LAND_GAP - h.gatherMs);
    h.landed = h.gather + h.gatherMs;
    gatherAt = h.gather;
    landed = h.landed;
    // bowed sideways toward the camera, a little
    const d: Pt = [gathered.x - h.base.x, gathered.y - h.base.y];
    const len = Math.hypot(d[0], d[1]) || 1;
    const perp: Pt = [-d[1] / len, d[0] / len];
    const bow = GATHER_BOW * len * (perp[0] * fwd[0] + perp[1] * fwd[1]);
    h.via = [(h.base.x + gathered.x) / 2 + perp[0] * bow, (h.base.y + gathered.y) / 2 + perp[1] * bow];
  }
  const holderAt = Math.max(FIRST, landed - HANDOFF);
  const g = S.toImage([gathered.x, gathered.y]);
  const holderMs = HOLDER_MS + HOLDER_MS_PER_PX * Math.hypot(tx - g[0], ty - g[1]);
  const plan: Plan = {
    startedAt: c.startedAt, t0: 0, space: S, hands: [...hands.filter((h) => h.hand === "dealer"), ...hands.filter((h) => h.hand !== "dealer")],
    gathered, holder, holderVia: [0, 0], holderAt, holderMs, end: holderAt + holderMs + SINK_AFTER, painter: CollectPainter.for(ctx.compositor.gl),
  };
  plan.holderVia = [(gathered.x + holder.x) / 2 + fwd[0] * HOLDER_DIP, (gathered.y + holder.y) / 2 + fwd[1] * HOLDER_DIP];
  // on the holder's cards each pile is drawn onto their top exactly: per corner as it lies there
  for (const h of plan.hands) {
    const lying = cardQuad(S, { ...holder, a: h.pileA + holder.a - gathered.a }, Math.PI, h.side, HOLDER_HEIGHT, null);
    h.endOff = lying.quad.map((p) => {
      const near = top.reduce((b, q) => (dist(q, p) < dist(b, p) ? q : b));
      return [near[0] - p[0], near[1] - p[1]] as Pt;
    });
  }
  plan.t0 = Math.max(c.startedAt, performance.now());
  return plan;
}

/** How far a hand has turned over (0 face up .. pi face down) at ms. */
function turned(h: HandPlan, ms: number): number {
  return Math.PI * TURN(clamp01((ms - h.turn) / FLIP));
}

/** Where the gathered pile is at ms (before it leaves for the holder: where the hands are gathered). */
function pile(p: Plan, ms: number): { pose: Pose; lift: number; k: number } {
  const k = SLIDE(clamp01((ms - p.holderAt) / p.holderMs));
  const g = p.gathered;
  const [x, y] = quadBezier([g.x, g.y], p.holderVia, [p.holder.x, p.holder.y], k);
  // up onto the holder's cards over the last of the way, rising a little over them
  const u = clamp01((k - 0.5) / 0.45);
  return { pose: { x, y, a: g.a + (p.holder.a - g.a) * k }, lift: HOLDER_HEIGHT * smooth(u) + HOLDER_HOP * Math.sin(Math.PI * u), k };
}

/** A piece's card at ms: its outline, the felt's under it, and which side shows; null before it is taken over. */
function place(p: Plan, h: HandPlan, piece: Piece, ms: number): { quad: Quad; shadow: Quad; cell: number } {
  const sq = piece.square === Infinity ? 1 : SETTLE(clamp01((ms - piece.square) / piece.squareMs));
  let pose = lerpPose(piece.pose, h.base, sq);
  let off = lerpPts(piece.off, h.baseOff, sq);
  let lift = 0;
  // on the pile (or on its way to it, as it may already be leaving): with the pile
  const st = pile(p, ms);
  const onPile: Pose = { ...st.pose, a: h.pileA + st.pose.a - p.gathered.a };
  const pileOff = h.endOff.map(([x, y]): Pt => [x * st.k, y * st.k]);
  if (h.hand === "dealer") {
    if (ms >= p.holderAt) {
      pose = onPile;
      off = pileOff;
      lift = st.lift;
    }
  } else if (ms >= h.gather) {
    const k = SLIDE(clamp01((ms - h.gather) / h.gatherMs));
    const [x, y] = quadBezier([h.base.x, h.base.y], h.via, [onPile.x, onPile.y], k);
    pose = { x, y, a: h.base.a + (onPile.a - h.base.a) * k };
    off = lerpPts(h.baseOff, pileOff, k);
    lift = st.lift * k;
  }
  const { quad, shadow } = cardQuad(p.space, pose, turned(h, ms), h.side, lift, off);
  const back = Math.sign(area(quad)) !== piece.wind;
  return { quad, shadow, cell: back ? DECK_BACK : piece.cell };
}

/**
 * A card at pose on the table, turned over by theta about its long axis through its centre, the
 * edge `side` points away from lifting (by FLIP_LIFT of a real turn) and the other sliding in under
 * it on the felt; raised by lift px (lying on the holder's cards); plus per-corner offsets. Its
 * outline, and its shadow's on the felt under it.
 */
function cardQuad(S: TableSpace, pose: Pose, theta: number, side: number, lift: number, off: Pt[] | null) {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const quad: Pt[] = [];
  const shadow: Pt[] = [];
  CORNERS.forEach(([lx, ly], k) => {
    const t = S.local(pose, [lx * cos, ly]);
    const z = (side * -lx + CARD_W / 2) * sin * FLIP_LIFT;
    const [x, y] = S.toImage(t);
    const [ox, oy] = off ? off[k] : [0, 0];
    quad.push([x + ox, y + oy - z * S.rise(t) - lift]);
    shadow.push([x + ox, y + oy]);
  });
  return { quad: quad as Quad, shadow: shadow as Quad };
}

/** This frame's cards, bottom to top, each as the shutter sees it over half a frame (180 degrees at the footage's rate). */
function draws(p: Plan, ms: number): ShutterCard[] {
  const out: ShutterCard[] = [];
  const shutter = 1000 / 24 / 2;
  // a squared hand's cards lie exactly on each other, and the piles on the gathered pile: only the top one shows
  const onPile = (h: HandPlan) => ms >= h.landed;
  const topOnPile = [...p.hands].reverse().find(onPile);
  for (const h of p.hands) {
    if (onPile(h) && h !== topOnPile) continue;
    const alpha = clamp01((ms - (h.start - ERASE - TAKE_OVER)) / TAKE_OVER) * (1 - smooth(clamp01((ms - (p.end - SINK)) / SINK)));
    if (alpha <= 0) continue;
    const squared = (x: Piece) => x.square === Infinity || ms >= x.square + x.squareMs;
    h.pieces.forEach((piece, i) => {
      if (squared(piece) && h.pieces.slice(i + 1).some(squared)) return;
      const at = (t: number) => place(p, h, piece, t);
      const a = at(ms - shutter / 2);
      const b = at(ms + shutter / 2);
      // instants about a pixel of travel apart
      const moved = Math.max(...a.quad.map((q, k) => dist(q, b.quad[k])));
      const n = moved < BLUR_PX ? 1 : Math.min(SAMPLES, 1 + Math.ceil(moved / BLUR_PX));
      const shots = n === 1 ? [at(ms)] : Array.from({ length: n }, (_, j) => at(ms + (j / (n - 1) - 0.5) * shutter));
      // as it rises onto the holder's cards: off the felt (its shadow goes) and into the holder's shade
      const inside = smooth(clamp01((pile(p, ms).k - 0.6) / 0.4));
      const light = HOLDER_LIGHT.map((l) => 1 + (l - 1) * inside) as [number, number, number];
      out.push({ quads: shots.map((s) => s.quad), cells: shots.map((s) => s.cell), shadows: shots.map((s) => s.shadow), alpha, shadow: 1 - inside, light });
    });
  }
  return out;
}

/** Per corner, how far quad q lies from pose drawn on the table plane. */
function offsets(S: TableSpace, q: Quad, pose: Pose): Pt[] {
  return S.quad(pose).map((p, k) => [q[k][0] - p[0], q[k][1] - p[1]] as Pt);
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, a: a.a + (b.a - a.a) * t };
}

const lerpPts = (a: Pt[], b: Pt[], t: number): Pt[] => a.map((p, k) => [p[0] + (b[k][0] - p[0]) * t, p[1] + (b[k][1] - p[1]) * t]);

/** b, or b turned by a half turn, whichever is nearer a (a card lies the same either way round). */
function nearTurn(a: number, b: number): number {
  return b - Math.PI * Math.round((b - a) / Math.PI);
}

function quadBezier(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** Twice the signed area: its sign is the outline's winding. */
const area = (q: Quad) => q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => x * x * (3 - 2 * x);

/** A CSS-style cubic-bezier easing (x1, y1, x2, y2). */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const f = (a: number, b: number, s: number) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  const df = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - 3 * s) + 3 * b * s * (2 - 3 * s) + 3 * s * s;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let s = t;
    for (let i = 0; i < 6; i++) {
      const d = df(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s = clamp01(s - (f(x1, x2, s) - t) / d);
    }
    return f(y1, y2, s);
  };
}
