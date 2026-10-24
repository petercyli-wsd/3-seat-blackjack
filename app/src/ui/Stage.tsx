import { useEffect, useState } from "react";
import { type Store, useGame } from "../director/store";
import { label } from "../engine/rules";
import type { SeatId } from "../media/manifest";
import { OUTCOME_LABEL, STATUS_LABEL, seatNo, signedMoney } from "./format";

const W = 1440;
const H = 810;
/** Where each seat's HUD sits on the frame (source pixels), just in front of its cards. */
const SEAT_ANCHOR: Record<SeatId, [number, number]> = {
  seat1: [684, 572],
  seat2: [792, 584],
  seat3: [890, 572],
};
const DEALER_ANCHOR: [number, number] = [761, 352];

const at = ([x, y]: [number, number]) => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` });

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

function SeatMarker({ store, id }: { store: Store; id: SeatId }) {
  const seat = useGame(store, (s) => s.seats[id]);
  const visible = useGame(store, (s) => s.visible[id]);
  const decision = useGame(store, (s) => (s.decision?.seat === id ? s.decision : null));
  const phase = useGame(store, (s) => s.phase);
  const now = useNow(!!decision);
  if (!seat.taken) return null;
  const shown = seat.cards.slice(0, visible);
  const total = label(shown);
  const status = seat.status;
  const frac = decision ? Math.max(0, (decision.deadline - now) / (decision.deadline - decision.startedAt)) : 0;
  const r = 27;
  const circ = 2 * Math.PI * r;
  const result = phase === "settling" || phase === "clearing" ? seat.result : null;
  return (
    <div className={`seat-marker status-${status} ${decision ? "is-acting" : ""}`} style={at(SEAT_ANCHOR[id])}>
      {decision && (
        <svg className="seat-timer" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={r} className="seat-timer-track" />
          <circle
            cx="32" cy="32" r={r}
            className={`seat-timer-arc ${frac < 0.3 ? "is-low" : ""}`}
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - frac)}
          />
        </svg>
      )}
      <div className="seat-pill">
        <span className="seat-pill-no">{seatNo(id)}</span>
        {total && <span className="seat-pill-total">{total}</span>}
      </div>
      {STATUS_LABEL[status] && !result && status !== "acting" && <div className="seat-flag">{STATUS_LABEL[status]}</div>}
      {result && (
        <div className={`seat-result outcome-${result.outcome}`}>
          <span>{OUTCOME_LABEL[result.outcome]}</span>
          {result.payout > 0 && result.outcome !== "push" && <strong>{signedMoney(result.payout - seat.bet)}</strong>}
        </div>
      )}
    </div>
  );
}

function DealerMarker({ store }: { store: Store }) {
  const dealer = useGame(store, (s) => s.dealer);
  const visible = useGame(store, (s) => s.visible.dealer);
  if (!dealer.length || !visible) return null;
  const total = label(dealer.slice(0, visible));
  return (
    <div className="dealer-marker" style={at(DEALER_ANCHOR)}>
      <span className="dealer-marker-label">Dealer</span>
      <span className="dealer-marker-total">{total}</span>
    </div>
  );
}

/** Most footage loads after the table opens; say so while it does, or if it fails. */
function FootageStatus({ store }: { store: Store }) {
  const footage = useGame(store, (s) => s.footage);
  const error = useGame(store, (s) => s.error);
  if (error) return <span className="stage-live-load is-error" title={error}>Footage error — reload</span>;
  if (!footage.total || footage.done >= footage.total) return null;
  return <span className="stage-live-load">Loading footage {Math.round((footage.done / footage.total) * 100)}%</span>;
}

function Toast({ store }: { store: Store }) {
  const message = useGame(store, (s) => s.message);
  const phase = useGame(store, (s) => s.phase);
  const net = useGame(store, (s) => s.lastNet);
  if (!message) return null;
  return (
    <div key={message} className={`stage-toast phase-${phase}`}>
      <span className="stage-toast-text">{message}</span>
      {phase === "settling" && net !== null && (
        <span className={`stage-toast-net ${net > 0 ? "is-up" : net < 0 ? "is-down" : ""}`}>{net === 0 ? "Even" : signedMoney(net)}</span>
      )}
    </div>
  );
}

export function Stage({ store, canvasRef, hostRef }: {
  store: Store;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const phase = useGame(store, (s) => s.phase);
  const round = useGame(store, (s) => s.round);
  return (
    <div className="stage">
      <div className="stage-frame">
        <canvas ref={canvasRef} className="stage-canvas" />
        <div ref={hostRef} className="stage-decks" aria-hidden />
        <div className="stage-overlay">
          <div className="stage-live">
            <span className="live-dot" /> LIVE
            <span className="stage-live-sep" />
            <span className="stage-live-table">Blackjack · 3 Seat</span>
            {round > 0 && <span className="stage-live-round">Round {round}</span>}
            <FootageStatus store={store} />
          </div>
          <DealerMarker store={store} />
          {(["seat1", "seat2", "seat3"] as SeatId[]).map((id) => (
            <SeatMarker key={id} store={store} id={id} />
          ))}
          {phase !== "loading" && <Toast store={store} />}
        </div>
      </div>
    </div>
  );
}
