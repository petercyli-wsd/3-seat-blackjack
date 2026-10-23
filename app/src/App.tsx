import { useEffect, useRef, useState } from "react";
import type { Director } from "./director/Director";
import { Store, useGame } from "./director/store";
import { bootTable } from "./table";
import { DirectorPanel } from "./ui/DirectorPanel";
import { Dock } from "./ui/Dock";
import { Stage } from "./ui/Stage";
import { OctaneMark, TopBar } from "./ui/TopBar";

const store = new Store();

function Loading() {
  const loading = useGame(store, (s) => s.loading);
  const error = useGame(store, (s) => s.error);
  const pct = loading.total ? Math.round((loading.done / loading.total) * 100) : 0;
  return (
    <div className="loading">
      <OctaneMark size={56} />
      {error ? (
        <>
          <h2>Couldn't open the table</h2>
          <p className="loading-error">{error}</p>
        </>
      ) : (
        <>
          <h2>{loading.label}</h2>
          <div className="loading-bar"><div style={{ width: `${pct}%` }} /></div>
          <p>{loading.total > 1 ? `${loading.done} / ${loading.total} clips` : " "}</p>
        </>
      )}
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [director, setDirector] = useState<Director | null>(null);
  const [panel, setPanel] = useState(false);
  const phase = useGame(store, (s) => s.phase);

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    bootTable(canvasRef.current!, hostRef.current!, store)
      .then((t) => {
        if (disposed) return t.dispose();
        dispose = t.dispose;
        setDirector(t.director);
      })
      .catch((e: unknown) => {
        console.error(e);
        store.set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!director) return;
    const onKey = (e: KeyboardEvent) => {
      // a held key would otherwise land a second hit the moment the next decision opens
      if (e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (k === "h") director.act("hit");
      else if (k === "s") director.act("stand");
      else if (k === " " || k === "enter") {
        e.preventDefault();
        void director.deal();
      } else if (k === "1" || k === "2" || k === "3") director.toggleSeat(`seat${k}` as "seat1");
      else if (k === "c") director.clearBets();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [director]);

  const loading = phase === "loading" || phase === "error";
  return (
    <div className={`app ${panel ? "with-panel" : ""}`}>
      <TopBar store={store} director={director} directorOpen={panel} onToggleDirector={() => setPanel((p) => !p)} />
      <main className="main">
        <div className="table-col">
          <Stage store={store} canvasRef={canvasRef} hostRef={hostRef} />
          {director && !loading && <Dock store={store} director={director} />}
        </div>
        {panel && director && <DirectorPanel store={store} director={director} />}
      </main>
      {loading && <Loading />}
    </div>
  );
}
