import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyPalette, getStoredPalette } from "./lib/theme";

// Apply the persisted palette before first paint (mode is applied by ThemeToggle).
// One TooltipProvider for the whole app (desktop and /m) shares the hint delay.
applyPalette(getStoredPalette());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>
);
