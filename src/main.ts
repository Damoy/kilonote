import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";
import { App } from "./app";
import { createTauriBackend, createWebBackend, isTauri } from "./core/backend";
import { handleKeydown } from "./core/commands";

async function main() {
  const backend = isTauri() ? await createTauriBackend() : createWebBackend();
  document.documentElement.dataset.backend = backend.kind;
  const app = new App(backend);
  (window as unknown as { kilonote: App }).kilonote = app;
  // Raccourcis globaux, avant ceux de l'éditeur (phase de capture).
  window.addEventListener("keydown", (e) => {
    if (handleKeydown(e)) return;
    // Pas de rechargement accidentel de la fenêtre dans l'application.
    if (backend.kind === "tauri" && !import.meta.env.DEV && (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))) {
      e.preventDefault();
    }
  }, true);
  // Ctrl+molette : taille du texte de l'éditeur (et pas zoom de toute l'interface).
  let lastWheel = 0;
  window.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || backend.kind !== "tauri") return;
    e.preventDefault();
    if (Date.now() - lastWheel < 60) return;
    lastWheel = Date.now();
    app.zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  // Pas de menu contextuel du navigateur en dehors des zones de texte.
  window.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".cm-content, input, textarea")) e.preventDefault();
  });
  try {
    await app.init();
  } finally {
    document.body.classList.add("ready");
    await backend.show().catch(() => {});
  }
}

void main();
