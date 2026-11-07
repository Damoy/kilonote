// Local history: a copy of any version KiloNote is about to throw away
// (overwrite, reload over unsaved edits, replace in files), and Replace in files.

import { basename, isWindowsPath, join } from "../core/path";
import { fuzzyFilter } from "../core/fuzzy";
import { toast } from "../ui/overlay";
import { openPicker } from "../ui/palette";
import type { App, Doc } from "./app";

/** Local history: <config>/history/<stamp>_<path hash>_<kind>_<file name>, newest kept. */
type HistoryKind = "disk" | "mine" | "replace";

const HISTORY_KEEP = 300;

const HISTORY_LABELS: Record<HistoryKind, string> = {
  disk: "Version on disk, before KiloNote overwrote it",
  mine: "Your unsaved edits, before reloading from disk",
  replace: "Before \"Replace in files\"",
};

/** FNV-1a hash of a path (case-insensitive on Windows). */
export function pathHash(path: string): string {
  const norm = isWindowsPath(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function historyName(path: string, kind: HistoryKind, now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
  return `${stamp}_${pathHash(path)}_${kind}_${basename(path)}`;
}

export function parseHistoryName(name: string): { hash: string; kind: HistoryKind; when: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}_([0-9a-f]{8})_(disk|mine|replace)_/.exec(name);
  if (!m) return null;
  return { hash: m[7], kind: m[8] as HistoryKind, when: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` };
}

export function historyDir(app: App) {
  return join(app.configDir, "history");
}

export async function keepVersion(app: App, doc: Doc, kind: HistoryKind) {
  if (!doc.path) return;
  try {
    const text = kind === "mine" ? (doc === app.active ? app.view.state : doc.state).doc.toString() : (await app.backend.readText(doc.path)).text;
    await app.backend.writeText(join(historyDir(app), historyName(doc.path, kind)), text);
    void app.backend.pruneHistory(HISTORY_KEEP).catch(() => {});
  } catch {
    /* best effort: never block a save or a reload */
  }
}

/**
 * "Replace in files": every match of `re` (line by line) in these files. Open
 * notes are changed in their tab and saved; the others are rewritten in their
 * own encoding after a copy goes to the local history. Undo puts every file back.
 */
export async function replaceInFiles(app: App, paths: string[], re: RegExp, replacement: string, literal: boolean): Promise<{ files: number; count: number }> {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const global = new RegExp(re.source, flags);
  const done: { path: string; original: string; encoding: string; mtime: number; open: boolean }[] = [];
  let count = 0;
  for (const path of paths) {
    const doc = app.findDoc(path);
    let original: string;
    let encoding = "UTF-8";
    if (doc) original = (doc === app.active ? app.view.state : doc.state).doc.toString();
    else {
      try {
        const ft = await app.backend.readText(path);
        original = ft.text;
        encoding = ft.encoding;
      } catch {
        continue;
      }
    }
    let n = 0;
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const next = original
      .split(/\r\n|\r|\n/)
      .map((line) => {
        for (const m of line.matchAll(global)) if (m[0].length) n++;
        return literal ? line.replace(global, () => replacement) : line.replace(global, replacement);
      })
      .join(eol);
    if (!n || next === original) continue;
    if (doc) {
      app.replaceDocContent(doc, next);
      if (doc.path && !(await app.save(doc))) continue;
      done.push({ path, original, encoding: doc.encoding, mtime: doc.mtime, open: true });
    } else {
      await app.backend.writeText(join(historyDir(app), historyName(path, "replace")), original).catch(() => {});
      try {
        const written = await app.backend.writeText(path, next, encoding);
        done.push({ path, original, encoding: written.encoding, mtime: written.mtime, open: false });
      } catch (e) {
        toast(`Could not write ${basename(path)}: ${e}`, { kind: "error" });
        continue;
      }
    }
    count += n;
  }
  void app.backend.pruneHistory(HISTORY_KEEP).catch(() => {});
  if (done.length) {
    const undo = async () => {
      for (const f of done) {
        const doc = app.findDoc(f.path);
        if (doc) {
          app.replaceDocContent(doc, f.original);
          await app.save(doc);
        } else if ((await app.backend.stat(f.path))?.mtime === f.mtime) {
          await app.backend.writeText(f.path, f.original, f.encoding).catch(() => {});
        }
      }
      app.emit("saved");
    };
    toast(`${count} replacement${count > 1 ? "s" : ""} in ${done.length} file${done.length > 1 ? "s" : ""}.`, {
      kind: "success", timeout: 12000, action: { label: "Undo", run: undo },
    });
    app.emit("saved");
  }
  return { files: done.length, count };
}

export async function showLocalHistory(app: App) {
  const doc = app.active;
  if (!doc?.path) {
    toast("Local history keeps earlier versions of saved notes.");
    return;
  }
  const path = doc.path;
  const entries = (await app.backend.listDir(historyDir(app), true).catch(() => []))
    .map((e) => ({ entry: e, info: parseHistoryName(e.name) }))
    .filter((x) => x.info?.hash === pathHash(path))
    .sort((a, b) => b.entry.name.localeCompare(a.entry.name));
  if (!entries.length) {
    toast(`No earlier version of "${basename(path)}" yet. KiloNote keeps one whenever a version is about to be overwritten (conflicts, reloads, replace in files).`, { timeout: 6000 });
    return;
  }
  openPicker({
    placeholder: `Earlier versions of ${basename(path)}`,
    provide: (q) => ({
      items: fuzzyFilter(q, entries, (x) => `${x.info!.when} ${HISTORY_LABELS[x.info!.kind]}`).map(({ item }) => ({
        label: item.info!.when, detail: HISTORY_LABELS[item.info!.kind], icon: "file", value: item.entry.path,
      })),
    }),
    pick: async (it) => {
      const { text } = await app.backend.readText(it.value as string);
      const when = parseHistoryName(basename(it.value as string))!.when;
      app.newDoc({ text, title: `${basename(path)} (${when})`, lang: doc.lang });
    },
  });
}
