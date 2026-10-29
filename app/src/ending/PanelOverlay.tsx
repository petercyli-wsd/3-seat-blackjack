import { type CSSProperties, useEffect, useState } from "react";
import { type RoundRecord, type Store, useGame } from "../director/store";
import { type Card, RANK_LABEL, SUIT_GLYPH, isRed, rankOf, suitOf } from "../engine/cards";
import { isBlackjack, total } from "../engine/rules";
import { DEALER_CROP, type Rect } from "../render/stageArt";
import { OUTCOME_LABEL, money, seatNo, signedMoney } from "../ui/format";
import { PANEL } from "./panel";

type Variant = "panel" | "board";

/**
 * Where it goes, in source pixels of the 1440x810 take. It is at least this big in either framing,
 * and sized to its content past that (see the CSS), centred on it or growing from its left edge.
 *
 * panel: over every card on the table (the dealer's two and her graphic draws in front of them,
 * the seats' hands), its top at the cloth's back edge so that the dealer is seen from the waist up.
 *
 * board: over the filmed discard, as tight as covers everything that fades in it (from the
 * manifest's discard clips): the dealer's two cards and her draws' row (y 373-411), the seats'
 * hands with their hit fans (x 641-914, y 427-537), and the faces riding on the cards she gathers
 * between them (her pile carries the up card's face out to seat 1, x 613). Its left edge stays
 * well right of the discard holder (x 483-526, y 333-404), so her hand is seen coming out from
 * behind it to drop the cards in, and her arms above it as she reaches over the table.
 */
const PLACE: Record<Variant, { cover: Rect; from: "centre" | "left" }> = {
  panel: { cover: [598, 346, 368, 208], from: "centre" },
  board: { cover: [590, 364, 340, 186], from: "left" },
};
const FULL: Rect = [0, 0, 1440, 810];

type Stage = "up" | "leaving" | "after";
interface Shown {
  record: RoundRecord;
  balance: number;
  stage: Stage;
}

/**
 * The "Results" ending: the round's results on a panel that rises over the table's cards while
 * the table is cleared under it (panel.ts) and the footage cuts back to the betting loop; it
 * leaves once betting reopens. "Results & discard" (variant "board"): the same, over the filmed
 * discard. Its root also tells the stage (index.css, "ending: results panel") to keep the seats'
 * own result badges and the toast out of the way while it says it all.
 */
export function PanelOverlay({ store, variant }: { store: Store; variant: Variant }) {
  const clearing = useGame(store, (s) => s.clearing);
  const framing = useGame(store, (s) => s.framing);
  const [shown, setShown] = useState<Shown | null>(null);
  const [seen, setSeen] = useState(clearing);
  // up with the clear (the round as it was settled), out once it is over; adjusted while
  // rendering, so the panel mounts in the same frame the clear starts
  if (clearing !== seen) {
    setSeen(clearing);
    const s = store.get();
    const record = s.history[0];
    if (clearing?.style === variant && record?.no === s.round) setShown({ record, balance: s.balance, stage: "up" });
    else if (!clearing && shown?.stage === "up") setShown({ ...shown, stage: "leaving" });
  }
  const stage = shown?.stage;
  useEffect(() => {
    if (stage !== "leaving" && stage !== "after") return;
    const id = setTimeout(
      () => setShown((cur) => (cur?.stage === "leaving" ? { ...cur, stage: "after" } : cur?.stage === "after" ? null : cur)),
      stage === "leaving" ? PANEL.exitMs : PANEL.handoverMs - PANEL.exitMs,
    );
    return () => clearTimeout(id);
  }, [stage]);

  const [cx, cy, cw, ch] = framing === "dealer" ? DEALER_CROP : FULL;
  const { cover: [x, y, w, h], from } = PLACE[variant];
  const place = {
    left: `${((x + (from === "centre" ? w / 2 : 0) - cx) / cw) * 100}%`,
    top: `${((y - cy) / ch) * 100}%`,
    "--cover-w": `${(w / cw) * 100}%`,
    minHeight: `${(h / ch) * 100}%`,
  } as CSSProperties;
  const clock = { "--rise": `${PANEL.riseMs}ms`, "--exit": `${PANEL.exitMs}ms` } as CSSProperties;

  return (
    <div className={`ending-panel-root is-${variant} ${stage ? `is-${stage}` : ""}`} style={clock}>
      {shown && shown.stage !== "after" && (
        <>
          <div className="ending-panel-scrim" />
          <ResultsPanel record={shown.record} balance={shown.balance} style={place} />
        </>
      )}
    </div>
  );
}

function ResultsPanel({ record, balance, style }: { record: RoundRecord; balance: number; style: CSSProperties }) {
  const seats = [...record.seats].sort((a, b) => a.seat.localeCompare(b.seat));
  const d = total(record.dealer).best;
  const dealer = isBlackjack(record.dealer)
    ? { text: "Blackjack", tone: "is-gold" }
    : d > 21 ? { text: `Bust ${d}`, tone: "is-bust" } : { text: String(d), tone: "" };
  const net = record.net;
  const item = (i: number) => ({ "--i": i }) as CSSProperties;
  return (
    <section className="ending-panel" style={style} aria-label={`Round ${record.no} results`}>
      <header className="ending-panel-dealer" style={item(0)}>
        <span className="ending-panel-label">Dealer</span>
        <Hand cards={record.dealer} fan={8} />
        <span className={`ending-panel-dealer-total ${dealer.tone}`}>{dealer.text}</span>
      </header>
      <div className="ending-panel-seats">
        {seats.map(({ seat, cards, bet, result }, i) => {
          const back = result.payout - bet;
          return (
            <div key={seat} className={`ending-panel-seat is-${result.outcome}`} style={item(i + 1)}>
              <div className="ending-panel-seat-head">
                <span className="ending-panel-seat-no">{seatNo(seat)}</span>
                <span className="ending-panel-seat-total">{isBlackjack(cards) ? "BJ" : total(cards).best}</span>
              </div>
              <Hand cards={cards} fan={5} />
              <span className="ending-panel-outcome">{OUTCOME_LABEL[result.outcome]}</span>
              <span className="ending-panel-amount">{result.outcome === "push" ? `${money(bet)} back` : signedMoney(back)}</span>
            </div>
          );
        })}
      </div>
      <footer className="ending-panel-foot" style={item(seats.length + 1)}>
        <span className={`ending-panel-net ${net > 0 ? "is-up" : net < 0 ? "is-down" : ""}`}>
          <span className="ending-panel-label">{net > 0 ? "You win" : "Net"}</span>
          <strong>{net > 0 ? money(net) : net < 0 ? signedMoney(net) : "Even"}</strong>
        </span>
        <span className="ending-panel-balance">
          <span className="ending-panel-label">Balance</span>
          <strong>{money(balance)}</strong>
        </span>
      </footer>
    </section>
  );
}

/** A hand as small cards, overlapping from `fan` cards on (rank corners still showing). */
function Hand({ cards, fan }: { cards: Card[]; fan: number }) {
  return (
    <span className={`ending-panel-cards ${cards.length >= fan ? "is-fanned" : ""}`}>
      {cards.map((c, i) => (
        <span key={i} className={`ending-panel-card ${isRed(c) ? "is-red" : ""}`} aria-label={`${RANK_LABEL[rankOf(c)]}${SUIT_GLYPH[suitOf(c)]}`}>
          <b>{RANK_LABEL[rankOf(c)]}</b>
          <i>{SUIT_GLYPH[suitOf(c)]}</i>
        </span>
      ))}
    </span>
  );
}
