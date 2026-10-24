import { type ClipInfo, type Manifest, loopSpan } from "./manifest";
import type { ClipLoader } from "./preload";

/** How the next clip takes over from the current one. */
export type Handoff =
  /** At the current clip's last frame (non-loop) — seamless when the clips are contiguous in the take. */
  | "end"
  /** Loops: at the end of the forward pass — seamless too when the loop runs to the clip's last frame. */
  | "anchor"
  /** Immediately, cutting from wherever the current clip is. */
  | "now";

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
  resolve: () => void;
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
  private frameWaiters: { name: string; frame: number; resolve: () => void }[] = [];
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
      const deck: Deck = { el, name: null, loop: false, fileFrame: 0, ready: null, token: 0 };
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
    const deck =
      this.decks.find((d) => d !== this.active && d !== this.fadingFrom && d !== this.pending?.deck && !d.name) ??
      this.decks.find((d) => d !== this.active && d !== this.fadingFrom && d !== this.pending?.deck)!;
    deck.name = name;
    deck.loop = loop;
    deck.fileFrame = 0;
    deck.el.loop = loop;
    const token = ++deck.token;
    deck.ready = this.files.get(this.fileOf(name, loop)).then(
      (url) =>
        new Promise<void>((res) => {
          if (deck.token !== token) return res();
          deck.el.addEventListener("canplay", () => res(), { once: true });
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
  play(name: string, opts: { loop?: boolean; handoff?: Handoff; fade?: number } = {}): Promise<void> {
    const loop = opts.loop ?? false;
    const handoff = opts.handoff ?? (this.active ? "end" : "now");
    const fade = opts.fade ?? (handoff === "now" && this.active ? CUT_FADE : 0);
    const deck = this.prepare(name, loop);
    if (this.pending) this.pending.resolve();
    return new Promise<void>((resolve) => {
      this.pending = { deck, name, loop, handoff, fade, resolve };
      if (handoff === "now" || !this.active) void this.takeOver();
    });
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

  private async takeOver() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    await p.deck.ready;
    // A deck reused for a clip it already played sits on that clip's last frame; drawn before
    // the seek lands, the end of the clip (cards already dealt) would show for a frame.
    if (p.deck.el.currentTime > 0) await seekToStart(p.deck.el);
    const prev = this.active;
    this.handoffAt = performance.now();
    try {
      await p.deck.el.play();
    } catch {
      /* autoplay of muted video is always allowed; a rejected play() means the src changed under us */
    }
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
    p.resolve();
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
      if (deck === this.active && this.pending?.handoff === "end") void this.takeOver();
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
    this.pending = null;
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
