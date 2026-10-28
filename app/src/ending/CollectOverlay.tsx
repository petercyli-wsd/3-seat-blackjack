import { type Store, useGame } from "../director/store";

/**
 * The collect is drawn in the composite (collect.ts). Over the stage it only marks the clear, so
 * the seats' result badges and the dealer's total step back as the cards are gathered up (index.css,
 * .ending-collect): the results stay while the hands turn over, and are gone as the pile leaves.
 */
export function CollectOverlay({ store }: { store: Store }) {
  const clearing = useGame(store, (s) => s.phase === "clearing" && s.clearing?.style === "collect");
  return clearing ? <div className="ending-collect" aria-hidden /> : null;
}
