import type { Director } from "../director/Director";
import { type Store, useGame } from "../director/store";
import { ENDINGS, ENDING_IDS } from "../ending/types";
import { money, signedMoney } from "./format";

export function OctaneMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 400 400" aria-hidden className="octane-mark">
      <path
        fill="currentColor"
        d="M204 76c1 9 3.4 24.3 3.4 24.3 2.8 19.6 10.8 37.5 22.5 52.2 2.8 3.6 8.1 3.6 11.3.4l45-45 5.7 5.7-45 45c-3.2 3.2-3.1 8.4.4 11.2 14.8 11.8 32.8 19.9 52.5 22.7 0 0 14.7 2.4 24.2 3.4S400 196 400 196v8s-66.4-1-76 0-24.2 3.4-24.2 3.4c-19.7 2.8-37.6 10.8-52.4 22.6-3.5 2.8-3.6 8.1-.4 11.3l44.9 44.9-5.7 5.7-44.9-44.9c-3.2-3.2-8.5-3.1-11.3.4-11.8 14.8-19.8 32.7-22.6 52.4 0 0-2.4 14.7-3.4 24.2S204 400 204 400h-8s1-66.4 0-76-3.4-24.2-3.4-24.2c-2.8-19.7-10.8-37.7-22.7-52.5-2.8-3.5-8.1-3.6-11.3-.4l-45 45-5.6-5.7 45-44.9c3.2-3.2 3.1-8.5-.4-11.3-14.8-11.7-32.7-19.7-52.3-22.5 0 0-14.7-2.4-24.2-3.4S0 204 0 204v-8s66.5 1 76 0 24.3-3.4 24.3-3.4c19.6-2.8 37.6-10.8 52.4-22.6 3.5-2.8 3.6-8.1.4-11.3L108 113.6l5.7-5.7 45 45.1c3.2 3.2 8.5 3.1 11.3-.4 11.8-14.8 19.8-32.7 22.5-52.4 0 0 2.4-14.7 3.4-24.3S196 0 196 0h8s-1 66.4 0 76Z"
      />
    </svg>
  );
}

export function TopBar({ store, director, onToggleDirector, directorOpen }: {
  store: Store;
  director: Director | null;
  onToggleDirector: () => void;
  directorOpen: boolean;
}) {
  const balance = useGame(store, (s) => s.balance);
  const net = useGame(store, (s) => s.lastNet);
  const mode = useGame(store, (s) => s.mode);
  const phase = useGame(store, (s) => s.phase);
  const ending = useGame(store, (s) => s.ending);
  return (
    <header className="topbar">
      <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
        <OctaneMark />
        <span className="brand-name">OCTANE<span className="brand-studios">STUDIOS</span></span>
        <small className="brand-tag">PROTOTYPE</small>
      </a>
      <div className="topbar-title">
        <span className="topbar-eyebrow">Live Dealer</span>
        <h1>Blackjack <em>· Three Seat</em></h1>
      </div>
      <div className="topbar-right">
        <div className="mode-switch ending-switch" role="radiogroup" aria-label="How a round ends (switching starts a new game)">
          {ENDING_IDS.map((e) => (
            <button
              key={e} role="radio" aria-checked={ending === e} className={ending === e ? "is-on" : ""}
              title={`${ENDINGS[e].hint}${ending === e ? "" : " — starts a new game"}`}
              onClick={() => director?.setEnding(e)} disabled={!director}
            >
              {ENDINGS[e].label}
            </button>
          ))}
        </div>
        <div className="mode-switch" role="radiogroup" aria-label="Decision time">
          {(["speed", "regular"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : ""} onClick={() => director?.setMode(m)}>
              {m === "speed" ? "Speed · 7s" : "Regular · 14s"}
            </button>
          ))}
        </div>
        <div className="balance">
          <span className="balance-label">Balance</span>
          <span className="balance-value">{money(balance)}</span>
          {net !== null && phase !== "betting" && <span className={`balance-net ${net >= 0 ? "is-up" : "is-down"}`}>{signedMoney(net)}</span>}
        </div>
        <button className="icon-btn" onClick={() => void director?.resetTable()} title="Reset table (clears seats, balance and shoe)" disabled={!director}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
          <span>Reset</span>
        </button>
        <button className={`icon-btn ${directorOpen ? "is-on" : ""}`} onClick={onToggleDirector} title="Director panel (footage, compositing, scenarios)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 9h18M8 5v4M16 5v4" />
          </svg>
          <span>Director</span>
        </button>
      </div>
    </header>
  );
}
