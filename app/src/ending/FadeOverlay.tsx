import { useLayoutEffect, useRef } from "react";
import { type Store, useGame } from "../director/store";
import type { SeatId } from "../media/manifest";
import type { Hand } from "./eraser";
import { FADE_ORDER, HAND_MS, fade, fadeStarts } from "./fade";

const SEATS: SeatId[] = ["seat1", "seat2", "seat3"];
/** The result toast is gone by the time the cards start to go: the phase flip drops its net. */
const TOAST_OUT_MS = 450;

/**
 * Draws nothing itself: it marks the stage (`.ending-fade`, its phase) and gives it the clear's
 * timings as CSS variables, so the HUD over each hand (index.css, ending-fade block) goes with
 * that hand's cards on the canvas: the result toast dims at the end of the read, each seat's
 * badge and total and the dealer's marker fade as their cards do, and "Place your bets" arrives
 * once the table is bare.
 */
export function FadeOverlay({ store }: { store: Store }) {
  const ref = useRef<HTMLDivElement>(null);
  const phase = useGame(store, (s) => s.phase);
  // the hands as the round left them (the store keeps them until betting reopens); primitives, so
  // the selector is stable
  const present = useGame(store, (s) => FADE_ORDER.filter((h) => (h === "dealer" ? s.dealer : s.seats[h].cards).length > 0).join());
  const taken = useGame(store, (s) => SEATS.filter((k) => s.seats[k].taken).join());

  useLayoutEffect(() => {
    const stage = ref.current?.parentElement;
    if (!stage) return;
    const starts = fadeStarts(present.split(",") as Hand[]);
    const vars: Record<string, string> = {
      "--ending-fade-read": `${fade.timing.readMs}ms`,
      "--ending-fade-toast": `${TOAST_OUT_MS}ms`,
      "--ending-fade-hand": `${HAND_MS}ms`,
      "--ending-fade-dealer": `${starts.dealer ?? 0}ms`,
    };
    // a seat marker is drawn for each taken seat, in seat order: the nth is matched by
    // :nth-child(n of .seat-marker)
    (taken ? (taken.split(",") as SeatId[]) : []).forEach((k, i) => (vars[`--ending-fade-m${i + 1}`] = `${starts[k] ?? 0}ms`));
    for (const [k, v] of Object.entries(vars)) stage.style.setProperty(k, v);
    return () => Object.keys(vars).forEach((k) => stage.style.removeProperty(k));
  }, [present, taken]);

  // Each badge and total folds away as it fades (so the pill is already at its betting size and
  // place when they are taken off): CSS can't animate to or from auto, so it is given their
  // sizes, measured while the results are read (offset sizes ignore the badges' pop transform).
  useLayoutEffect(() => {
    if (phase !== "settling") return;
    ref.current?.parentElement?.querySelectorAll<HTMLElement>(".seat-result, .seat-pill-total").forEach((el) => {
      el.style.setProperty("--ending-fade-w", `${el.offsetWidth}px`);
      el.style.setProperty("--ending-fade-h", `${el.offsetHeight}px`);
    });
  }, [phase]);

  const state = phase === "settling" ? "is-read" : phase === "clearing" ? "is-clearing" : "";
  return <div ref={ref} className={`ending-fade ${state}`} aria-hidden />;
}
