// Welcome screen (no open tab), featuring Kilo the mascot.

import type { App } from "../app/app";
import { shortcutFor } from "../core/commands";
import { basename, dirname, isInside, samePath } from "../core/path";
import { forgetRecent, pinnedNotes, recentNotes } from "../app/pins";
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

/** A path shown right-aligned (cut on its left): marks keep "/notes" from showing as "notes/". */
const ltr = (path: string) => `\u200e${path}\u200e`;

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
    app.on("pins", () => this.render());
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
    // The pinned notes, then the ones opened lately (outside the settings folder).
    const pins = pinnedNotes();
    const lately = recentNotes().filter((p) => !pins.some((q) => samePath(p, q)) && !isInside(p, app.configDir));
    const notes = [...pins.map((p) => ({ p, ic: "pin" })), ...lately.map((p) => ({ p, ic: "file" }))].slice(0, 6);
    const openNote = (p: string) => void app.openFile(p).then((d) => d || forgetRecent(p));
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
        notes.length
          ? h("div", { class: "wl-recent" }, h("div", { class: "wl-section" }, pins.length ? "Pinned and recent notes" : "Recent notes"),
              ...notes.map(({ p, ic }) => h("button", { class: "wl-recent-item", title: p, onclick: () => openNote(p) }, icon(ic), h("span", {}, basename(p)), h("small", {}, ltr(dirname(p))))))
          : null,
        recent.length
          ? h("div", { class: "wl-recent" }, h("div", { class: "wl-section" }, "Recent folders"),
              ...recent.map((r) => h("button", { class: "wl-recent-item", title: r, onclick: () => app.openFolder(r) }, icon("folder"), h("span", {}, basename(r)), h("small", {}, ltr(r)))))
          : null,
        h("div", { class: "wl-tip" }, h("strong", {}, "Tip · "), tip.replace(/\{([\w.]+)\}/g, (_m, id: string) => key(id) || id)),
      ),
    );
  }
}
