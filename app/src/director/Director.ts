import type { Card } from "../engine/cards";
import { RULES, dealerDraws, handFinished, isBlackjack, isBust, isCharlie, total } from "../engine/rules";
import { settle } from "../engine/settle";
import { Shoe } from "../engine/shoe";
import { autoHit } from "../engine/strategy";
import type { ClipPlayer, Handoff } from "../media/ClipPlayer";
import { type Manifest, type SeatId, clipName, naturalNext } from "../media/manifest";
import type { TableView } from "../render/scene";
import { SCENARIOS, stack } from "./scenarios";
import type { Mode, RoundRecord, SeatStatus, Store } from "./store";

export const DECISION_SECONDS: Record<Mode, number> = { speed: 7, regular: 14 };
const DEFAULT_BET = 10;
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

  constructor(
    private m: Manifest,
    private player: ClipPlayer,
    readonly store: Store,
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

  canDeal() {
    const s = this.store.get();
    const taken = this.m.seats.filter((k) => s.seats[k].taken);
    return s.phase === "betting" && taken.length > 0 && taken.every((k) => s.seats[k].bet >= RULES.minBet) && this.committed() <= s.balance;
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
    const fresh = { taken: false, bet: 0, cards: [], status: "empty" as SeatStatus, result: null };
    this.store.set({
      seats: { seat1: { ...fresh }, seat2: { ...fresh }, seat3: { ...fresh } },
      dealer: [], activeSeat: null, decision: null, balance: 1000, lastNet: null, round: 0, history: [],
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

  /** Hand the screen to `target`: seamlessly if it follows the current clip in the take, else a short crossfade. */
  private async cutTo(target: string, opts: { loop?: boolean; patience?: number } = {}) {
    const cur = this.player.state();
    let handoff: Handoff = "now";
    if (cur && naturalNext(this.m, cur.name) === target) {
      // a player is waiting on a hit, so only hold out for the seamless point if it is close
      if (!cur.loop) handoff = "end";
      else if (this.player.framesToAnchor() < (opts.patience ?? 0.75) * this.m.fps) handoff = "anchor";
    }
    this.log(`${cur?.name ?? "-"} → ${target} (${handoff === "now" ? "crossfade" : "seamless"})`);
    await this.player.play(target, { loop: opts.loop, handoff });
  }

  /** Queue a clip to follow the current one with no seam (it is the next shot of the take). */
  private follow(target: string, loop = false) {
    return this.player.play(target, { loop, handoff: "end" });
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
    this.view.seats = { seat1: [], seat2: [], seat3: [] };
    this.view.dealer = [];
    this.view.dealerDrawAt = [];
    for (let r = 0; r < 2; r++) {
      for (const k of order) this.view.seats[k].push(this.shoe.draw());
      this.view.dealer.push(this.shoe.draw());
    }
    this.store.set((s) => ({
      phase: "dealing",
      balance: s.balance - stake,
      round: s.round + 1,
      lastNet: null,
      message: "Dealing",
      dealer: [...this.view.dealer],
      seats: Object.fromEntries(seats.map((k) => [k, {
        ...s.seats[k], cards: [...this.view.seats[k]], result: null,
        status: (s.seats[k].taken ? "waiting" : "empty") as SeatStatus,
      }])) as unknown as typeof s.seats,
    }));
    this.log(`round ${this.store.get().round}: mask ${this.mask}, stake ${stake}`);

    const deal = clipName.deal(this.mask);
    await this.cutTo(deal);
    this.guard(epoch);
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
        hand.push(card);
        this.store.setSeat(id, { cards: [...hand], status: "waiting" });
        this.store.set({ message: `Seat ${id.slice(-1)} hits` });
        const k = hand.length;
        const hit = clipName.hit(id, k);
        await this.cutTo(hit);
        this.guard(epoch);
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
        await this.player.whenEnded(hit);
        this.guard(epoch);
      }
    }
    this.store.set({ activeSeat: null, decision: null });

    // dealer: real reveal of the hole card, then graphic draws over the hold loop
    this.store.set({ phase: "dealer", message: "Dealer reveals" });
    const reveal = clipName.reveal(this.mask);
    await this.cutTo(reveal, { patience: 2.5 });
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
    await sleep(2800);
    this.guard(epoch);

    // clear the table, back to betting over the idle that follows this discard in the take
    this.store.set({ phase: "clearing", message: "" });
    const discard = clipName.discard(this.mask);
    await this.cutTo(discard, { patience: 2.5 });
    this.guard(epoch);
    void this.follow(clipName.idle(this.mask), true);
    await this.player.whenEnded(discard);
    this.guard(epoch);
    this.view.seats = { seat1: [], seat2: [], seat3: [] };
    this.view.dealer = [];
    this.view.dealerDrawAt = [];
    const s = this.store.get();
    this.store.set({
      phase: "betting",
      dealer: [],
      message: "Place your bets",
      seats: Object.fromEntries(seats.map((k) => [k, {
        ...s.seats[k], cards: [], result: null,
        status: (s.seats[k].taken ? "seated" : "empty") as SeatStatus,
        // re-bet: keep each stake if the balance still covers it
        bet: s.seats[k].taken ? Math.min(s.seats[k].bet, Math.max(0, s.balance)) : 0,
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
