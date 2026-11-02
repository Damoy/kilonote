// Palette générique (commandes, fichiers, lignes, thèmes…) façon Sublime Text.

import { resolveColor } from "../core/themes";
import { h, highlighted, icon } from "./dom";

export interface PickItem {
  label: string;
  detail?: string;
  hint?: string;
  icon?: string;
  color?: string;
  positions?: number[];
  detailPositions?: number[];
  value?: unknown;
}

export interface PickerSource {
  placeholder: string;
  query?: string;
  /** Élément sélectionné à l'ouverture (sinon le premier). */
  initial?: number;
  provide(query: string): { items: PickItem[]; empty?: string };
  pick(item: PickItem, query: string): unknown;
  highlight?(item: PickItem | null): void;
  cancel?(): void;
  /** Entrée sans élément sélectionné (ex. « :42 » pour aller à une ligne). */
  submit?(query: string): boolean;
}

let current: { close: (picked: boolean) => void } | null = null;
let restoreFocus: () => void = () => {};
export function setPaletteFocusRestorer(fn: () => void) {
  restoreFocus = fn;
}

const MAX_ROWS = 80;

export function openPicker(src: PickerSource) {
  current?.close(false);
  const input = h("input", { class: "kn-palette-input", type: "text", placeholder: src.placeholder, spellcheck: "false", autocomplete: "off" });
  input.value = src.query ?? "";
  const list = h("div", { class: "kn-palette-list", role: "listbox" });
  const box = h("div", { class: "kn-palette" }, h("div", { class: "kn-palette-head" }, icon("search"), input), list);
  const backdrop = h("div", { class: "kn-palette-backdrop" }, box);
  let items: PickItem[] = [];
  let sel = 0;
  let closed = false;
  let firstRender = true;

  const close = (picked: boolean) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    current = null;
    if (!picked) src.cancel?.();
    if (!document.querySelector(".kn-modal")) restoreFocus();
  };

  const select = (i: number, scroll = true) => {
    list.children[sel]?.classList.remove("selected");
    sel = Math.max(0, Math.min(items.length - 1, i));
    const row = list.children[sel] as HTMLElement | undefined;
    row?.classList.add("selected");
    if (scroll) row?.scrollIntoView({ block: "nearest" });
    src.highlight?.(items[sel] ?? null);
  };

  const render = () => {
    const res = src.provide(input.value);
    items = res.items.slice(0, MAX_ROWS);
    list.replaceChildren();
    if (!items.length) {
      if (res.empty) list.append(h("div", { class: "kn-palette-empty" }, res.empty));
      sel = 0;
      return;
    }
    items.forEach((it, i) => {
      const row = h(
        "div",
        { class: "kn-palette-row", role: "option" },
        it.color
          ? h("span", { class: "kn-palette-dot", style: { "--c": resolveColor(it.color) } })
          : icon(it.icon ?? "dot", "kn-palette-icon"),
        h(
          "div",
          { class: "kn-palette-text" },
          h("div", { class: "kn-palette-label" }, highlighted(it.label, it.positions ?? [])),
          it.detail ? h("div", { class: "kn-palette-detail" }, highlighted(it.detail, it.detailPositions ?? [])) : null,
        ),
        it.hint ? h("span", { class: "kn-palette-hint" }, it.hint) : null,
      );
      row.addEventListener("mousemove", () => {
        if (sel !== i) select(i, false);
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      list.append(row);
    });
    select(firstRender ? (src.initial ?? 0) : 0);
    firstRender = false;
  };

  const choose = (i: number) => {
    const it = items[i];
    const q = input.value;
    if (!it) {
      if (src.submit?.(q)) close(true);
      return;
    }
    close(true);
    void Promise.resolve(src.pick(it, q)).catch((e) => console.error(e));
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    const page = 10;
    switch (e.key) {
      case "ArrowDown": select(sel + 1 >= items.length ? 0 : sel + 1); break;
      case "ArrowUp": select(sel - 1 < 0 ? items.length - 1 : sel - 1); break;
      case "PageDown": select(sel + page); break;
      case "PageUp": select(sel - page); break;
      case "Enter": choose(sel); break;
      case "Escape": close(false); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close(false);
  });

  document.getElementById("overlay-root")!.append(backdrop);
  current = { close };
  render();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

