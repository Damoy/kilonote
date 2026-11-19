// Open folder / Open file on Android: a folder browser in the app (the system
// pickers hand out documents, not paths), sized for a finger. It only lists
// folders through the backend; the caller opens what is chosen.

import type { Entry } from "../core/backend";
import { basename, dirname, isInside, samePath } from "../core/path";
import { h, icon } from "./dom";
import { modal } from "./overlay";

export interface Place {
  label: string;
  path: string;
}

export interface PickerOptions {
  mode: "folder" | "file";
  /** Where the browser starts (inside one of the places, otherwise the first place). */
  start?: string | null;
  /** The roots the user can jump to (the phone's storage, the KiloNote folder…). */
  places: Place[];
  listDir: (path: string) => Promise<Entry[]>;
  /** A line under the title (e.g. why only the KiloNote folder is shown). */
  note?: string;
}

/** The place that holds `path` (the deepest one), if any. */
export function placeOf(places: Place[], path: string): Place | undefined {
  return places
    .filter((p) => samePath(p.path, path) || isInside(path, p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** The chosen folder or file, or null when cancelled. */
export function pickPath(opts: PickerOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!opts.places.length) return resolve(null);
    const folder = opts.mode === "folder";
    let current = opts.start && placeOf(opts.places, opts.start) ? opts.start : opts.places[0].path;
    let done = false;

    const pathLine = h("div", { class: "kn-picker-path" });
    const upBtn = h("button", { class: "kn-btn kn-picker-up", title: "Parent folder" }, icon("chevron", "kn-picker-up-icon"), "Up");
    const choose = folder ? h("button", { class: "kn-btn primary kn-picker-choose", onclick: () => finish(current) }) : null;
    const list = h("div", { class: "kn-picker-list", role: "listbox" });
    const places = h(
      "div",
      { class: "kn-picker-places" },
      ...opts.places.map((p) => h("button", { class: "kn-picker-place", "data-path": p.path, onclick: () => void show(p.path) }, p.label)),
    );
    const finish = (path: string | null) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      m.close();
      resolve(path);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    upBtn.addEventListener("click", () => {
      const place = placeOf(opts.places, current);
      if (place && !samePath(place.path, current)) void show(dirname(current));
    });

    async function show(path: string) {
      current = path;
      const place = placeOf(opts.places, path);
      upBtn.toggleAttribute("disabled", !place || samePath(place.path, path));
      for (const b of places.querySelectorAll<HTMLElement>(".kn-picker-place")) b.classList.toggle("active", b.dataset.path === place?.path);
      if (choose) choose.textContent = `Open "${basename(path) || path}"`;
      pathLine.textContent = place && !samePath(place.path, path) ? `${place.label} / ${path.slice(place.path.length).replace(/^[\\/]+/, "").replace(/[\\/]/g, " / ")}` : (place?.label ?? path);
      let entries: Entry[];
      try {
        entries = await opts.listDir(path);
      } catch (e) {
        if (current === path) list.replaceChildren(h("div", { class: "kn-picker-empty" }, `Cannot read this folder: ${e}`));
        return;
      }
      if (current !== path || done) return; // (another folder was opened meanwhile)
      const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
      const rows = [
        ...dirs.map((d) => h("button", { class: "kn-picker-row dir", role: "option", onclick: () => void show(d.path) }, icon("folder"), h("span", {}, d.name), icon("chevron", "kn-picker-go"))),
        ...files.map((f) =>
          folder
            ? h("div", { class: "kn-picker-row file muted" }, icon("file"), h("span", {}, f.name))
            : h("button", { class: "kn-picker-row file", role: "option", onclick: () => finish(f.path) }, icon("file"), h("span", {}, f.name)),
        ),
      ];
      list.replaceChildren(...(rows.length ? rows : [h("div", { class: "kn-picker-empty" }, "Empty folder")]));
      list.scrollTop = 0;
    }

    const content = h(
      "div",
      { class: "kn-picker" },
      h("div", { class: "kn-modal-title" }, folder ? "Open folder" : "Open file"),
      opts.note ? h("div", { class: "kn-modal-message" }, opts.note) : null,
      places,
      h("div", { class: "kn-picker-bar" }, upBtn, pathLine),
      list,
      h(
        "div",
        { class: "kn-modal-actions" },
        h("button", { class: "kn-btn", onclick: () => finish(null) }, "Cancel"),
        choose,
      ),
    );
    const m = modal(content, () => finish(null));
    document.addEventListener("keydown", onKey, true);
    void show(current);
  });
}
