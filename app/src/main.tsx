import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// No StrictMode: the table is a long-lived imperative engine (video decks, GL context)
// that must boot exactly once.
createRoot(document.getElementById("root")!).render(<App />);
