import type { Card } from "../engine/cards";
import { RULES, dealerDraws, handFinished, isBlackjack, isBust, isCharlie, total } from "../engine/rules";
import { settle } from "../engine/settle";
import { Shoe } from "../engine/shoe";
import { autoHit } from "../engine/strategy";
import { timing } from "../ending";
import type { Clear, Clearing, Ending } from "../ending/types";
import type { ClipPlayer, Handoff } from "../media/ClipPlayer";
import { type Bridge, type Manifest, type SeatId, clipName, loopSpan, naturalNext } from "../media/manifest";
import type { TableView } from "../render/scene";
import { SCENARIOS, stack } from "./scenarios";
import type { Mode, RoundRecord, SeatStatus, Store } from "./store";

export const DECISION_SECONDS: Record<Mode, number> = { speed: 7, regular: 14 };
const DEFAULT_BET = 10;
/** Frames after the last pickup of a discard before the table counts as clear (the scene's plate fade-out). */
const CLEARED_FRAMES = 6;
/** Frames of notice a bridge whose clip isn't loaded yet needs to start exactly on its exit frame. */
const BRIDGE_NOTICE = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Decision = "hit" | "stand";

/**
 * Runs the table: the round script, written against the footage. Every step
 * is "make the game decision, then ask the player for the clip that shows it
 * and wait until the footage has actually shown it", so the HUD never
 * reveals a card before the dealer has put it down.
 */
export class Director {
  readonly view: TableView = { seats: { seat1: [], seat2: [], seat3: [] }, dealer: [], dealerDrawAt: [] };
  private shoe = new Shoe();
  private decide: ((d: Decision) => void) | null = null;
  private running = false;
  /** Bumped by a table reset so an in-flight round script stops at its next await. */
  private epoch = 0;
  private mask = "000";
  private cutGen = 0;
  /** A no-discard clear under way (ending/): what the render hook draws over the table. */
  clearing: Clearing | null = null;
  /** The footage going back to the betting loop after a no-discard clear, while betting is open. */
  private backToBetting: Promise<void> | null = null;

  constructor(
    private m: Manifest,
    private player: ClipPlayer,
    readonly store: Store,
    /** Interpolated moves between clips not filmed back to back, by the clip they leave. */
    private bridges: Map<string, Bridge[]> = new Map(),
  ) {}

  get shoeStats() {
    return { remaining: this.shoe.remaining, shuffles: this.shoe.shuffles };
  }

  log(line: string) {
    const t = new Date().toLocaleTimeString([], { hour12: false });
    this.store.set((s) => ({ debug: { ...s.debug, log: [`${t}  ${line}`, ...s.debug.log].slice(0, 80) } }));
  }

  /** Start the table: the opening idle loop, betting open. */
  async open() {
    this.store.set({ phase: "betting", message: "Take a seat and place your bets" });
    await this.player.play(clipName.openingIdle, { loop: true, handoff: "now" });
    this.log("table open");
  }

  // ---- betting-phase commands -------------------------------------------------------------

  toggleSeat(id: SeatId) {
    const s = this.store.get();
    if (s.phase !== "betting") return;
    const seat = s.seats[id];
    if (seat.taken) {
      this.store.setSeat(id, { taken: false, bet: 0, status: "empty", cards: [], result: null });
    } else {
      this.store.setSeat(id, { taken: true, bet: Math.min(DEFAULT_BET, this.available()), status: "seated" });
    }
  }

  private committed(except?: SeatId) {
    const s = this.store.get();
    return (Object.keys(s.seats) as SeatId[]).filter((k) => k !== except).reduce((a, k) => a + s.seats[k].bet, 0);
  }

  private available(except?: SeatId) {
    return this.store.get().balance - this.committed(except);
  }

  addChip(id: SeatId) {
    const s = this.store.get();
    if (s.phase !== "betting") return;
    if (!s.seats[id].taken) this.toggleSeat(id);
    const seat = this.store.get().seats[id];
    const room = Math.min(this.available(id) - seat.bet, RULES.maxBet - seat.bet);
    if (room <= 0) return;
    this.store.setSeat(id, { bet: seat.bet + Math.min(s.chip, room) });
  }

  clearBets() {
    const s = this.store.get();
    if (s.phase !== "betting") return;
    for (const id of this.m.seats) if (s.seats[id].taken) this.store.setSeat(id, { bet: 0 });
  }

  setChip(v: number) {
    this.store.set({ chip: v });
  }

  setMode(mode: Mode) {
    this.store.set({ mode });
  }

  setScenario(key: string) {
    this.store.set({ scenario: key });
  }

  /** How rounds end. A round can't change its ending halfway, so switching starts a new game. */
  setEnding(ending: Ending) {
    if (ending === this.store.get().ending) return;
    this.store.set({ ending });
    this.log(`ending: ${ending} — new game`);
    void this.resetTable();
  }

  canDeal() {
    return this.store.get().phase === "betting" && !this.dealBlocker();
  }

  /** Why Deal is unavailable during betting, for the bet bar; null when it is available. */
  dealBlocker(): string | null {
    const s = this.store.get();
    const taken = this.m.seats.filter((k) => s.seats[k].taken);
    if (!taken.length) return "Take a seat to play";
    const unbet = taken.filter((k) => s.seats[k].bet < RULES.minBet);
    if (unbet.length) return `Bet on seat ${unbet.map((k) => k.slice(-1)).join(" & ")}, or leave it`;
    if (this.committed() > s.balance) return "Bets are more than your balance";
    return null;
  }

  // ---- player-turn commands ------------------------------------------------------------------

  act(d: Decision) {
    this.decide?.(d);
  }

  /** Hard restart: clears the table and the shoe and goes back to the opening idle. */
  async resetTable() {
    this.epoch++;
    this.decide?.("stand");
    this.decide = null;
    this.running = false;
    this.shoe = new Shoe();
    this.view.seats = { seat1: [], seat2: [], seat3: [] };
    this.view.dealer = [];
    this.view.dealerDrawAt = [];
    this.view.home = undefined;
    this.clearing = null;
    this.backToBetting = null;
    const fresh = { taken: false, bet: 0, cards: [], status: "empty" as SeatStatus, result: null };
    this.store.set({
      seats: { seat1: { ...fresh }, seat2: { ...fresh }, seat3: { ...fresh } },
      dealer: [], activeSeat: null, decision: null, balance: 1000, lastNet: null, round: 0, history: [], clearing: null,
    });
    this.log("table reset");
    await this.open();
  }

  // ---- the round -------------------------------------------------------------------------------

  async deal() {
    if (!this.canDeal() || this.running) return;
    this.running = true;
    const epoch = this.epoch;
    try {
      // a no-discard round reopens betting while the footage is still on its way back to the
      // betting loop: the deal follows on from there
      if (this.backToBetting) await this.backToBetting;
      this.guard(epoch);
      await this.round(epoch);
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
    } finally {
      if (epoch === this.epoch) this.running = false;
    }
  }

  private guard(epoch: number) {
    if (epoch !== this.epoch) throw new Abort();
  }

  /**
   * Hand the screen to `target`, as smoothly as the footage allows. The ways to get there:
   *
   * - seamless, where `target` is the next shot of the take: at the end of a clip playing out,
   *   or where a loop whose window runs to its clip's end comes round to that last frame;
   * - through a bridge (a generated move from one of the clip's exit frames to `target`'s
   *   first frame), when the loop comes round to that exit frame.
   *
   * Whichever comes round soonest is taken. A bridge whose clip isn't loaded yet needs a few
   * frames' notice to start on its exit frame, so an exit closer than that counts from the next
   * time round. A clip with no way to `target` that is about to give way to one that may have
   * (a discard running into its idle, an idle's lead-in into its loop) is waited out, as is a
   * takeover already under way. Only with no way at all is it a hard cut.
   */
  private async cutTo(target: string, opts: { loop?: boolean } = {}) {
    this.cutGen++; // a lead-in still on its way to its loop (settleInto) must not queue over this cut
    // a table reset mid-cut must not let the rest of this cut queue its clips over the fresh table
    const epoch = this.epoch;
    const failed = new Set<string>(); // bridges that couldn't start: not chosen again in this cut
    for (;;) {
      // a clip is taking over right now: what is on screen is about to change, choose after it
      if (this.player.inFlight) {
        await this.player.whenNextStart();
        this.guard(epoch);
        continue;
      }
      const cur = this.player.state();
      if (!cur) break;
      type Way = { wait: number; bridge?: Bridge };
      const ways: Way[] = [];
      if (naturalNext(this.m, cur.name) === target) {
        const span = loopSpan(cur.clip);
        if (!cur.loop) ways.push({ wait: Math.max(0, cur.clip.frames - 1 - cur.frame) });
        else if (span.from + span.n === cur.clip.frames) ways.push({ wait: this.player.framesToAnchor() });
      }
      for (const b of this.bridges.get(cur.name) ?? []) {
        if (b.to !== target || failed.has(b.name)) continue;
        let wait = this.player.framesUntil(b.at);
        if (wait < BRIDGE_NOTICE && !(b.frames === 0 || this.player.isReady(b.name))) wait += this.player.period();
        if (Number.isFinite(wait)) ways.push({ wait, bridge: b });
      }
      // soonest first; on a tie the take's own continuation beats a generated one
      const best = ways.sort((x, y) => x.wait - y.wait || Number(!!x.bridge) - Number(!!y.bridge))[0];
      if (best && !best.bridge) {
        this.log(`${cur.name} → ${target} (seamless; in ${best.wait} fr)`);
        await this.play(target, { loop: opts.loop, handoff: cur.loop ? "anchor" : "end" });
        return;
      }
      if (best?.bridge) {
        const b = best.bridge;
        const what = b.frames ? `${b.source === "tool" ? "generated" : "stand-in"} ${b.class} bridge, ${b.frames} fr` : "matched cut";
        this.log(`${cur.name}@${b.at} → ${target} (${what}; exit in ${best.wait} fr)`);
        if (b.frames > 0) {
          const starting = this.play(b.name, { handoff: { exitAt: b.at } });
          // load the target alongside (after the bridge has its deck), ready the moment the bridge ends
          this.player.prepare(target, opts.loop);
          const started = await starting;
          this.guard(epoch);
          // couldn't start (its file failed, or the clip ended past the exit): choose again
          if (!started) {
            failed.add(b.name);
            continue;
          }
          await this.play(target, { loop: opts.loop, handoff: "end" });
        } else if (!(await this.play(target, { loop: opts.loop, handoff: { exitAt: b.at } }))) {
          this.guard(epoch);
          failed.add(b.name);
          continue;
        }
        return;
      }
      if (!cur.loop && this.player.hasPending) {
        await this.player.whenNextStart();
        this.guard(epoch);
        continue;
      }
      break;
    }
    this.log(`${this.player.state()?.name ?? "-"} → ${target} (cut)`);
    await this.play(target, { loop: opts.loop, handoff: "now" });
  }

  /** player.play, saying so if the footage is still downloading (it loads after the table opens). */
  private async play(name: string, opts: { loop?: boolean; handoff: Handoff }): Promise<boolean> {
    const before = this.store.get().message;
    const buffering = !this.player.loaded(name, opts.loop);
    if (buffering) this.store.set({ message: "Loading footage…" });
    const started = await this.player.play(name, opts);
    if (buffering && this.store.get().message === "Loading footage…") this.store.set({ message: before });
    return started;
  }

  /** Queue a clip to follow the current one with no seam (it is the next shot of the take). */
  private follow(target: string, loop = false) {
    return this.player.play(target, { loop, handoff: "end" });
  }

  /**
   * Follow the current clip with `name` and settle into its loop. A loop whose window starts
   * later than the clip (an idle's calm stretch) first plays its lead-in from the clip itself,
   * so the dealer comes to rest as filmed instead of jumping into the window.
   */
  private async settleInto(name: string) {
    const from = loopSpan(this.m.clips[name]).from;
    if (from <= 0) return this.follow(name, true);
    const gen = this.cutGen;
    const epoch = this.epoch;
    await this.follow(name);
    if (gen !== this.cutGen || epoch !== this.epoch || this.player.state()?.name !== name) return;
    const settled = await this.player.play(name, { loop: true, handoff: { exitAt: from - 1 } });
    // the loop wasn't loaded by the time the lead-in got there: start it rather than freeze
    if (!settled && gen === this.cutGen && epoch === this.epoch && this.player.state()?.name === name) {
      await this.player.play(name, { loop: true, handoff: "now" });
    }
  }

  private landing(clip: string, slot: SeatId | "up" | "hole", index: number) {
    const c = this.m.clips[clip].cards.find((x) => x.slot === slot && x.index === index);
    return c ? Math.max(0, c.in) : 0;
  }

  private setStatus(id: SeatId, status: SeatStatus) {
    this.store.setSeat(id, { status });
  }

  private async round(epoch: number) {
    const st = this.store.get();
    const seats = this.m.seats;
    const order = this.m.playOrder.filter((k) => st.seats[k].taken);
    this.mask = seats.map((k) => (st.seats[k].taken ? "1" : "0")).join("");
    const bets = Object.fromEntries(seats.map((k) => [k, st.seats[k].taken ? st.seats[k].bet : 0])) as Record<SeatId, number>;
    const stake = Object.values(bets).reduce((a, b) => a + b, 0);

    if (this.shoe.needsShuffle) {
      this.shoe.shuffle();
      this.log("cut card reached — new shoe");
    }
    const scenario = SCENARIOS[st.scenario];
    if (scenario) this.shoe.force(stack(scenario, order));

    // the deal, in the order the dealer deals it on film: each seat right to left, then the dealer; twice
    const hands: TableView["seats"] = { seat1: [], seat2: [], seat3: [] };
    const dealer: Card[] = [];
    for (let r = 0; r < 2; r++) {
      for (const k of order) hands[k].push(this.shoe.draw());
      dealer.push(this.shoe.draw());
    }
    this.store.set((s) => ({
      phase: "dealing",
      balance: s.balance - stake,
      round: s.round + 1,
      lastNet: null,
      message: "Dealing",
      dealer: [...dealer],
      seats: Object.fromEntries(seats.map((k) => [k, {
        ...s.seats[k], cards: [...hands[k]], result: null,
        status: (s.seats[k].taken ? "waiting" : "empty") as SeatStatus,
      }])) as unknown as typeof s.seats,
    }));
    this.log(`round ${this.store.get().round}: mask ${this.mask}, stake ${stake}`);

    const deal = clipName.deal(this.mask);
    await this.cutTo(deal);
    this.guard(epoch);
    // Cards go into the view only now the clip dealing them is on screen. In the view any
    // earlier, the idle still playing would get the dealt hands' plates: the result for a moment,
    // then the deal from the start.
    this.view.seats = hands;
    this.view.dealer = dealer;
    this.view.dealerDrawAt = [];
    // and they stay where this take's dealer puts them, through hits filmed in another take
    this.view.home = this.mask;
    void this.follow(clipName.wait(this.mask), true);
    await this.player.whenEnded(deal);
    this.guard(epoch);

    // player turns, right to left; naturals are announced as soon as the cards are down
    this.store.set({ phase: "players" });
    const naturals = order.filter((k) => isBlackjack(this.view.seats[k]));
    for (const k of naturals) this.setStatus(k, "blackjack");
    if (naturals.length) {
      this.store.set({ message: `Blackjack for seat ${naturals.map((k) => k.slice(-1)).join(" & ")}!` });
      await sleep(1100);
      this.guard(epoch);
    }
    for (const id of order) {
      const hand = this.view.seats[id];
      if (isBlackjack(hand)) continue;
      for (;;) {
        const d = await this.askDecision(id, epoch);
        this.guard(epoch);
        if (d === "stand") {
          this.setStatus(id, "stood");
          this.store.set({ message: `Seat ${id.slice(-1)} stands` });
          break;
        }
        const card = this.shoe.draw();
        this.store.set({ message: `Seat ${id.slice(-1)} hits` });
        const k = hand.length + 1;
        const hit = clipName.hit(id, k);
        await this.cutTo(hit);
        this.guard(epoch);
        // on the table only once the hit clip is on screen (see the deal)
        hand.push(card);
        this.store.setSeat(id, { cards: [...hand], status: "waiting" });
        void this.follow(clipName.hitWait(id, k), true);
        await this.player.whenFrame(hit, this.landing(hit, id, k) + 2);
        this.guard(epoch);
        if (isBust(hand)) this.setStatus(id, "bust");
        else if (isCharlie(hand)) this.setStatus(id, "charlie");
        else if (total(hand).best === 21) this.setStatus(id, "twentyone");
        if (handFinished(hand)) {
          const what = isBust(hand) ? "busts" : isCharlie(hand) ? "— six-card charlie!" : "has 21";
          this.store.set({ message: `Seat ${id.slice(-1)} ${what}` });
        }
        if (handFinished(hand)) {
          await this.player.whenEnded(hit);
          this.guard(epoch);
          break;
        }
        // the next call opens as soon as the card is down, as at a real table; the next cut
        // waits for her to come back to rest (cutTo) if the player answers that fast
      }
    }
    this.store.set({ activeSeat: null, decision: null });

    // dealer: real reveal of the hole card, then graphic draws over the hold loop
    this.store.set({ phase: "dealer", message: "Dealer reveals" });
    const reveal = clipName.reveal(this.mask);
    await this.cutTo(reveal);
    this.guard(epoch);
    void this.follow(clipName.hold(this.mask), true);
    const hole = this.m.clips[reveal].cards.find((c) => c.slot === "hole");
    await this.player.whenFrame(reveal, (hole?.flip ?? 0) + 3);
    this.guard(epoch);
    // the dealer only plays out a hand if some player hand is still standing to be beaten
    const live = order.some((k) => !isBust(this.view.seats[k]) && !isBlackjack(this.view.seats[k]));
    await this.player.whenEnded(reveal);
    this.guard(epoch);
    if (live) {
      while (dealerDraws(this.view.dealer)) {
        await sleep(450);
        this.guard(epoch);
        this.view.dealer.push(this.shoe.draw());
        this.view.dealerDrawAt.push(performance.now());
        this.store.set({ dealer: [...this.view.dealer], message: "Dealer draws" });
        await sleep(650);
        this.guard(epoch);
      }
    }
    await sleep(350);
    this.guard(epoch);

    // settle
    const record: RoundRecord = { no: this.store.get().round, mask: this.mask, dealer: [...this.view.dealer], seats: [], net: -stake };
    let returned = 0;
    for (const id of order) {
      const r = settle(this.view.seats[id], this.view.dealer, bets[id]);
      returned += r.payout;
      this.store.setSeat(id, { result: r });
      record.seats.push({ seat: id, cards: [...this.view.seats[id]], bet: bets[id], result: r });
    }
    record.net = returned - stake;
    const d = total(this.view.dealer).best;
    this.store.set((s) => ({
      phase: "settling",
      balance: s.balance + returned,
      lastNet: record.net,
      history: [record, ...s.history].slice(0, 30),
      message: isBlackjack(this.view.dealer) ? "Dealer has Blackjack" : d > 21 ? `Dealer busts with ${d}` : `Dealer stands on ${d}`,
    }));
    this.log(`settled: net ${record.net >= 0 ? "+" : ""}${record.net}`);
    const ending = this.store.get().ending;
    if (ending !== "discard" && ending !== "board") return this.clearWithoutDiscard(ending, epoch);
    const discard = clipName.discard(this.mask);
    if (ending === "board") {
      // The results board rises over the table after a short read, and the discard is asked for
      // only once it covers the cards: the laid-in ones (hits, the dealer's draws) fade as her hand
      // comes for them, under it. It stays up while she clears, and leaves as betting reopens.
      const { readMs, duration } = timing(ending);
      await sleep(readMs);
      this.guard(epoch);
      this.store.set({ clearing: { style: ending, startedAt: performance.now(), duration } });
      await sleep(duration);
      this.guard(epoch);
      await this.cutTo(discard);
    } else {
      // The discard can only start where the hold loop comes round to the take's own next frame
      // (up to a loop's length away), so ask for it after a short read of the results, not after a
      // fixed pause plus that wait. The results stay up while she clears.
      await sleep(1500);
      this.guard(epoch);
      await Promise.all([this.cutTo(discard), sleep(1300)]);
    }
    this.guard(epoch);
    // clear the table, back to betting over the idle that follows this discard in the take
    this.store.set({ phase: "clearing", message: "" });
    void this.settleInto(clipName.idle(this.mask));
    // Betting reopens once the last card is in the tray (and its plate has faded), not at the
    // clip's end: the 2-5 s after that are her squaring the tray, and a Deal can cut them short.
    const dc = this.m.clips[discard];
    await this.player.whenFrame(discard, Math.min(dc.frames - 1, Math.max(0, ...dc.cards.map((c) => c.out)) + CLEARED_FRAMES));
    this.guard(epoch);
    this.emptyTable();
    if (ending === "board") this.store.set({ clearing: null });
    this.reopenBetting();
  }

  /**
   * The round ends without the discard footage: she stays at rest in the hold loop while the
   * style clears the table (ending/), then the footage goes from her rest straight back to the
   * betting loop of this take (the idle that follows its discard as filmed).
   */
  private async clearWithoutDiscard(style: Clear, epoch: number) {
    const { readMs, duration } = timing(style);
    await sleep(readMs);
    this.guard(epoch);
    const startedAt = performance.now();
    const v = this.view;
    this.clearing = {
      style, startedAt, duration, mask: this.mask, done: false,
      seats: { seat1: [...v.seats.seat1], seat2: [...v.seats.seat2], seat3: [...v.seats.seat3] },
      dealer: [...v.dealer],
    };
    this.store.set({ phase: "clearing", clearing: { style, startedAt, duration } });
    await sleep(duration);
    this.guard(epoch);
    // the table is empty: the style keeps every real card hidden until the footage leaves the hold
    this.clearing = { ...this.clearing, done: true };
    this.emptyTable();
    // Betting reopens on the bare table at once: waiting for the hold to come round to a bridge
    // (up to a loop's length) would leave the table empty and silent. The footage goes back to the
    // betting loop meanwhile, the cards kept hidden until it has; a Deal waits for it (deal()).
    this.backToBetting = this.cutTo(this.bettingAfterHold(), { loop: true }).then(
      () => {
        if (epoch !== this.epoch) return;
        this.clearing = null;
        this.backToBetting = null;
        this.store.set({ clearing: null });
      },
      (e: unknown) => {
        if (!(e instanceof Abort)) throw e;
      },
    );
    this.reopenBetting();
  }

  /**
   * The betting loop to go back to from this take's hold: the one its bridges lead to (a take whose
   * own idle starts mid-reach is bridged to a calmer take's idle instead), else its own idle.
   */
  private bettingAfterHold() {
    const own = clipName.idle(this.mask);
    const to = (this.bridges.get(clipName.hold(this.mask)) ?? []).map((b) => b.to).filter((n) => this.m.clips[n]?.kind === "idle");
    return to.includes(own) || !to.length ? own : to[0];
  }

  private emptyTable() {
    this.view.seats = { seat1: [], seat2: [], seat3: [] };
    this.view.dealer = [];
    this.view.dealerDrawAt = [];
    this.view.home = undefined;
  }

  /** Betting opens again, the stakes kept seat by seat as far as the balance still covers them. */
  private reopenBetting() {
    const seats = this.m.seats;
    const s = this.store.get();
    // re-bet: keep the stakes, seat by seat, as far as the balance still covers them all together
    let left = Math.max(0, s.balance);
    const rebet = (k: SeatId) => {
      const bet = s.seats[k].taken ? Math.min(s.seats[k].bet, left) : 0;
      left -= bet;
      return bet;
    };
    this.store.set({
      phase: "betting",
      dealer: [],
      message: s.balance < RULES.minBet ? "Out of chips — Reset to play again" : "Place your bets",
      seats: Object.fromEntries(seats.map((k) => [k, {
        ...s.seats[k], cards: [], result: null,
        status: (s.seats[k].taken ? "seated" : "empty") as SeatStatus,
        bet: rebet(k),
      }])) as unknown as typeof s.seats,
    });
  }

  private askDecision(id: SeatId, epoch: number): Promise<Decision> {
    const secs = DECISION_SECONDS[this.store.get().mode];
    const now = performance.now();
    this.setStatus(id, "acting");
    this.store.set({
      activeSeat: id,
      decision: { seat: id, startedAt: now, deadline: now + secs * 1000 },
      message: `Seat ${id.slice(-1)} — hit or stand?`,
    });
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        const hand = this.view.seats[id];
        const auto = autoHit(hand, this.view.dealer[0] as Card) ? "hit" : "stand";
        this.log(`seat ${id.slice(-1)} timed out — auto ${auto}`);
        done(auto);
      }, secs * 1000);
      const done = (d: Decision) => {
        clearTimeout(timer);
        this.decide = null;
        if (epoch === this.epoch) this.store.set({ decision: null });
        resolve(d);
      };
      this.decide = done;
    });
  }
}

class Abort extends Error {}
