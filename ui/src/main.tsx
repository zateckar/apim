import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./portal/portal.css";
import "./portal/brand.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
