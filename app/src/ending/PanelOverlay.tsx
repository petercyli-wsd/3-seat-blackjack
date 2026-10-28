import { type Store, useGame } from "../director/store";

/** STUB: a plain cover over the table while it clears. The real panel is built in its own task. */
export function PanelOverlay({ store }: { store: Store }) {
  const clearing = useGame(store, (s) => s.clearing);
  if (!clearing) return null;
  return <div className="ending-panel-stub">Round results</div>;
}
