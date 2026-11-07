// Welcome screen (no open tab), featuring Kilo the mascot.

import type { App } from "../app/app";
import { shortcutFor } from "../core/commands";
import { basename } from "../core/path";
import kiloSvg from "../assets/kilo.svg?raw";
import { h, icon } from "./dom";
import { openCommandPalette, openQuickOpen } from "../app/pickers";

// {command} is replaced with the command's current shortcut.
const TIPS = [
  "{task.cycle} turns a line into a task, then cycles its status.",
  "{task.archive} moves the task to the _done file, stamped with today's date.",
  "Right-click a tab for colors and tab groups.",
  "{palette.symbol} jumps to a heading or a task of the note.",
  "The command palette ({palette.commands}) gives access to everything.",
  "Settings ({settings.open}): every option, also kept in a plain, commented JSON file.",
  "The activity report sums up your completed tasks by project and by month.",
  "{file.toggleDone} switches between a note and its _done archive.",
];

export function mascot(cls = "kilo"): HTMLElement {
  const wrap = h("div", { class: cls });
  // Static, home-made pixel art SVG (scripts/generate-icons.py): safe to insert.
  wrap.innerHTML = kiloSvg;
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
    (document.getElementById("editor-area") ?? document.getElementById("editor-host")!).hidden = visible;
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
        h("p", { class: "wl-tagline" }, "Notes as light as a kilobyte."),
        h(
          "div",
          { class: "wl-actions" },
          action("New note", "newFile", "file.new", () => app.newDoc()),
          action(app.workspace ? "Go to file" : "Open folder", app.workspace ? "search" : "folder", app.workspace ? "palette.files" : "folder.open", () =>
            app.workspace ? openQuickOpen(app) : app.openFolder()),
          action("Ongoing tasks", "tasks", "view.tasks", () => app.sidebar.show("tasks")),
          action("Commands", "command", "palette.commands", () => openCommandPalette(app)),
        ),
        recent.length
          ? h("div", { class: "wl-recent" }, h("div", { class: "wl-section" }, "Recent folders"),
              ...recent.map((r) => h("button", { class: "wl-recent-item", title: r, onclick: () => app.openFolder(r) }, icon("folder"), h("span", {}, basename(r)), h("small", {}, r))))
          : null,
        h("div", { class: "wl-tip" }, h("strong", {}, "Tip · "), tip.replace(/\{([\w.]+)\}/g, (_m, id: string) => key(id) || id)),
      ),
    );
  }
}
