import { type Store, useGame } from "../director/store";
import { CollectOverlay } from "./CollectOverlay";
import { FadeOverlay } from "./FadeOverlay";
import { PanelOverlay } from "./PanelOverlay";

/** The DOM part of the round's ending, over the stage: each style's own (most draw nothing). */
export function EndingOverlay({ store }: { store: Store }) {
  const ending = useGame(store, (s) => s.ending);
  if (ending === "fade") return <FadeOverlay store={store} />;
  if (ending === "panel" || ending === "board") return <PanelOverlay store={store} variant={ending} />;
  if (ending === "collect") return <CollectOverlay store={store} />;
  return null;
}
