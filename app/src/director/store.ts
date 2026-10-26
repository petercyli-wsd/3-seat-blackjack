import { useSyncExternalStore } from "react";
import type { Card } from "../engine/cards";
import type { Settlement } from "../engine/settle";
import type { SeatId } from "../media/manifest";

export type Phase = "loading" | "error" | "betting" | "dealing" | "players" | "dealer" | "settling" | "clearing";
export type SeatStatus = "empty" | "seated" | "waiting" | "acting" | "stood" | "bust" | "blackjack" | "charlie" | "twentyone";
export type Mode = "speed" | "regular";

export interface SeatState {
  taken: boolean;
  bet: number;
  cards: Card[];
  status: SeatStatus;
  result: Settlement | null;
}

export interface RoundRecord {
  no: number;
  mask: string;
  dealer: Card[];
  seats: { seat: SeatId; cards: Card[]; bet: number; result: Settlement }[];
  net: number;
}

export interface DebugInfo {
  clip: string;
  kind: string;
  frame: number;
  frames: number;
  loop: boolean;
  plates: Record<SeatId, number | null>;
  handoffGap: number;
  /** Interpolated bridges between clips: from the generation tool, and optical-flow stand-ins. */
  bridges: { tool: number; flow: number; cut: number; rejected: number };
  fade: number;
  shoeRemaining: number;
  shuffles: number;
  log: string[];
}

export interface GameState {
  phase: Phase;
  loading: { label: string; done: number; total: number };
  /** Footage files in memory, of all the table plays (most load after it opens). */
  footage: { done: number; total: number };
  error: string | null;
  seats: Record<SeatId, SeatState>;
  dealer: Card[];
  visible: Record<SeatId | "dealer", number>;
  activeSeat: SeatId | null;
  decision: { seat: SeatId; startedAt: number; deadline: number } | null;
  balance: number;
  chip: number;
  mode: Mode;
  message: string;
  round: number;
  lastNet: number | null;
  history: RoundRecord[];
  debug: DebugInfo;
  showMasks: boolean;
  scenario: string;
}

const seat = (): SeatState => ({ taken: false, bet: 0, cards: [], status: "empty", result: null });

export const initialState = (): GameState => ({
  phase: "loading",
  loading: { label: "Loading table", done: 0, total: 1 },
  footage: { done: 0, total: 0 },
  error: null,
  seats: { seat1: seat(), seat2: seat(), seat3: seat() },
  dealer: [],
  visible: { seat1: 0, seat2: 0, seat3: 0, dealer: 0 },
  activeSeat: null,
  decision: null,
  balance: 1000,
  chip: 10,
  mode: "speed",
  message: "",
  round: 0,
  lastNet: null,
  history: [],
  debug: {
    clip: "", kind: "", frame: 0, frames: 0, loop: false,
    plates: { seat1: null, seat2: null, seat3: null },
    handoffGap: 0, bridges: { tool: 0, flow: 0, cut: 0, rejected: 0 }, fade: 1, shoeRemaining: 0, shuffles: 0, log: [],
  },
  showMasks: false,
  scenario: "random",
});

export class Store {
  private state = initialState();
  private listeners = new Set<() => void>();

  get = () => this.state;

  set(patch: Partial<GameState> | ((s: GameState) => Partial<GameState>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  setSeat(id: SeatId, patch: Partial<SeatState>) {
    this.set((s) => ({ seats: { ...s.seats, [id]: { ...s.seats[id], ...patch } } }));
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export function useGame<T>(store: Store, select: (s: GameState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
