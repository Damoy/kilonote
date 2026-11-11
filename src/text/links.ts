// Links between notes: `[[work]]`, `[[projects/report]]`, `[[report.md]]` or
// `[[work|the work note]]`: the name of another note of the folder, its
// extension optional. A link points to the note next to the one that holds it
// first, otherwise to the note with that name elsewhere in the folder (the
// shortest path wins).

import { dirname, extname, isWindowsPath, pathKey } from "../core/path";

const LINK = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

export interface NoteLink {
  /** What the link points to, as written (`projects/report`). */
  target: string;
  /** Where the whole link is on the line (`[[` to `]]`). */
  from: number;
  to: number;
}

/** The links to notes written on a line. */
export function noteLinks(line: string): NoteLink[] {
  if (!line.includes("[[")) return [];
  return [...line.matchAll(LINK)].map((m) => ({ target: m[1].trim(), from: m.index, to: m.index + m[0].length }));
}

/** A target that stays in the folder: no absolute path, no `..`. */
export function isSafeTarget(target: string): boolean {
  return !!target && !isWindowsPath(target) && !/^[\\/]/.test(target) && !/(^|[\\/])\.\.([\\/]|$)/.test(target) && !/[:*?"<>|]/.test(target);
}

/** `a/b.txt` → `a/b` (the extension is left out when it is one of a note). */
function withoutExt(p: string, isNote: (p: string) => boolean): string {
  const ext = extname(p);
  return ext && isNote(p) ? p.slice(0, -(ext.length + 1)) : p;
}

/**
 * The note a link points to among `notes` (full paths), or null: the note with
 * that path next to `fromNote` first, otherwise the one whose path ends with it
 * (the shortest path, then in alphabetical order).
 */
export function resolveNoteLink(target: string, fromNote: string | null, notes: string[], isNote: (p: string) => boolean): string | null {
  if (!isSafeTarget(target)) return null;
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "");
  const hasExt = isNote(t) && !!extname(t);
  const key = (p: string) => pathKey(hasExt ? p : withoutExt(p, isNote));
  const wanted = key("/" + t);
  const caseless = wanted.toLowerCase();
  const candidates = notes.filter((p) => {
    const k = key(p);
    return k.endsWith(wanted) || k.toLowerCase().endsWith(caseless);
  });
  if (!candidates.length) return null;
  if (fromNote) {
    const here = pathKey(dirname(fromNote)) + wanted;
    const next = candidates.find((p) => key(p).toLowerCase() === here.toLowerCase());
    if (next) return next;
  }
  const depth = (p: string) => p.split(/[\\/]/).length;
  return [...candidates].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
}

/** The lines of `notes` with a link to `note` (its backlinks), in order. */
export function linksTo(
  note: string,
  notes: { path: string; text: string | null }[],
  allNotes: string[],
  isNote: (p: string) => boolean,
): { path: string; line: number; text: string }[] {
  const out: { path: string; line: number; text: string }[] = [];
  const target = pathKey(note);
  for (const n of notes) {
    if (!n.text?.includes("[[") || pathKey(n.path) === target) continue;
    n.text.split("\n").forEach((text, i) => {
      if (noteLinks(text).some((l) => {
        const to = resolveNoteLink(l.target, n.path, allNotes, isNote);
        return to != null && pathKey(to) === target;
      })) out.push({ path: n.path, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

/** How to write a link to `note`: its name when no other note has it, otherwise its path in the folder. */
export function linkName(note: string, root: string | null, allNotes: string[], isNote: (p: string) => boolean): string {
  const name = withoutExt(note.split(/[\\/]/).pop()!, isNote);
  const same = allNotes.filter((p) => withoutExt(p.split(/[\\/]/).pop()!, isNote).toLowerCase() === name.toLowerCase());
  if (same.length <= 1 || !root) return name;
  const rel = note.slice(root.replace(/[\\/]+$/, "").length + 1).replace(/\\/g, "/");
  return withoutExt(rel, isNote);
}
