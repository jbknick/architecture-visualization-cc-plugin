import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { StoreProvider } from "./store.tsx";
import { applyKindVariables, currentScheme } from "./theme.ts";
import "./styles.css";
import "./views/views.css";
import "./views/duplicates.css";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => applyKindVariables(document.documentElement, currentScheme());
applyScheme();
media.addEventListener("change", applyScheme);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
