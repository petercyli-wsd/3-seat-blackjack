import type { Director } from "../director/Director";
import { SCENARIOS } from "../director/scenarios";
import { type Store, useGame } from "../director/store";
import { RANK_LABEL, SUIT_GLYPH, isRed, rankOf, suitOf, type Card } from "../engine/cards";
import { label } from "../engine/rules";
import { OUTCOME_LABEL, seatNo, signedMoney } from "./format";

const mini = (c: Card, i: number) => (
  <span key={i} className={`mini ${isRed(c) ? "is-red" : ""}`}>
    {RANK_LABEL[rankOf(c)]}
    {SUIT_GLYPH[suitOf(c)]}
  </span>
);

export function DirectorPanel({ store, director }: { store: Store; director: Director }) {
  const d = useGame(store, (s) => s.debug);
  const scenario = useGame(store, (s) => s.scenario);
  const showMasks = useGame(store, (s) => s.showMasks);
  const history = useGame(store, (s) => s.history);
  return (
    <aside className="director">
      <section>
        <h3>Now playing</h3>
        <div className="dp-clip">
          <code>{d.clip}</code>
          <span className={`dp-kind kind-${d.kind}`}>{d.kind}{d.loop ? " · loop" : ""}</span>
        </div>
        <div className="dp-progress">
          <div style={{ width: `${d.frames ? ((d.frame + 1) / d.frames) * 100 : 0}%` }} />
        </div>
        <dl className="dp-stats">
          <dt>Frame</dt><dd>{d.frame + 1} / {d.frames}</dd>
          <dt>Handoff gap</dt><dd>{d.handoffGap} fr</dd>
          <dt>Bridges</dt><dd>{d.bridges.tool} generated · {d.bridges.flow} stand-in{d.bridges.rejected ? ` (${d.bridges.rejected} rejected)` : ""}</dd>
          <dt>Crossfade</dt><dd>{d.fade < 1 ? `${Math.round(d.fade * 100)}%` : "—"}</dd>
          <dt>Shoe</dt><dd>{d.shoeRemaining} cards · shoe {d.shuffles}</dd>
        </dl>
      </section>
      <section>
        <h3>Seat plates</h3>
        <p className="dp-note">
          Where the footage shows a different hand than the game, that seat is replaced with a plate grabbed from the take, keyed so the dealer's arm stays in front.
        </p>
        <div className="dp-plates">
          {(["seat1", "seat2", "seat3"] as const).map((k) => (
            <div key={k} className={`dp-plate ${d.plates[k] !== null ? "is-on" : ""}`}>
              <span>Seat {seatNo(k)}</span>
              <strong>{d.plates[k] === null ? "footage" : `plate · ${d.plates[k]} cards`}</strong>
            </div>
          ))}
        </div>
        <label className="dp-check">
          <input type="checkbox" checked={showMasks} onChange={(e) => store.set({ showMasks: e.target.checked })} />
          Show compositing masks
        </label>
      </section>
      <section>
        <h3>Next shoe</h3>
        <select value={scenario} onChange={(e) => director.setScenario(e.target.value)} className="dp-select">
          {Object.entries(SCENARIOS).map(([k, s]) => (
            <option key={k} value={k}>{s.label}</option>
          ))}
        </select>
        <p className="dp-note">{SCENARIOS[scenario]?.hint}. Applies from the next deal.</p>
      </section>
      <section>
        <h3>Rounds</h3>
        <ol className="dp-history">
          {history.map((r) => (
            <li key={r.no}>
              <div className="dp-history-head">
                <span>#{r.no} · <code>{r.mask}</code></span>
                <b className={r.net >= 0 ? "is-up" : "is-down"}>{signedMoney(r.net)}</b>
              </div>
              <div className="dp-history-row"><span>D</span>{r.dealer.map(mini)}<em>{label(r.dealer)}</em></div>
              {r.seats.map((s) => (
                <div key={s.seat} className="dp-history-row">
                  <span>{seatNo(s.seat)}</span>{s.cards.map(mini)}<em>{label(s.cards)}</em>
                  <i className={`outcome-${s.result.outcome}`}>{OUTCOME_LABEL[s.result.outcome]}</i>
                </div>
              ))}
            </li>
          ))}
          {!history.length && <li className="dp-note">No rounds yet.</li>}
        </ol>
      </section>
      <section>
        <h3>Log</h3>
        <ol className="dp-log">
          {d.log.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      </section>
    </aside>
  );
}
