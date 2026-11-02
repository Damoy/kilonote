// Écran d'accueil (aucun onglet ouvert) avec Kilo, la mascotte.

import type { App } from "../app";
import { shortcutFor } from "../core/commands";
import { basename } from "../core/path";
import kiloSvg from "../assets/kilo.svg?raw";
import { h, icon } from "./dom";

// {commande} est remplacé par le raccourci actuel de la commande.
const TIPS = [
  "{task.cycle} sur une ligne la transforme en tâche, puis fait tourner son statut.",
  "{task.archive} archive la tâche dans le fichier _done, avec la date du jour.",
  "Clic droit sur un onglet : couleur et groupes d'onglets.",
  "{palette.symbol} pour sauter à un titre ou une tâche de la note.",
  "La palette de commandes ({palette.commands}) donne accès à tout.",
  "Les paramètres ({settings.open}) sont un simple fichier JSON commenté.",
  "Le bilan d'activité résume vos tâches terminées, par projet et par mois.",
  "{file.toggleDone} bascule entre une note et son archive _done.",
];

export function mascot(cls = "kilo"): HTMLElement {
  const wrap = h("div", { class: cls });
  // SVG maison et statique : insertion sûre.
  wrap.innerHTML = kiloSvg.replace(/<rect x="(94|144)" y="94"/g, '<rect class="kilo-eye" x="$1" y="94"');
  return wrap;
}

export class Welcome {
  constructor(private app: App, private el: HTMLElement) {
    app.on("active", () => this.render());
    app.on("workspace", () => this.render());
  }

  render() {
    const app = this.app;
    const visible = !app.active;
    this.el.hidden = !visible;
    document.getElementById("editor-host")!.hidden = visible;
    if (!visible) return;
    const key = (id: string) => shortcutFor(id);
    const action = (label: string, ic: string, id: string, run: () => unknown) =>
      h("button", { class: "wl-action", onclick: run }, icon(ic), h("span", {}, label), h("kbd", {}, key(id)));
    const recent = app.recent.filter((r) => r !== app.workspace).slice(0, 4);
    const tip = TIPS[Math.floor(Date.now() / 86_400_000) % TIPS.length];
    this.el.replaceChildren(
      h(
        "div",
        { class: "wl-inner" },
        mascot("kilo wl-kilo"),
        h("h1", { class: "wl-title" }, "Kilo", h("span", {}, "Note")),
        h("p", { class: "wl-tagline" }, "Des notes légères comme un kilooctet."),
        h(
          "div",
          { class: "wl-actions" },
          action("Nouvelle note", "newFile", "file.new", () => app.newDoc()),
          action(app.workspace ? "Aller au fichier" : "Ouvrir un dossier", app.workspace ? "search" : "folder", app.workspace ? "palette.files" : "folder.open", () =>
            app.workspace ? app.openQuickOpen() : app.openFolder()),
          action("Tâches en cours", "tasks", "view.tasks", () => app.sidebar.show("tasks")),
          action("Commandes", "command", "palette.commands", () => app.openCommandPalette()),
        ),
        recent.length
          ? h("div", { class: "wl-recent" }, h("div", { class: "wl-section" }, "Dossiers récents"),
              ...recent.map((r) => h("button", { class: "wl-recent-item", title: r, onclick: () => app.openFolder(r) }, icon("folder"), h("span", {}, basename(r)), h("small", {}, r))))
          : null,
        h("div", { class: "wl-tip" }, h("strong", {}, "Astuce · "), tip.replace(/\{([\w.]+)\}/g, (_m, id: string) => key(id) || id)),
      ),
    );
  }
}
