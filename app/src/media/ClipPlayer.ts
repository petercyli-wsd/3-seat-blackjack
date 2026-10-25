import { type ClipInfo, type Manifest, loopSpan } from "./manifest";
import type { ClipLoader } from "./preload";

/** How the next clip takes over from the current one. */
export type Handoff =
  /** At the current clip's last frame (non-loop) — seamless when the clips are contiguous in the take. */
  | "end"
  /** Loops: at the end of the forward pass — seamless too when the loop runs to the clip's last frame. */
  | "anchor"
  /** Immediately, cutting from wherever the current clip is. */
  | "now"
  /**
   * When the current clip presents this clip frame — going either way through a ping-pong
   * loop. Where a bridge starts (its first generated frame follows that frame), and where a
   * lead-in hands over to its loop.
   */
  | { exitAt: number };

/**
 * Frames of crossfade on a "now" handoff. A hard cut: the scene lays plates
 * in for one clip at a time, so a blend of two clips shows the other clip's
 * cards through (ghost cards at seats that should be bare). Generated
 * bridges between the cut poses are meant to replace these cuts.
 */
const CUT_FADE = 0;

export interface Deck {
  el: HTMLVideoElement;
  name: string | null;
  loop: boolean;
  /** Last presented frame of the file (loop files count the ping-pong frames). */
  fileFrame: number;
  ready: Promise<void> | null;
  /** The deck's file is loaded and can start playing at once (its `ready` has settled). */
  isReady: boolean;
  /** Bumped by every prepare(), so a file that arrives for a deck since re-prepared is dropped. */
  token: number;
}

export interface PlayingState {
  name: string;
  clip: ClipInfo;
  /** Frame in clip coordinates (a ping-pong loop maps back onto 0..frames-1). */
  frame: number;
  loop: boolean;
  deck: Deck;
}

interface Pending {
  deck: Deck;
  name: string;
  loop: boolean;
  handoff: Handoff;
  fade: number;
  /** true once the clip is on screen; false if it never will be (replaced, superseded, or its file failed). */
  resolve: (started: boolean) => void;
}

const DECKS = 4;

export class ClipPlayer {
  readonly decks: Deck[] = [];
  active: Deck | null = null;
  /** The deck fading out, and the fade's progress 0..1 (1 = fully on the active deck). */
  fadingFrom: Deck | null = null;
  fadeT = 1;
  private fadeStart = 0;
  private fadeDur = 0;
  private pending: Pending | null = null;
  /** The deck a takeover is readying (its file can still be downloading), and that takeover's number. */
  private taking: Deck | null = null;
  private takeoverGen = 0;
  private frameWaiters: { name: string; frame: number; resolve: () => void }[] = [];
  private nextStartWaiters: ((name: string) => void)[] = [];
  private startListeners: ((name: string) => void)[] = [];
  /** Frames the decoder took to take over at each handoff (for the director panel). */
  lastHandoffGap = 0;
  private handoffAt = 0;

  constructor(
    private m: Manifest,
    private files: ClipLoader,
    host: HTMLElement,
  ) {
    for (let i = 0; i < DECKS; i++) {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      // kept in the DOM (invisibly) so every browser keeps decoding and firing frame callbacks
      el.style.cssText = "position:absolute;width:2px;height:2px;opacity:0.001;pointer-events:none;left:0;top:0";
      host.appendChild(el);
      const deck: Deck = { el, name: null, loop: false, fileFrame: 0, ready: null, isReady: false, token: 0 };
      this.decks.push(deck);
      this.watch(deck);
    }
  }

  get fps() {
    return this.m.fps;
  }

  onStart(fn: (name: string) => void) {
    this.startListeners.push(fn);
  }

  state(deck: Deck | null = this.active): PlayingState | null {
    if (!deck || !deck.name) return null;
    const clip = this.m.clips[deck.name];
    let f = deck.fileFrame;
    if (deck.loop) {
      const { from, n } = loopSpan(clip);
      const period = 2 * n - 2;
      f = ((f % period) + period) % period;
      if (f >= n) f = period - f;
      f += from;
    }
    return { name: deck.name, clip, frame: Math.min(Math.max(f, 0), clip.frames - 1), loop: deck.loop, deck };
  }

  private fileOf(name: string, loop: boolean) {
    const c = this.m.clips[name];
    const f = loop ? c.loop : c.file;
    if (!f) throw new Error(`clip ${name} has no ${loop ? "loop" : "file"}`);
    return f;
  }

  /** Whether the clip's footage is in memory yet (else playing it waits on the download). */
  loaded(name: string, loop = false) {
    return this.files.has(this.fileOf(name, loop));
  }

  /** Load a clip into an idle deck so a later handoff starts without a decoder stall. */
  prepare(name: string, loop = false): Deck {
    const have = this.decks.find((d) => d !== this.active && d !== this.fadingFrom && d.name === name && d.loop === loop);
    if (have) return have;
    const spare = (d: Deck) => d !== this.active && d !== this.fadingFrom && d !== this.pending?.deck;
    const deck =
      this.decks.find((d) => spare(d) && d !== this.taking && !d.name) ??
      this.decks.find((d) => spare(d) && d !== this.taking) ??
      this.decks.find(spare)!;
    // no other deck free: the takeover readying this one gives way rather than play the wrong clip
    if (deck === this.taking) this.takeoverGen++;
    deck.name = name;
    deck.loop = loop;
    deck.fileFrame = 0;
    deck.el.loop = loop;
    deck.isReady = false;
    const token = ++deck.token;
    deck.ready = this.files.get(this.fileOf(name, loop)).then(
      (url) =>
        new Promise<void>((res) => {
          if (deck.token !== token) return res();
          deck.el.addEventListener("canplay", () => {
            if (deck.token === token) deck.isReady = true;
            res();
          }, { once: true });
          deck.el.src = url;
          deck.el.load();
        }),
    );
    return deck;
  }

  /**
   * Queue `name` to take over the screen. Resolves when it is on screen.
   * Only one handoff can be pending; a new one replaces it.
   */
  play(name: string, opts: { loop?: boolean; handoff?: Handoff; fade?: number } = {}): Promise<boolean> {
    const loop = opts.loop ?? false;
    let handoff = opts.handoff ?? (this.active ? "end" : "now");
    const deck = this.prepare(name, loop);
    // the exit frame is on screen right now and the clip can start at once: go
    if (typeof handoff === "object" && deck.isReady && this.framesUntil(handoff.exitAt) === 0) handoff = "now";
    // a clip that has already ended won't end again (nor fire another frame): its end is now
    if (handoff === "end" && this.active && !this.active.loop && this.active.el.ended) handoff = "now";
    const fade = opts.fade ?? (handoff === "now" && this.active ? CUT_FADE : 0);
    if (this.pending) this.pending.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending = { deck, name, loop, handoff, fade, resolve };
      if (handoff === "now" || !this.active) void this.takeOver();
    });
  }

  /** Whether a handoff is queued (the current clip will be followed by another on its own). */
  get hasPending() {
    return !!this.pending || !!this.taking;
  }

  /** A takeover has begun and its clip isn't on screen yet: what's playing is about to change. */
  get inFlight() {
    return !!this.taking;
  }

  /** Whether a deck holds this clip, loaded and able to start at once. */
  isReady(name: string, loop = false) {
    return this.decks.some((d) => d.name === name && d.loop === loop && d.isReady);
  }

  /** Frames for the active loop to come back round to where it is now (Infinity for a clip that plays once). */
  period(): number {
    const d = this.active;
    if (!d?.name || !d.loop) return Infinity;
    return 2 * loopSpan(this.m.clips[d.name]).n - 2;
  }

  /** Resolves when the next clip takes the screen, or with "" when a takeover fails. */
  whenNextStart(): Promise<string> {
    return new Promise((resolve) => this.nextStartWaiters.push(resolve));
  }

  /**
   * Frames until the active clip presents clip frame `at` (0: on screen now; Infinity: a
   * clip that plays once and is past it, or doesn't reach it).
   */
  framesUntil(at: number): number {
    const d = this.active;
    if (!d || !d.name) return Infinity;
    const clip = this.m.clips[d.name];
    if (!d.loop) return at >= d.fileFrame ? at - d.fileFrame : Infinity;
    const { from, n } = loopSpan(clip);
    const i = at - from;
    if (i < 0 || i >= n) return Infinity;
    const period = 2 * n - 2;
    const f = ((d.fileFrame % period) + period) % period;
    const ahead = (p: number) => (p - f + period) % period;
    return Math.min(ahead(i), ahead(period - i === period ? 0 : period - i));
  }

  /** Resolves when the given clip is on screen at or past `frame`. */
  whenFrame(name: string, frame: number): Promise<void> {
    const s = this.state();
    if (s && s.name === name && s.frame >= frame && !s.loop) return Promise.resolve();
    return new Promise((resolve) => this.frameWaiters.push({ name, frame, resolve }));
  }

  /** Resolves when a non-looping clip has shown its last frame. */
  whenEnded(name: string): Promise<void> {
    return this.whenFrame(name, this.m.clips[name].frames - 1);
  }

  /**
   * Put the pending clip on screen once its file is in. A newer takeover can start while this
   * one waits (a cut after a queued follow whose file is still downloading); this one then
   * gives way, or it would finish last and put the stale clip back on screen.
   */
  private async takeOver() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const gen = ++this.takeoverGen;
    this.taking = p.deck;
    // `taking` then belongs to the newer takeover, so it is left alone
    const superseded = () => {
      if (gen === this.takeoverGen) return false;
      p.resolve(false);
      return true;
    };
    try {
      await p.deck.ready;
    } catch {
      // The file failed to download: the table shows a footage error and this clip can't play.
      // Say so to whoever waits on it, so a round carries on another way instead of hanging.
      if (gen === this.takeoverGen) this.taking = null;
      p.deck.name = null;
      p.resolve(false);
      this.notifyNextStart("");
      return;
    }
    if (superseded()) return;
    // A deck reused for a clip it already played sits on that clip's last frame; drawn before
    // the seek lands, the end of the clip (cards already dealt) would show for a frame.
    if (p.deck.el.currentTime > 0) await seekToStart(p.deck.el);
    if (superseded()) return;
    const prev = this.active;
    this.handoffAt = performance.now();
    try {
      await p.deck.el.play();
    } catch {
      /* autoplay of muted video is always allowed; a rejected play() means the src changed under us */
    }
    if (superseded()) return;
    this.taking = null;
    if (prev && prev !== p.deck) {
      if (p.fade > 0) {
        this.fadingFrom = prev;
        this.fadeStart = performance.now();
        this.fadeDur = (p.fade / this.fps) * 1000;
        this.fadeT = 0;
      } else {
        prev.el.pause();
        this.fadingFrom = null;
        this.fadeT = 1;
      }
    }
    this.active = p.deck;
    p.deck.fileFrame = 0;
    for (const fn of this.startListeners) fn(p.name);
    this.notifyNextStart(p.name);
    p.resolve(true);
  }

  private notifyNextStart(name: string) {
    const waiting = this.nextStartWaiters;
    this.nextStartWaiters = [];
    for (const fn of waiting) fn(name);
  }

  /** Called every animation frame by the renderer. */
  tick(now: number) {
    if (this.fadingFrom) {
      this.fadeT = Math.min(1, (now - this.fadeStart) / Math.max(1, this.fadeDur));
      if (this.fadeT >= 1) {
        this.fadingFrom.el.pause();
        this.fadingFrom = null;
      }
    }
  }

  private watch(deck: Deck) {
    const el = deck.el;
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      const prevFrame = deck.fileFrame;
      deck.fileFrame = Math.round(meta.mediaTime * this.fps);
      if (deck === this.active) {
        if (this.handoffAt) {
          this.lastHandoffGap = Math.round(((performance.now() - this.handoffAt) / 1000) * this.fps);
          this.handoffAt = 0;
        }
        this.onActiveFrame(deck, prevFrame);
      }
      el.requestVideoFrameCallback(onFrame);
    };
    el.requestVideoFrameCallback(onFrame);
    el.addEventListener("ended", () => {
      if (deck !== this.active) return;
      const h = this.pending?.handoff;
      // an exit on a clip's last frame must not depend on a frame callback reporting that frame
      if (h === "end" || (typeof h === "object" && h.exitAt >= deck.fileFrame)) void this.takeOver();
      else if (typeof h === "object" && this.pending) {
        // A clip that plays once went past its exit (the incoming clip wasn't loaded in time) and
        // has ended: that exit won't come again. Give the handoff up so its caller can choose again.
        const p = this.pending;
        this.pending = null;
        p.resolve(false);
        this.notifyNextStart("");
      }
    });
  }

  private onActiveFrame(deck: Deck, prevFrame: number) {
    const s = this.state(deck);
    if (!s) return;
    this.frameWaiters = this.frameWaiters.filter((w) => {
      if (w.name === s.name && s.frame >= w.frame && !s.loop) {
        w.resolve();
        return false;
      }
      return true;
    });
    const p = this.pending;
    if (!p) return;
    if (typeof p.handoff === "object") {
      // Leave on the exit frame only if the incoming clip can start at once: a takeover that
      // still had to load would start late, from wherever the loop had got to. Not ready:
      // stay armed for the next time round.
      if (this.crossed(deck, prevFrame, p.handoff.exitAt) && p.deck.isReady) void this.takeOver();
      return;
    }
    if (p.handoff === "end" && !deck.loop && deck.fileFrame >= s.clip.frames - 1) void this.takeOver();
    if (p.handoff === "anchor" && deck.loop) {
      const { n } = loopSpan(s.clip);
      const period = 2 * n - 2;
      const a = ((prevFrame % period) + period) % period;
      const b = ((deck.fileFrame % period) + period) % period;
      const crossed = (a < n - 1 && b >= n - 1) || (b < a && a < n - 1);
      if (crossed || b === n - 1) void this.takeOver();
    }
    if (p.handoff === "end" && deck.loop) void this.takeOver();
  }

  /** Whether the deck's last presented frame reached clip frame `at` since the frame before (rVFC can skip frames). */
  private crossed(deck: Deck, prevFile: number, at: number): boolean {
    const clip = this.m.clips[deck.name!];
    if (!deck.loop) return prevFile < at && deck.fileFrame >= at || deck.fileFrame === at;
    const { from, n } = loopSpan(clip);
    const i = at - from;
    if (i < 0 || i >= n) return false;
    const period = 2 * n - 2;
    const a = ((prevFile % period) + period) % period;
    const b = ((deck.fileFrame % period) + period) % period;
    // the file frames showing clip frame `at`: on the way out and (unless an end) on the way back
    const marks = i === 0 || i === n - 1 ? [i] : [i, period - i];
    const between = (p: number) => (a < b ? a < p && p <= b : a < p || p <= b);
    return a !== b && marks.some(between) || marks.includes(b);
  }

  /** Frames until the current loop reaches its forward anchor (for deciding between waiting and cutting). */
  framesToAnchor(): number {
    const d = this.active;
    if (!d || !d.loop || !d.name) return 0;
    const { n } = loopSpan(this.m.clips[d.name]);
    const period = 2 * n - 2;
    const f = ((d.fileFrame % period) + period) % period;
    return f <= n - 1 ? n - 1 - f : period - f + n - 1;
  }

  stopAll() {
    this.pending?.resolve(false);
    this.pending = null;
    this.taking = null;
    this.takeoverGen++;
    for (const d of this.decks) {
      d.el.pause();
      d.name = null;
    }
    this.active = null;
    this.fadingFrom = null;
  }
}

function seekToStart(el: HTMLVideoElement): Promise<void> {
  return new Promise((res) => {
    el.addEventListener("seeked", () => res(), { once: true });
    el.currentTime = 0;
  });
}
