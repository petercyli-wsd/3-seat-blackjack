import type { Director } from "../director/Director";
import { DECISION_SECONDS } from "../director/Director";
import { type Store, useGame } from "../director/store";
import { label } from "../engine/rules";
import type { SeatId } from "../media/manifest";
import { CHIPS, Chip, ChipStack, PlayingCard } from "./PlayingCard";
import { OUTCOME_LABEL, STATUS_LABEL, money, seatNo, signedMoney } from "./format";

const SEATS: SeatId[] = ["seat1", "seat2", "seat3"];
/** The dealer plays seats right to left; shown so players know who is next. */
const TURN: Record<SeatId, string> = { seat3: "1st", seat2: "2nd", seat1: "3rd" };

function SeatPanel({ store, director, id }: { store: Store; director: Director; id: SeatId }) {
  const seat = useGame(store, (s) => s.seats[id]);
  const visible = useGame(store, (s) => s.visible[id]);
  const phase = useGame(store, (s) => s.phase);
  const active = useGame(store, (s) => s.activeSeat === id && !!s.decision);
  const betting = phase === "betting";
  const shown = seat.cards.slice(0, visible);
  const total = label(shown);
  const settled = phase === "settling" || phase === "clearing" ? seat.result : null;
  return (
    <section className={`seat-panel ${seat.taken ? "is-taken" : ""} ${active ? "is-active" : ""} status-${seat.status}`}>
      <header className="seat-panel-head">
        <div className="seat-panel-title">
          <span className="seat-panel-no">Seat {seatNo(id)}</span>
          <span className="seat-panel-turn">{TURN[id]} to act</span>
        </div>
        <button
          className={`seat-toggle ${seat.taken ? "is-on" : ""}`}
          onClick={() => director.toggleSeat(id)}
          disabled={!betting}
          aria-pressed={seat.taken}
          title={betting ? (seat.taken ? "Leave seat" : "Take seat") : "Seats can change between rounds"}
        >
          <span className="seat-toggle-knob" />
          <span className="seat-toggle-label">{seat.taken ? "Taken" : "Open"}</span>
        </button>
      </header>

      <div className="seat-panel-body">
        {seat.taken ? (
          <>
            <div className="seat-cards">
              {shown.length ? shown.map((c, i) => <PlayingCard key={i} card={c} />) : <div className="seat-cards-empty">{betting ? "Ready" : "Waiting for cards"}</div>}
            </div>
            <div className="seat-meta">
              {total && <span className="seat-total">{total}</span>}
              {settled ? (
                <span className={`seat-outcome outcome-${settled.outcome}`}>
                  {OUTCOME_LABEL[settled.outcome]}
                  {settled.payout > 0 && settled.outcome !== "push" && <b>{signedMoney(settled.payout - seat.bet)}</b>}
                </span>
              ) : (
                STATUS_LABEL[seat.status] && seat.status !== "acting" && <span className={`seat-badge badge-${seat.status}`}>{STATUS_LABEL[seat.status]}</span>
              )}
            </div>
          </>
        ) : (
          <button className="seat-take" onClick={() => director.toggleSeat(id)} disabled={!betting}>
            <span className="seat-take-plus">+</span>
            <span>{betting ? "Take seat" : "Open seat"}</span>
          </button>
        )}
      </div>

      <footer className="seat-panel-foot">
        {active ? (
          <div className="decision">
            <button className="btn btn-hit" onClick={() => director.act("hit")}>
              Hit <kbd>H</kbd>
            </button>
            <button className="btn btn-stand" onClick={() => director.act("stand")}>
              Stand <kbd>S</kbd>
            </button>
          </div>
        ) : seat.taken ? (
          <button className="bet-spot" onClick={() => director.addChip(id)} disabled={!betting} title={betting ? "Add the selected chip" : undefined}>
            <ChipStack amount={seat.bet} />
            <span className="bet-amount">{money(seat.bet)}</span>
            {betting && <span className="bet-hint">tap to add</span>}
          </button>
        ) : (
          <div className="bet-spot is-empty" />
        )}
      </footer>
    </section>
  );
}

function DealerStrip({ store }: { store: Store }) {
  const dealer = useGame(store, (s) => s.dealer);
  const visible = useGame(store, (s) => s.visible.dealer);
  const phase = useGame(store, (s) => s.phase);
  const shown = dealer.slice(0, visible);
  const hiddenHole = dealer.length >= 2 && visible === 1;
  return (
    <div className="dealer-strip">
      <span className="dealer-strip-label">Dealer</span>
      <div className="dealer-strip-cards">
        {shown.map((c, i) => <PlayingCard key={i} card={c} />)}
        {hiddenHole && <PlayingCard hidden />}
        {!dealer.length && <span className="dealer-strip-empty">{phase === "betting" ? "Stands on all 17s · Blackjack pays 3:2 · 6-card charlie wins" : ""}</span>}
      </div>
      {shown.length > 0 && <span className="seat-total">{label(shown)}</span>}
    </div>
  );
}

function BetBar({ store, director }: { store: Store; director: Director }) {
  const phase = useGame(store, (s) => s.phase);
  const chip = useGame(store, (s) => s.chip);
  const seats = useGame(store, (s) => s.seats);
  const balance = useGame(store, (s) => s.balance);
  const staked = SEATS.reduce((a, k) => a + seats[k].bet, 0);
  const canDeal = phase === "betting" && director.canDeal();
  if (phase !== "betting") return <RoundStatus store={store} />;
  return (
    <div className="betbar">
      <div className="chip-rack" role="radiogroup" aria-label="Chip value">
        {CHIPS.map((v) => (
          <button key={v} className="chip-btn" role="radio" aria-checked={chip === v} onClick={() => director.setChip(v)} disabled={v > balance}>
            <Chip value={v} active={chip === v} />
          </button>
        ))}
      </div>
      <div className="betbar-actions">
        <div className="betbar-total">
          <span>Total bet</span>
          <strong>{money(staked)}</strong>
        </div>
        <button className="btn btn-ghost" onClick={() => director.clearBets()} disabled={!staked}>
          Clear
        </button>
        <button className="btn btn-gold btn-deal" onClick={() => void director.deal()} disabled={!canDeal}>
          Deal <kbd>Space</kbd>
        </button>
      </div>
    </div>
  );
}

function RoundStatus({ store }: { store: Store }) {
  const phase = useGame(store, (s) => s.phase);
  const mode = useGame(store, (s) => s.mode);
  const steps: [string, string][] = [
    ["dealing", "Deal"],
    ["players", "Players"],
    ["dealer", "Dealer"],
    ["settling", "Settle"],
    ["clearing", "Clear"],
  ];
  const idx = steps.findIndex(([k]) => k === phase);
  return (
    <div className="round-status">
      <ol className="round-steps">
        {steps.map(([k, l], i) => (
          <li key={k} className={i < idx ? "is-done" : i === idx ? "is-now" : ""}>{l}</li>
        ))}
      </ol>
      <span className="round-status-note">{DECISION_SECONDS[mode]}s to decide · auto-plays basic strategy on timeout</span>
    </div>
  );
}

export function Dock({ store, director }: { store: Store; director: Director }) {
  return (
    <div className="dock">
      <div className="seat-row">
        {SEATS.map((id) => (
          <SeatPanel key={id} store={store} director={director} id={id} />
        ))}
      </div>
      <DealerStrip store={store} />
      <BetBar store={store} director={director} />
    </div>
  );
}
