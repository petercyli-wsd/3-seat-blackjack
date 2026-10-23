import { type Card, RANK_LABEL, SUIT_GLYPH, isRed, rankOf, suitOf } from "../engine/cards";

export function PlayingCard({ card, hidden, delay = 0 }: { card?: Card; hidden?: boolean; delay?: number }) {
  if (!card || hidden) {
    return (
      <div className="pc pc-back" style={{ animationDelay: `${delay}ms` }}>
        <svg viewBox="0 0 40 56" aria-hidden>
          <rect x="3" y="3" width="34" height="50" rx="3" fill="none" stroke="var(--gold)" strokeWidth="0.8" opacity="0.7" />
          <path d="M20 14 L22 26 L34 28 L22 30 L20 42 L18 30 L6 28 L18 26 Z" fill="var(--gold)" opacity="0.85" />
        </svg>
      </div>
    );
  }
  const red = isRed(card);
  const label = RANK_LABEL[rankOf(card)];
  const glyph = SUIT_GLYPH[suitOf(card)];
  return (
    <div className={`pc ${red ? "pc-red" : "pc-black"}`} style={{ animationDelay: `${delay}ms` }} aria-label={`${label}${glyph}`}>
      <span className="pc-rank">{label}</span>
      <span className="pc-suit">{glyph}</span>
      <span className="pc-pip">{glyph}</span>
    </div>
  );
}

const CHIP_COLOURS: Record<number, [string, string]> = {
  1: ["#e9e4d8", "#9a927f"],
  5: ["#c3122f", "#f3d7dc"],
  10: ["#1f5fbf", "#d8e4f7"],
  25: ["#1d7a4c", "#d6efe2"],
  100: ["#141414", "#d4af37"],
  500: ["#5b2a86", "#e6d6f4"],
};

export const CHIPS = [1, 5, 10, 25, 100, 500];

export function Chip({ value, size = 44, active }: { value: number; size?: number; active?: boolean }) {
  const [base, accent] = CHIP_COLOURS[value] ?? CHIP_COLOURS[100];
  return (
    <svg className={`chip ${active ? "chip-active" : ""}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r="23" fill={base} />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="21" y="1.5" width="6" height="8" rx="1.2" fill={accent} transform={`rotate(${i * 45} 24 24)`} />
      ))}
      <circle cx="24" cy="24" r="15.5" fill={base} stroke={accent} strokeWidth="1.2" strokeDasharray="2 2.2" />
      <text x="24" y="28.5" textAnchor="middle" fontSize={value >= 100 ? 11 : 13} fontWeight="800" fill={accent} fontFamily="Inter, sans-serif">
        {value}
      </text>
    </svg>
  );
}

/** A stack summarising a bet, highest denominations on top. */
export function ChipStack({ amount, max = 5 }: { amount: number; max?: number }) {
  const chips: number[] = [];
  let left = amount;
  for (const v of [...CHIPS].reverse()) {
    while (left >= v && chips.length < max) {
      chips.push(v);
      left -= v;
    }
  }
  return (
    <div className="chip-stack">
      {chips.reverse().map((v, i) => (
        <div key={i} className="chip-stack-item" style={{ bottom: i * 4, zIndex: i }}>
          <Chip value={v} size={30} />
        </div>
      ))}
    </div>
  );
}
