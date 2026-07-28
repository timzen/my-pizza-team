import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyPalette, getStoredPalette } from "./lib/theme";

// Apply the persisted palette before first paint (mode is applied by ThemeToggle).
applyPalette(getStoredPalette());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
