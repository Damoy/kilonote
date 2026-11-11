// Keyboard shortcuts cheat sheet: shown at startup (until turned off) and from
// the status bar keyboard button, Help: Keyboard shortcuts, or Ctrl+?.
// The shortcuts are read from the current keybindings, so custom ones show up.

import type { App } from "../app/app";
import { formatCombo, onBeforeCommand, shortcutFor } from "../core/commands";
import { h, icon } from "./dom";
import { openSettingsView } from "./lazy";
import { mascot } from "./welcome";

type Row = [label: string, keys: string];

let open: { backdrop: HTMLElement; close: () => void } | null = null;

/** "Ctrl+Shift+P" → [Ctrl] [Shift] [P] */
function keyCaps(combo: string): HTMLElement {
  const wrap = h("span", { class: "cs-keys" });
  combo.split(" / ").forEach((one, i) => {
    if (i) wrap.append(h("span", { class: "cs-or" }, "/"));
    // macOS symbols (⌘⇧P): one cap per symbol; "Ctrl++" keeps its "+" key.
    const mac = /^([⌘⇧⌥⌃]+)(.*)$/.exec(one);
    const parts = mac ? [...mac[1], mac[2]] : one.split(/\+(?!$)/);
    for (const p of parts) if (p) wrap.append(h("kbd", {}, p));
  });
  return wrap;
}

export function showCheatSheet(app: App, opts: { startup?: boolean } = {}) {
  // Ctrl+? while it is open closes it.
  if (open?.backdrop.isConnected) {
    if (!opts.startup) open.close();
    return;
  }
  const mac = app.backend.platform === "macos";
  const mod = mac ? "⌘" : "Ctrl+";
  const alt = mac ? "⌥" : "Alt+";
  const shift = mac ? "⇧" : "Shift+";
  const key = (id: string) => shortcutFor(id);
  const cmd = (label: string, id: string): Row => [label, key(id)];
  const fixed = (label: string, combo: string): Row => [label, combo];
  const goto = key("tab.goto.1");

  const sections: [string, string, Row[]][] = [
    ["Tasks", "tasks", [
      cmd("New task, next status", "task.cycle"),
      cmd("Archive to _done", "task.archive"),
      cmd("Due date", "task.due"),
      cmd("Note ⇄ _done file", "file.toggleDone"),
      cmd("Tasks of the folder", "view.tasks"),
    ]],
    ["Go to", "search", [
      cmd("Command palette", "palette.commands"),
      cmd("File", "palette.files"),
      cmd("Line", "palette.line"),
      cmd("Heading or task", "palette.symbol"),
      cmd("Search in files", "view.search"),
      cmd("Explorer", "view.files"),
    ]],
    ["Files", "file", [
      cmd("New note", "file.new"),
      cmd("From a template", "file.newFromTemplate"),
      cmd("Today's note", "file.dailyNote"),
      cmd("Open file", "file.open"),
      cmd("Open folder", "folder.open"),
      cmd("Save", "file.save"),
      cmd("Save as", "file.saveAs"),
      cmd("New window", "window.new"),
    ]],
    ["Tabs", "files", [
      cmd("Close", "tab.close"),
      cmd("Reopen closed", "tab.reopen"),
      cmd("Next tab", "tab.next"),
      cmd("Previous tab", "tab.prev"),
      ["Tab 1 to 9", goto ? goto.replace(/1$/, "1…9") : ""],
      cmd("Move to a new window", "window.moveTab"),
    ]],
    ["Editing", "command", [
      cmd("Find", "edit.find"),
      cmd("Find and replace", "edit.replace"),
      cmd("Next occurrence of the selection", "edit.nextOccurrence"),
      cmd("Format (JSON, XML…)", "edit.format"),
      fixed("Select next match", formatCombo(`${mac ? "Meta" : "Ctrl"}+D`)),
      fixed("Add a cursor", mac ? "⌥Click" : "Alt+Click"),
      fixed("Select a line", "Click its number"),
      ...(mac ? [] : [fixed("Move with the view", "Ctrl+↑↓")]),
      fixed("Move line", `${alt}↑↓`),
      fixed("Duplicate line", `${shift}${alt}↑↓`),
      fixed("Delete line", `${mod}${shift}K`),
      fixed("Toggle comment", `${mod}/`),
    ]],
    ["View", "eye", [
      cmd("Sidebar", "view.sidebar"),
      cmd("Preview / tree view", "view.preview"),
      ["Text size", [key("view.zoomIn"), key("view.zoomOut")].filter(Boolean).join(" / ")],
      cmd("Word wrap", "view.wrap"),
      cmd("Zen mode", "view.zen"),
      cmd("Settings", "settings.open"),
      cmd("This cheat sheet", "help.shortcuts"),
    ]],
  ];

  const grid = h("div", { class: "cs-grid" });
  for (const [title, ic, rows] of sections) {
    const visible = rows.filter(([, k]) => k);
    if (!visible.length) continue;
    grid.append(
      h("section", { class: "cs-section" },
        h("h3", {}, icon(ic), title),
        ...visible.map(([label, k]) => h("div", { class: "cs-row" }, h("span", { class: "cs-label" }, label), keyCaps(k)))),
    );
  }

  const hide = h("input", { type: "checkbox" }) as HTMLInputElement;
  hide.checked = !app.settings.show_shortcuts_at_startup;
  hide.addEventListener("change", () => void app.updateSetting("show_shortcuts_at_startup", !hide.checked));

  const close = () => {
    backdrop.remove();
    stopListening();
    document.removeEventListener("keydown", onKey, true);
    open = null;
    app.focusEditor();
  };
  const onKey = (e: KeyboardEvent) => {
    // Enter closes, unless it is meant for a focused button or the checkbox.
    const onControl = document.activeElement instanceof HTMLButtonElement || document.activeElement === hide;
    if (e.key === "Escape" || (e.key === "Enter" && !onControl)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const done = h("button", { class: "kn-btn primary", onclick: close }, opts.startup ? "Let's go" : "Close");
  const panel = h(
    "div",
    { class: "kn-cheatsheet", role: "dialog", "aria-label": "Keyboard shortcuts" },
    h("div", { class: "cs-head" },
      mascot("kilo cs-kilo"),
      h("div", {},
        h("div", { class: "kn-modal-title" }, opts.startup ? "Welcome to KiloNote" : "Keyboard shortcuts"),
        h("div", { class: "cs-sub" }, "Everything below, and more, is in the command palette: ", keyCaps(key("palette.commands")))),
      h("span", { class: "kn-spacer" }),
      h("button", { class: "kn-icon-btn", title: "Close (Esc)", onclick: close }, icon("x"))),
    grid,
    h("div", { class: "cs-foot" },
      h("label", { class: "cs-check" }, hide, "Don't show at startup"),
      h("span", { class: "kn-spacer" }),
      h("button", { class: "kn-btn subtle", onclick: () => { close(); void openSettingsView(app, "shortcuts"); } }, icon("keyboard"), "Change shortcuts…"),
      done),
  );
  // Not a modal: every shortcut keeps working. It closes the sheet and runs
  // (trying a shortcut you just read is the point).
  const backdrop = h("div", { class: "kn-cheatsheet-backdrop" }, panel);
  const stopListening = onBeforeCommand((id) => {
    if (id === "help.shortcuts") return; // Ctrl+? toggles it: handled below
    close();
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  document.getElementById("overlay-root")!.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  done.focus();
  open = { backdrop, close };
}
