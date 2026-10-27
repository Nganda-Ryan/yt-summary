import { createRoot, type Root } from "react-dom/client";
import Panel from "./Panel";
import css from "./panel.css?inline";

const HOST_ID = "ytp-panel-host";
let root: Root | null = null;

/**
 * Conteneur flottant à droite de la page. Le Shadow DOM isole nos styles
 * de ceux de YouTube (et réciproquement).
 */
function mount() {
  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) return;

  existing?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;top:70px;right:16px;width:360px;z-index:9999";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const container = document.createElement("div");
  shadow.append(style, container);

  root = createRoot(container);
  root.render(<Panel />);
}

if (document.body) {
  mount();
} else {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
}

/* YouTube est une SPA : on remonte le panneau si YouTube purged le body. */
document.addEventListener("yt-navigate-finish", () => {
  if (!document.getElementById(HOST_ID)?.shadowRoot) mount();
});
