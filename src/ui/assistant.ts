// Kilo, the assistant: the mascot sits in a corner of the editor and, once the
// typing pauses, offers a hint about what is being written (text/hints.ts): a
// private line to encrypt, a list item that could be a task, a date that could
// be a due date… Each hint shows once per session at most, never while typing,
// and can be dismissed for good. Clicked, Kilo gives a tip about the app.
// Alive: he blinks, hops now and then, writes along while you type, talks,
// cheers when a task is done, and dozes off when nothing happens.
// Everything is read from the note on this computer; nothing is sent anywhere.
// Turned off in the settings (Appearance), or with "Hide Kilo" in his menu.

import type { App } from "../app/app";
import { runCommand, shortcutFor } from "../core/commands";
import { isDoneFile, stem } from "../core/path";
import { occurrences } from "../editor/matches";
import { contextHints, GENERAL_TIPS, type Hint, type HintAction, type HintContext } from "../text/hints";
import { findTasks, isDoneStatus, setDueInLine, todayISO } from "../text/tasks";
import { h } from "./dom";
import { showMenu, toast } from "./overlay";
import { mascot } from "./welcome";

/** Kilo waits for this pause in the typing before offering a hint. */
const PAUSE_MS = 2200;
/** And for this long after a hint before offering another one by himself. */
const COOLDOWN_MS = 90_000;
/** A hint he offered by himself goes away after this (unless the pointer is on it). */
const BUBBLE_MS = 14_000;
/** He dozes off after this long without anything happening. */
const SLEEP_MS = 3 * 60_000;
/** Notes larger than this are read only around the cursor. */
const MAX_TEXT = 400_000;

const DISMISSED_KEY = "kilonote-hints-dismissed";

function loadDismissed(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

class Assistant {
  readonly el = h("div", { class: "kn-kilo" });
  private body = mascot("kilo kn-kilo-body");
  private bubble = h("div", { class: "kn-kilo-bubble", role: "status", "aria-live": "polite", hidden: true });
  private dismissed = loadDismissed();
  /** Hints offered in this session (each once at most). */
  private offered = new Set<string>();
  private lastOffer = 0;
  private lastDoc: unknown = null;
  private doneCounts = new WeakMap<object, number>();
  private tip = Math.floor(Math.random() * GENERAL_TIPS.length);
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private writingTimer: ReturnType<typeof setTimeout> | undefined;
  private bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private moodTimer: ReturnType<typeof setTimeout> | undefined;
  private onSelection = () => this.activity(true);
  private onActive = () => {
    this.hide();
    this.activity(false);
  };
  private onInput = () => this.wake();

  constructor(readonly app: App) {
    this.body.setAttribute("role", "button");
    this.body.setAttribute("tabindex", "-1");
    this.body.setAttribute("aria-label", "Kilo, your assistant: click for a tip, right-click for his menu");
    this.body.title = "Kilo: click for a tip · right-click: menu";
    this.body.addEventListener("click", () => this.clicked());
    this.body.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.menu(e.clientX, e.clientY);
    });
    // Clicking Kilo or his bubble never takes the keyboard from the editor.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    this.bubble.addEventListener("mouseenter", () => clearTimeout(this.bubbleTimer));
    this.bubble.addEventListener("mouseleave", () => this.hideLater());
    this.el.append(this.bubble, this.body, h("span", { class: "kn-kilo-zz", "aria-hidden": "true" }, "z"));
    document.getElementById("editor-host")!.append(this.el);
    app.on("selection", this.onSelection);
    app.on("active", this.onActive);
    document.addEventListener("keydown", this.onInput, true);
    document.addEventListener("pointerdown", this.onInput, true);
    this.lastDoc = app.active ? app.view.state.doc : null;
    this.wake();
    this.mood("hello", 1200);
  }

  destroy() {
    for (const t of [this.pauseTimer, this.writingTimer, this.bubbleTimer, this.sleepTimer, this.moodTimer]) clearTimeout(t);
    this.app.off("selection", this.onSelection);
    this.app.off("active", this.onActive);
    document.removeEventListener("keydown", this.onInput, true);
    document.removeEventListener("pointerdown", this.onInput, true);
    this.el.remove();
  }

  // --- Life -------------------------------------------------------------------

  /** Something happened in the note: Kilo writes along while you type, and waits for a pause. */
  private activity(fromEditor: boolean) {
    this.wake();
    const doc = this.app.active ? this.app.view.state.doc : null;
    if (fromEditor && doc && doc !== this.lastDoc) {
      this.el.classList.add("writing");
      clearTimeout(this.writingTimer);
      this.writingTimer = setTimeout(() => this.el.classList.remove("writing"), 900);
      // A hint he offered by himself makes way for the typing.
      if (this.bubble.dataset.auto === "1") this.hide();
    }
    this.lastDoc = doc;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => this.paused(), PAUSE_MS);
  }

  private wake() {
    this.el.classList.remove("sleeping");
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      if (this.bubble.hidden) this.el.classList.add("sleeping");
    }, SLEEP_MS);
  }

  /** A short animation: "hello", "talking", "cheer". */
  private mood(name: string, ms: number) {
    this.el.classList.remove("hello", "talking", "cheer");
    void this.el.offsetWidth; // (restarts the animation)
    this.el.classList.add(name);
    clearTimeout(this.moodTimer);
    this.moodTimer = setTimeout(() => this.el.classList.remove(name), ms);
  }

  // --- Hints ------------------------------------------------------------------

  private context(): HintContext | null {
    const app = this.app;
    const doc = app.active;
    if (!doc) return null;
    const state = app.view.state;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const occ = sel.empty || sel.to - sel.from > 200 ? null : occurrences(state);
    const current = doc.path ? stem(doc.path).toLowerCase() : "";
    const notes = app.workspaceFiles
      .filter((p) => app.isNoteFile(p) && !isDoneFile(p, app.settings.archive_suffix))
      .slice(0, 3000)
      .map((p) => stem(p))
      .filter((n) => n.toLowerCase() !== current);
    return {
      lang: doc.lang,
      path: doc.path,
      archive: !!doc.path && isDoneFile(doc.path, app.settings.archive_suffix),
      text: state.doc.length <= MAX_TEXT ? state.doc.toString() : null,
      line: line.text,
      lineNumber: line.number,
      selection: sel.empty ? null : state.sliceDoc(sel.from, sel.to),
      occurrences: occ ? occ.from.length : null,
      notes,
      tabs: app.docs.length,
      previewOpen: !!app.preview?.visible,
      cfg: app.taskCfg,
      today: todayISO(),
      key: (id) => shortcutFor(id) || id,
    };
  }

  /** The typing paused: a task just done makes Kilo cheer; a useful hint, he offers it. */
  private paused() {
    const ctx = this.context();
    // (Hidden in zen mode: no hint is offered there.)
    if (!ctx || !this.app.active || document.body.classList.contains("zen")) return;
    if (ctx.text != null && (ctx.lang === "text" || ctx.lang === "markdown")) {
      const done = findTasks(ctx.text, ctx.cfg).filter((t) => isDoneStatus(t.task.key, ctx.cfg)).length;
      const before = this.doneCounts.get(this.app.active);
      this.doneCounts.set(this.app.active, done);
      if (before != null && done > before) this.mood("cheer", 1100);
    }
    if (!this.bubble.hidden || Date.now() - this.lastOffer < COOLDOWN_MS) return;
    const hint = contextHints(ctx).find((x) => !this.dismissed.has(x.id) && !this.offered.has(x.id));
    if (!hint) return;
    this.offered.add(hint.id);
    this.lastOffer = Date.now();
    this.show(hint, true);
  }

  private clicked() {
    if (!this.bubble.hidden) return this.close();
    const ctx = this.context();
    const hint = ctx ? contextHints(ctx).find((x) => !this.dismissed.has(x.id)) : undefined;
    if (hint) {
      this.offered.add(hint.id);
      this.show(hint, false);
    } else this.showTip();
  }

  private showTip() {
    this.tip = (this.tip + 1) % GENERAL_TIPS.length;
    const text = GENERAL_TIPS[this.tip].replace(/\{([\w.]+)\}/g, (_m, id: string) => shortcutFor(id) || id);
    this.render(h("strong", {}, "Tip · "), text, [
      h("button", { class: "kn-btn subtle", onclick: () => this.showTip() }, "Another tip"),
      h("button", { class: "kn-btn", onclick: () => this.close() }, "Thanks!"),
    ]);
    this.bubble.dataset.auto = "0";
    this.mood("talking", 1700);
  }

  private show(hint: Hint, auto: boolean) {
    // The line the hint is about: its action applies to it, even if the cursor moved since.
    const state = this.app.view.state;
    const at = state.doc.lineAt(state.selection.main.head);
    const target = { doc: this.app.active, number: at.number, text: at.text };
    const buttons: HTMLElement[] = [];
    if (hint.action) {
      const action = hint.action;
      buttons.push(h("button", { class: "kn-btn primary", onclick: () => this.act(action, target) }, action.label));
    }
    buttons.push(h("button", { class: "kn-btn", onclick: () => this.close() }, hint.action ? "Not now" : "Thanks!"));
    this.render(null, hint.text, buttons, h("button", { class: "kn-kilo-never", onclick: () => this.dismiss(hint.id) }, "Don't show again"));
    this.bubble.dataset.auto = auto ? "1" : "0";
    this.mood("talking", 1700);
    if (auto) this.hideLater();
  }

  private render(prefix: HTMLElement | null, text: string, buttons: HTMLElement[], extra?: HTMLElement) {
    this.el.classList.remove("sleeping");
    clearTimeout(this.bubbleTimer);
    this.bubble.replaceChildren(
      h("div", { class: "kn-kilo-text" }, prefix, text),
      h("div", { class: "kn-kilo-actions" }, extra ?? null, ...buttons),
    );
    this.bubble.hidden = false;
  }

  private hideLater() {
    if (this.bubble.dataset.auto !== "1") return;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.hide(), BUBBLE_MS);
  }

  /** Closed with one of its buttons: the editor gets the keyboard back. */
  private close() {
    this.hide();
    this.app.focusEditor();
  }

  private hide() {
    clearTimeout(this.bubbleTimer);
    this.bubble.hidden = true;
  }

  private dismiss(id: string) {
    this.dismissed.add(id);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed]));
    } catch {
      /* storage unavailable: dismissed for this session */
    }
    this.hide();
    this.app.focusEditor();
  }

  private act(action: HintAction, target: { doc: unknown; number: number; text: string }) {
    this.close();
    const app = this.app;
    const state = app.view.state;
    // The hint's line, where it is now (lines may have been added above it).
    let line = target.number <= state.doc.lines ? state.doc.line(target.number) : null;
    if (line?.text !== target.text) {
      const i = state.doc.toString().split("\n").indexOf(target.text);
      line = i >= 0 ? state.doc.line(i + 1) : null;
    }
    if (app.active !== target.doc || !line) {
      toast("The line changed meanwhile: nothing was done.");
      return;
    }
    if ("due" in action) {
      const edit = setDueInLine(line.text, app.taskCfg, action.due);
      if (edit) app.view.dispatch({ changes: edit.changes.map((c) => ({ from: line.from + c.from, to: line.from + c.to, insert: c.insert })), userEvent: "input.task" });
      return;
    }
    if (action.selectLine) app.view.dispatch({ selection: { anchor: line.from, head: line.to } });
    else if (action.onLine) app.view.dispatch({ selection: { anchor: line.to } });
    runCommand(action.command);
  }

  private menu(x: number, y: number) {
    showMenu(
      [
        { header: "Kilo" },
        { label: "Give me a tip", icon: "wand", action: () => this.showTip() },
        ...(this.dismissed.size
          ? [{ label: `Show the ${this.dismissed.size} hint${this.dismissed.size > 1 ? "s" : ""} I turned off again`, icon: "refresh", action: () => this.undismissAll() }]
          : []),
        { separator: true },
        { label: "Hide Kilo", icon: "x", action: () => hideKilo(this.app) },
      ],
      x,
      y - 4,
    );
  }

  private undismissAll() {
    this.dismissed.clear();
    try {
      localStorage.removeItem(DISMISSED_KEY);
    } catch {
      /* nothing to forget */
    }
    toast("Kilo will offer every hint again.");
  }
}

/** Kilo goes away (the setting is turned off), with a way back. */
function hideKilo(app: App) {
  void app.updateSetting("assistant", false);
  toast("Kilo is hidden. Settings → Appearance brings him back.", { action: { label: "Undo", run: () => void app.updateSetting("assistant", true) } });
}

let current: Assistant | null = null;

/** Shows or removes Kilo, as the settings say. */
export function syncAssistant(app: App) {
  const on = app.settings.assistant;
  // (Another window's app, or a page drawn again: Kilo starts over.)
  if (current && (current.app !== app || !current.el.isConnected)) {
    current.destroy();
    current = null;
  }
  if (on && !current) current = new Assistant(app);
  else if (!on && current) {
    current.destroy();
    current = null;
  }
}
