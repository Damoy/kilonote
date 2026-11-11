// Pinned and recent notes, kept at hand. A pinned note stays at the top of the
// explorer and of "Go to file" until it is unpinned; the recent notes are the
// ones opened lately (first in "Go to file" and on the welcome screen).
// Both lists are kept by the app's web view, shared by its windows: nothing is
// written into the notes folder.

import { isInside, samePath } from "../core/path";

const PINS_KEY = "kilonote-pinned-notes";
const RECENT_KEY = "kilonote-recent-notes";
export const RECENT_MAX = 30;
const PINS_MAX = 50;

function read(key: string): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && !!x) : [];
  } catch {
    return [];
  }
}

/** Which list changed. */
export type PinsChange = "pins" | "recent";

const listeners = new Set<(change: PinsChange) => void>();
const notify = (change: PinsChange) => {
  for (const fn of [...listeners]) fn(change);
};

function write(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable: the lists stay as they were */
  }
  notify(key === PINS_KEY ? "pins" : "recent");
}

/** Called when a list changes, in this window or in another one. */
export function onPinsChanged(fn: (change: PinsChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PINS_KEY || e.key === null) notify("pins");
    if (e.key === RECENT_KEY || e.key === null) notify("recent");
  });
}

export const pinnedNotes = (): string[] => read(PINS_KEY);
export const recentNotes = (): string[] => read(RECENT_KEY);
export const isPinned = (path: string): boolean => pinnedNotes().some((p) => samePath(p, path));

export function setPinned(path: string, pinned: boolean) {
  const rest = pinnedNotes().filter((p) => !samePath(p, path));
  write(PINS_KEY, pinned ? [...rest, path].slice(-PINS_MAX) : rest);
}

/** A note was opened (or shown again): it goes first among the recent ones. */
export function noteOpened(path: string) {
  const list = recentNotes();
  if (list[0] && samePath(list[0], path)) return;
  write(RECENT_KEY, [path, ...list.filter((p) => !samePath(p, path))].slice(0, RECENT_MAX));
}

/** A note that could not be opened (deleted, moved by another program): no longer recent. */
export function forgetRecent(path: string) {
  const list = recentNotes();
  if (list.some((p) => samePath(p, path))) write(RECENT_KEY, list.filter((p) => !samePath(p, path)));
}

/** A file or a folder was renamed: its notes keep their pin and their place among the recent ones. */
export function pathRenamed(from: string, to: string) {
  const move = (p: string) => (samePath(p, from) ? to : isInside(p, from) ? to + p.slice(from.length) : p);
  for (const key of [PINS_KEY, RECENT_KEY]) {
    const list = read(key);
    const next = list.map(move);
    if (next.some((p, i) => p !== list[i])) write(key, next);
  }
}

/** A file or a folder went to the trash: its notes are neither pinned nor recent any more. */
export function pathRemoved(path: string) {
  const gone = (p: string) => samePath(p, path) || isInside(p, path);
  for (const key of [PINS_KEY, RECENT_KEY]) {
    const list = read(key);
    if (list.some(gone)) write(key, list.filter((p) => !gone(p)));
  }
}
