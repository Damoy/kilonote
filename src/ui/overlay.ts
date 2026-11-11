// Context menus, dialogs and notifications, styled like the rest of the app.

import { resolveColor, PALETTE_LABELS } from "../core/themes";
import { h, icon } from "./dom";

export type MenuItem =
  | { label: string; action: () => unknown; icon?: string; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean; color?: string }
  | { separator: true }
  | { header: string }
  | { colors: string[]; selected?: string | null; onPick: (color: string | null) => unknown; allowNone?: boolean };

let restoreFocus: () => void = () => {};
export function setFocusRestorer(fn: () => void) {
  restoreFocus = fn;
}

const root = () => document.getElementById("overlay-root")!;

let closeCurrentMenu: (() => void) | null = null;

export function closeMenu() {
  closeCurrentMenu?.();
}

export function showMenu(items: MenuItem[], x: number, y: number) {
  closeMenu();
  const menu = h("div", { class: "kn-menu", role: "menu" });
  const actionable: HTMLElement[] = [];
  let index = -1;

  const close = (refocus = true) => {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    closeCurrentMenu = null;
    if (refocus) restoreFocus();
  };
  const run = (fn: () => unknown) => {
    close(false);
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error(e))
      .finally(() => {
        if (!document.querySelector(".kn-modal, .kn-palette")) restoreFocus();
      });
  };

  for (const item of items) {
    if ("separator" in item) menu.append(h("div", { class: "kn-menu-sep" }));
    else if ("header" in item) menu.append(h("div", { class: "kn-menu-header" }, item.header));
    else if ("colors" in item) {
      const row = h("div", { class: "kn-menu-colors" });
      if (item.allowNone) {
        row.append(
          h("button", { class: `kn-swatch none${!item.selected ? " selected" : ""}`, title: "None", onclick: () => run(() => item.onPick(null)) }),
        );
      }
      for (const c of item.colors) {
        row.append(
          h("button", {
            class: `kn-swatch${item.selected === c ? " selected" : ""}`,
            title: PALETTE_LABELS[c] ?? c,
            style: { "--c": resolveColor(c) },
            onclick: () => run(() => item.onPick(c)),
          }),
        );
      }
      menu.append(row);
    } else {
      const el = h(
        "div",
        { class: `kn-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`, role: "menuitem" },
        item.color ? h("span", { class: "kn-menu-dot", style: { "--c": resolveColor(item.color) } }) : item.icon ? icon(item.icon) : h("span", { class: "kn-icon" }),
        h("span", { class: "kn-menu-label" }, item.label),
        item.checked ? icon("check", "kn-menu-check") : null,
        item.shortcut ? h("span", { class: "kn-menu-shortcut" }, item.shortcut) : null,
      );
      if (!item.disabled) {
        el.addEventListener("click", () => run(item.action));
        el.addEventListener("mouseenter", () => setIndex(actionable.indexOf(el)));
        actionable.push(el);
      }
      menu.append(el);
    }
  }

  const setIndex = (i: number) => {
    actionable[index]?.classList.remove("active");
    index = i;
    actionable[index]?.classList.add("active");
  };
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") setIndex((index + 1) % actionable.length);
    else if (e.key === "ArrowUp") setIndex((index - 1 + actionable.length) % actionable.length);
    else if (e.key === "Enter" && index >= 0) actionable[index].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onBlur = () => close(false);

  root().append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, y + r.height > innerHeight - 6 ? y - r.height : y)}px`;
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
  });
  document.addEventListener("keydown", onKey, true);
  closeCurrentMenu = () => close(false);
}

// ---------------------------------------------------------------------------

/** A dialog over the window (closed by a click outside it: `onCancel`). */
export function modal(content: HTMLElement, onCancel: () => void): { close: () => void } {
  const backdrop = h("div", { class: "kn-modal-backdrop" });
  const box = h("div", { class: "kn-modal", role: "dialog" }, content);
  backdrop.append(box);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) onCancel();
  });
  root().append(backdrop);
  return {
    close: () => {
      backdrop.remove();
      restoreFocus();
    },
  };
}

export interface PromptOptions {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  /** Initially select only the name, without the extension. */
  selectStem?: boolean;
  colors?: { options: string[]; selected: string | null };
  validate?: (value: string) => string | null;
}

export function prompt(opts: PromptOptions): Promise<{ value: string; color: string | null } | null> {
  return new Promise((resolve) => {
    let color = opts.colors?.selected ?? null;
    const input = h("input", { class: "kn-input", type: "text", value: opts.value ?? "", placeholder: opts.placeholder ?? "", spellcheck: "false" });
    const error = h("div", { class: "kn-modal-error" });
    const swatches = opts.colors
      ? h(
          "div",
          { class: "kn-modal-colors" },
          ...opts.colors.options.map((c) => {
            const b = h("button", { class: `kn-swatch${c === color ? " selected" : ""}`, title: PALETTE_LABELS[c] ?? c, style: { "--c": resolveColor(c) } });
            b.addEventListener("click", () => {
              color = c;
              swatches!.querySelectorAll(".kn-swatch").forEach((s) => s.classList.toggle("selected", s === b));
              input.focus();
            });
            return b;
          }),
        )
      : null;
    const finish = (ok: boolean) => {
      if (ok) {
        const msg = opts.validate?.(input.value.trim()) ?? null;
        if (msg) {
          error.textContent = msg;
          return;
        }
      }
      document.removeEventListener("keydown", onKey, true);
      m.close();
      resolve(ok ? { value: input.value.trim(), color } : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter") finish(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const content = h(
      "div",
      {},
      h("div", { class: "kn-modal-title" }, opts.title),
      opts.message ? h("div", { class: "kn-modal-message" }, opts.message) : null,
      input,
      swatches,
      error,
      h(
        "div",
        { class: "kn-modal-actions" },
        h("button", { class: "kn-btn", onclick: () => finish(false) }, "Cancel"),
        h("button", { class: "kn-btn primary", onclick: () => finish(true) }, opts.okLabel ?? "OK"),
      ),
    );
    const m = modal(content, () => finish(false));
    document.addEventListener("keydown", onKey, true);
    input.focus();
    if (opts.selectStem) {
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    } else input.select();
  });
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Optional third button (e.g. "Don't save"). */
  altLabel?: string;
  danger?: boolean;
}

export function confirm(opts: ConfirmOptions): Promise<"ok" | "alt" | "cancel"> {
  return new Promise((resolve) => {
    const finish = (r: "ok" | "alt" | "cancel") => {
      document.removeEventListener("keydown", onKey, true);
      m.close();
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      const focused = document.activeElement;
      if (e.key === "Escape") finish("cancel");
      // Enter on a focused button: that button wins.
      else if (e.key === "Enter" && focused instanceof HTMLButtonElement && content.contains(focused)) return;
      else if (e.key === "Enter") finish("ok");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const ok = h("button", { class: `kn-btn ${opts.danger ? "danger" : "primary"}`, onclick: () => finish("ok") }, opts.okLabel ?? "OK");
    const content = h(
      "div",
      {},
      h("div", { class: "kn-modal-title" }, opts.title),
      opts.message ? h("div", { class: "kn-modal-message" }, opts.message) : null,
      h(
        "div",
        { class: "kn-modal-actions" },
        opts.altLabel ? h("button", { class: "kn-btn", onclick: () => finish("alt") }, opts.altLabel) : null,
        h("span", { class: "kn-spacer" }),
        h("button", { class: "kn-btn", onclick: () => finish("cancel") }, opts.cancelLabel ?? "Cancel"),
        ok,
      ),
    );
    const m = modal(content, () => finish("cancel"));
    document.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}

// ---------------------------------------------------------------------------

export interface ToastOptions {
  kind?: "info" | "success" | "error";
  action?: { label: string; run: () => unknown };
  actions?: { label: string; run: () => unknown }[];
  timeout?: number;
}

export function toast(message: string, opts: ToastOptions = {}) {
  let host = document.querySelector<HTMLElement>(".kn-toasts");
  if (!host) {
    host = h("div", { class: "kn-toasts" });
    root().append(host);
  }
  const el = h(
    "div",
    { class: `kn-toast ${opts.kind ?? "info"}` },
    h("span", { class: "kn-toast-dot" }),
    h("span", { class: "kn-toast-msg" }, message),
  );
  const dismiss = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  };
  for (const a of [...(opts.action ? [opts.action] : []), ...(opts.actions ?? [])]) {
    el.append(
      h("button", {
        class: "kn-toast-action",
        onclick: () => {
          dismiss();
          void Promise.resolve(a.run()).catch((e) => console.error(e));
        },
      }, a.label),
    );
  }
  el.append(h("button", { class: "kn-toast-close", title: "Close", onclick: dismiss }, icon("x")));
  host.append(el);
  const timeout = opts.timeout ?? (opts.kind === "error" ? 7000 : 3600);
  let timer = setTimeout(dismiss, timeout);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => (timer = setTimeout(dismiss, 1500)));
}
