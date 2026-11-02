// Command registry and keyboard shortcuts.

import type { Platform } from "./backend";

export interface Command {
  id: string;
  title: string;
  run: () => unknown;
  /** Hidden from the palette (parameterized commands such as tab.goto.3). */
  hidden?: boolean;
}

const commands = new Map<string, Command>();
let bindings = new Map<string, string>();
let platform: Platform = "linux";

export function setPlatform(p: Platform) {
  platform = p;
}

export function registerCommands(list: Command[]) {
  for (const c of list) commands.set(c.id, c);
}

export function runCommand(id: string): boolean {
  const c = commands.get(id);
  if (!c) return false;
  try {
    const r = c.run();
    if (r instanceof Promise) r.catch((e) => console.error(`[${id}]`, e));
  } catch (e) {
    console.error(`[${id}]`, e);
  }
  return true;
}

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

/** Normalizes "mod+shift+p", "Cmd+P"… into "Ctrl+Shift+P" / "Meta+Shift+P". */
export function normalizeCombo(combo: string): string {
  const parts = combo.split(/\+(?!$)/).map((s) => s.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === "mod") mods.add(platform === "macos" ? "Meta" : "Ctrl");
    else if (p === "ctrl" || p === "control") mods.add("Ctrl");
    else if (p === "alt" || p === "option" || p === "opt") mods.add("Alt");
    else if (p === "shift" || p === "maj") mods.add("Shift");
    else if (p === "cmd" || p === "command" || p === "meta" || p === "super" || p === "win") mods.add("Meta");
    else key = normalizeKey(raw);
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join("+");
}

function normalizeKey(k: string): string {
  if (k.length === 1) return k.toUpperCase();
  const lower = k.toLowerCase();
  const aliases: Record<string, string> = {
    // (French key names are accepted too: maj, entrée, échap, espace, suppr.)
    enter: "Enter", return: "Enter", entrée: "Enter", entree: "Enter", esc: "Escape", escape: "Escape", échap: "Escape",
    tab: "Tab", space: "Space", espace: "Space", suppr: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    pageup: "PageUp", pagedown: "PageDown", backspace: "Backspace", delete: "Delete", del: "Delete",
    home: "Home", end: "End", plus: "+", minus: "-",
  };
  if (aliases[lower]) return aliases[lower];
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  if (/^arrow/i.test(k)) return "Arrow" + k.slice(5, 6).toUpperCase() + k.slice(6).toLowerCase();
  return k;
}

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead"].includes(e.key)) return null;
  let key: string;
  // Digit keys: use the physical key (AZERTY keyboards need it), except for
  // - = + which are used for zooming ("-" sits on the 6 key on AZERTY).
  if (/^Digit\d$/.test(e.code) && !["-", "=", "+"].includes(e.key)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (e.key === " ") key = "Space";
  else key = normalizeKey(e.key);
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  // For symbols ("?", "+"…), Shift is already part of the character.
  if (e.shiftKey && !(key.length === 1 && !/[A-Z0-9]/.test(key))) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, key].join("+");
}

export function setKeybindings(defaults: Record<string, string>, user: Record<string, string>) {
  const map = new Map<string, string>();
  for (const [combo, id] of Object.entries(defaults)) map.set(normalizeCombo(combo), id);
  for (const [combo, id] of Object.entries(user ?? {})) {
    const c = normalizeCombo(combo);
    if (id) map.set(c, id);
    else map.delete(c);
  }
  bindings = map;
}

/** Main shortcut of a command, formatted for display. */
export function shortcutFor(id: string): string {
  for (const [combo, cid] of bindings) if (cid === id) return formatCombo(combo);
  return "";
}

/** "Label (Ctrl+X)", or just "Label" when the command has no shortcut. */
export function titleWithKey(label: string, id: string): string {
  const key = shortcutFor(id);
  return key ? `${label} (${key})` : label;
}

export function formatCombo(combo: string): string {
  if (platform !== "macos") return combo.replace("ArrowUp", "↑").replace("ArrowDown", "↓");
  const sym: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘", Enter: "↩", ArrowUp: "↑", ArrowDown: "↓" };
  return combo.split("+").map((p) => sym[p] ?? p).join("");
}

/** Global handler (capture phase): returns true when the event was consumed. */
export function handleKeydown(e: KeyboardEvent): boolean {
  if (e.isComposing || e.getModifierState?.("AltGraph")) return false;
  // An open dialog keeps the keyboard to itself.
  if (document.querySelector(".kn-modal-backdrop")) return false;
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const id = bindings.get(combo);
  if (!id || !commands.has(id)) return false;
  e.preventDefault();
  e.stopPropagation();
  runCommand(id);
  return true;
}
