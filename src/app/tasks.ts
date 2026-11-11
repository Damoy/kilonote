// Task actions on notes: next status, archive to _done, due dates, the
// status menu, and the activity reports.

import { ChangeSet, EditorState, Text, type ChangeSpec } from "@codemirror/state";
import { shortcutFor } from "../core/commands";
import { basename, dirname, doneFileFor, extname, isDoneFile, join, projectName, relative, stem } from "../core/path";
import { fuzzyFilter } from "../core/fuzzy";
import { isCodeLang, languageLabel } from "../editor/languages";
import { archivedLine, cycleLine, findTags, findTasks, isDoneStatus, parseDateInput, parseTask, setDueInLine, todayISO, type FoundTask } from "../text/tasks";
import type { PeriodKind, ReportSource } from "../text/report";
import { showMenu, toast, type MenuItem } from "../ui/overlay";
import { openPicker } from "../ui/palette";
import type { App, Doc } from "./app";

/** Removes whole lines (1-based numbers, ascending), in contiguous blocks so that changes never overlap. */
function lineRemoval(doc: Text, numbers: number[]): ChangeSet {
  const specs: { from: number; to: number }[] = [];
  let i = 0;
  while (i < numbers.length) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    const a = doc.line(numbers[i]);
    const b = doc.line(numbers[j]);
    if (b.number < doc.lines) specs.push({ from: a.from, to: b.to + 1 });
    else specs.push({ from: a.number > 1 ? a.from - 1 : a.from, to: b.to });
    i = j + 1;
  }
  return ChangeSet.of(specs, doc.length);
}

export function selectedLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const endLine = state.doc.lineAt(r.to);
    let b = endLine.number;
    if (!r.empty && b > a && endLine.from === r.to) b--;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

/**
 * Ctrl+Enter: next status (or `target`) on the selected lines.
 * Resolves once an automatic archive (auto_archive) is written.
 */
/** Tasks belong to notes: in code and data files, a line is never turned into one. */
export function notesOnly(app: App, doc: Doc): boolean {
  if (!isCodeLang(doc.lang)) return true;
  app.toastInfo(`Tasks live in notes (text and Markdown files): app is a ${languageLabel(doc.lang)} file, it is left as it is.`);
  return false;
}

export async function cycleTasks(app: App, target?: string, doc = app.active, lines?: number[]): Promise<void> {
  if (!doc || !notesOnly(app, doc)) return;
  const state = doc === app.active ? app.view.state : doc.state;
  const nums = lines ?? selectedLines(state);
  const multi = nums.length > 1;
  const changes: ChangeSpec[] = [];
  let cursor: number | null = null;
  const nowDone: number[] = [];
  for (const n of nums) {
    const line = state.doc.line(n);
    if (multi && !line.text.trim()) continue;
    const edit = cycleLine(line.text, app.taskCfg, target);
    if (!edit) continue;
    for (const c of edit.changes) changes.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
    if (!multi && edit.cursor != null) cursor = line.from + edit.cursor;
    let text = line.text;
    for (const c of [...edit.changes].reverse()) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
    const t = parseTask(text, app.taskCfg);
    if (t && isDoneStatus(t.key, app.taskCfg)) nowDone.push(n);
  }
  if (!changes.length) return;
  app.applyToDoc(doc, {
    changes,
    selection: cursor != null ? { anchor: cursor } : undefined,
    userEvent: "input.task",
    scrollIntoView: doc === app.active,
  });
  if (app.settings.auto_archive && nowDone.length && doc.path && !isDoneFile(doc.path, app.settings.archive_suffix)) {
    await archiveLines(app, doc, nowDone);
  }
}

/** Moves lines to the archive file (<name>_done.<ext>). */
export async function archiveLines(app: App, doc: Doc, lineNumbers: number[]) {
  if (!doc.path) {
    toast("Save app note first to archive its tasks.", {
      action: { label: "Save", run: () => void app.saveAs(doc) },
    });
    return;
  }
  const suffix = app.settings.archive_suffix;
  if (isDoneFile(doc.path, suffix)) {
    toast("This note is already an archive file.");
    return;
  }
  const state = doc === app.active ? app.view.state : doc.state;
  const lines = lineNumbers.map((n) => state.doc.line(n)).filter((l) => l.text.trim());
  if (!lines.length) return;
  const date = todayISO();
  const out = lines.map((l) => archivedLine(l.text, app.taskCfg, date));
  const target = doneFileFor(doc.path, suffix);

  // The archive is written first: if that fails, the note is left untouched.
  const tracker = app.trackChanges(doc);
  try {
    await appendToFile(app, target, out);
  } catch (e) {
    toast(`Could not archive (${e}). The note was not changed.`, { kind: "error" });
    return;
  } finally {
    tracker.stop();
  }
  // Then the lines leave the note, wherever they are now (it may have been edited meanwhile).
  const current = doc === app.active ? app.view.state : doc.state;
  const since = tracker.changes();
  const kept: number[] = [];
  const now: number[] = [];
  for (const l of lines) {
    const pos = since.mapPos(l.from, 1);
    const line = current.doc.lineAt(Math.min(pos, current.doc.length));
    if (line.from === pos && line.text === l.text && !now.includes(line.number)) now.push(line.number);
    else kept.push(l.number);
  }
  const removal = lineRemoval(current.doc, now);
  if (!removal.empty) app.applyToDoc(doc, { changes: removal, userEvent: "delete.archive" });
  const n = out.length;
  toast(
    kept.length
      ? `${n} task${n > 1 ? "s" : ""} archived → ${basename(target)}. ${kept.length} line${kept.length > 1 ? "s were" : " was"} edited meanwhile and kept in the note.`
      : `${n} task${n > 1 ? "s" : ""} archived → ${basename(target)}`,
    { kind: "success", action: { label: "Open", run: () => void app.openFile(target) } },
  );
  app.refreshWorkspaceFilesSoon();
}

export async function archiveSelection(app: App) {
  const doc = app.active;
  if (!doc || !notesOnly(app, doc)) return;
  await archiveLines(app, doc, selectedLines(app.view.state));
}

export async function archiveAllDone(app: App) {
  const doc = app.active;
  if (!doc || !notesOnly(app, doc)) return;
  const found = findTasks(app.view.state.doc.toString(), app.taskCfg).filter((f) => isDoneStatus(f.task.key, app.taskCfg));
  if (!found.length) {
    toast("No completed task in app note.");
    return;
  }
  await archiveLines(app, doc, found.map((f) => f.line));
}

export async function appendToFile(app: App, path: string, lines: string[]) {
  const open = app.findDoc(path);
  if (open) {
    const d = open.state.doc;
    const last = d.line(d.lines);
    const prefix = d.length === 0 || last.length === 0 ? "" : "\n";
    app.applyToDoc(open, { changes: { from: d.length, insert: prefix + lines.join("\n") + "\n" } });
    if (!(await app.save(open))) throw new Error("could not save the archive");
  } else {
    await app.backend.appendLines(path, lines);
  }
}

/** Switches between work.txt and work_done.txt. */
export async function toggleDoneFile(app: App) {
  const doc = app.active;
  if (!doc?.path) return;
  const suffix = app.settings.archive_suffix;
  let target: string;
  if (isDoneFile(doc.path, suffix)) {
    const s = stem(doc.path);
    target = join(dirname(doc.path), s.slice(0, s.length - suffix.length) + (extname(doc.path) ? doc.path.slice(doc.path.lastIndexOf(".")) : ""));
  } else target = doneFileFor(doc.path, suffix);
  if (!(await app.backend.stat(target))) {
    toast(`${basename(target)} doesn't exist yet: it will be created by the first archive.`);
    return;
  }
  await app.openFile(target);
}

export function showStatusMenu(app: App, lineNo: number, x: number, y: number) {
  const doc = app.active;
  if (!doc) return;
  const line = app.view.state.doc.line(lineNo);
  const task = parseTask(line.text, app.taskCfg);
  const items: MenuItem[] = [{ header: "Status" }];
  for (const [name, color] of Object.entries(app.taskCfg.statuses)) {
    items.push({
      label: name,
      color,
      checked: task?.key === name,
      action: () => cycleTasks(app, name, doc, [lineNo]),
    });
  }
  if (doc.path && !isDoneFile(doc.path, app.settings.archive_suffix)) {
    items.push({ separator: true });
    items.push({
      label: `Archive to ${basename(doneFileFor(doc.path, app.settings.archive_suffix))}`,
      icon: "archive",
      shortcut: shortcutFor("task.archive"),
      action: () => archiveLines(app, doc, [lineNo]),
    });
  }
  showMenu(items, x, y);
}

/**
 * Changes one task of a note from a list of the folder's tasks (the sidebar, the
 * board), whether the note is open or not: a status (or the next one), or the
 * archive. The note is saved, and closed again if it was opened only for this.
 * Returns the new text of the note, or null if the task's line changed meanwhile.
 */
export async function changeTaskInNote(app: App, path: string, t: FoundTask, change: { status?: string; archive?: boolean }): Promise<string | null> {
  const wasOpen = !!app.findDoc(path);
  const doc = await app.openFile(path, { activate: false });
  if (!doc) return null;
  const state = doc === app.active ? app.view.state : doc.state;
  const line = state.doc.lines >= t.line ? state.doc.line(t.line) : null;
  if (!line || line.text !== t.raw) {
    if (!wasOpen && doc !== app.active) await app.closeDoc(doc, { force: true });
    return null;
  }
  if (change.archive) await archiveLines(app, doc, [t.line]);
  else await cycleTasks(app, change.status, doc, [t.line]);
  await app.save(doc);
  const text = (doc === app.active ? app.view.state : doc.state).doc.toString();
  if (!wasOpen && doc !== app.active) await app.closeDoc(doc, { force: true });
  return text;
}

/** The tasks of every note of the open folder (not the _done archives), note by note. */
export async function folderTasks(app: App, limit = 3000): Promise<{ path: string; tasks: FoundTask[] }[]> {
  if (!app.workspace) return [];
  const suffix = app.settings.archive_suffix;
  const files = app.workspaceFiles.filter((p) => app.isNoteFile(p) && !isDoneFile(p, suffix)).slice(0, limit);
  const texts = await app.readFiles(files);
  return files.flatMap((path, i) => {
    const text = texts[i];
    const tasks = text ? findTasks(text, app.taskCfg) : [];
    return tasks.length ? [{ path, tasks }] : [];
  });
}

export function needFolder(app: App): boolean {
  if (app.workspace) return true;
  toast("Open the folder that contains your notes first.", { action: { label: "Open folder", run: () => void app.openFolder() } });
  return false;
}

/** Every project of the folder: its note and its _done archive. */
export async function reportSources(app: App): Promise<ReportSource[]> {
  await app.refreshWorkspaceFiles();
  const suffix = app.settings.archive_suffix;
  const notes = app.workspaceFiles.filter((p) => app.isNoteFile(p));
  const projects = new Map<string, { done: string | null; active: string | null }>();
  const keyOf = (p: string) => join(dirname(p), projectName(p, suffix));
  for (const p of notes) if (isDoneFile(p, suffix)) projects.set(keyOf(p), { done: p, active: null });
  for (const p of notes) {
    if (isDoneFile(p, suffix)) continue;
    const k = keyOf(p);
    if (projects.has(k)) projects.get(k)!.active = p;
    else projects.set(k, { done: null, active: p });
  }
  const entries = [...projects.entries()];
  const paths = entries.flatMap(([, v]) => [v.done, v.active].filter((x): x is string => !!x));
  const texts = await app.readFiles(paths);
  const byPath = new Map(paths.map((p, i) => [p, texts[i]]));
  return entries.map(([k, v]) => ({
    project: relative(app.workspace, k).replace(/\\/g, "/"),
    doneText: v.done ? byPath.get(v.done) ?? null : null,
    activeText: v.active ? byPath.get(v.active) ?? null : null,
  }));
}

export async function generateReport(app: App, tag: string | null = null) {
  if (!needFolder(app)) return;
  const y = new Date().getFullYear();
  const choices: { kind: PeriodKind; label: string }[] = [
    { kind: "year", label: `This year (${y})` },
    { kind: "lastYear", label: `Last year (${y - 1})` },
    { kind: "12months", label: "Last 12 months" },
    { kind: "month", label: "This month" },
    { kind: "lastMonth", label: "Last month" },
    { kind: "week", label: "This week" },
    { kind: "lastWeek", label: "Last week" },
    { kind: "all", label: "All time" },
  ];
  openPicker({
    placeholder: tag ? `Report period (${tag})` : "Report period",
    provide: (q) => ({
      items: fuzzyFilter(q, choices, (c) => c.label).map(({ item, result }) => ({
        label: item.label, icon: "chart", positions: result.positions, value: item.kind,
      })),
    }),
    pick: async (it) => {
      const { buildReport, periodFor } = await import("../text/report");
      const period = periodFor(it.value as PeriodKind);
      const md = buildReport(await reportSources(app), app.taskCfg, period, new Date(), { tag });
      app.newDoc({ text: md, title: `Activity report — ${period.label}${tag ? ` ${tag}` : ""}.md`, lang: "markdown" });
    },
  });
}

/** The report limited to one #tag (a client, a topic…). */
export async function generateTagReport(app: App) {
  if (!needFolder(app)) return;
  const counts = new Map<string, number>();
  for (const src of await reportSources(app)) {
    for (const text of [src.doneText, src.activeText]) {
      for (const line of text?.split(/\r\n|\r|\n/) ?? []) for (const t of findTags(line)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  if (!counts.size) {
    toast("No #tag in your notes yet: add one to a task, e.g. \"- call the client #acme - todo\".");
    return;
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  openPicker({
    placeholder: "Report for the tag…",
    provide: (q) => ({
      items: fuzzyFilter(q, tags, (t) => t[0]).map(({ item, result }) => ({
        label: item[0], hint: `${item[1]} line${item[1] > 1 ? "s" : ""}`, icon: "chart", positions: result.positions, value: item[0],
      })),
    }),
    pick: (it) => generateReport(app, it.value as string),
  });
}

/** Ctrl+Shift+U: sets the due date ("@2026-11-14") of the selected tasks. */
export function setDueDate(app: App) {
  const doc = app.active;
  if (!doc || !notesOnly(app, doc)) return;
  const lines = selectedLines(app.view.state).filter((n) => parseTask(app.view.state.doc.line(n).text, app.taskCfg));
  if (!lines.length) {
    toast(`Put the cursor on a task first (${shortcutFor("task.cycle")} turns a line into a task).`);
    return;
  }
  const current = parseTask(app.view.state.doc.line(lines[0]).text, app.taskCfg)?.due ?? null;
  const today = new Date();
  const plus = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return todayISO(d);
  };
  const monday = plus(((8 - today.getDay()) % 7) || 7);
  const endOfMonth = todayISO(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  const presets: { label: string; date: string | null }[] = [
    { label: "Today", date: todayISO(today) },
    { label: "Tomorrow", date: plus(1) },
    { label: "Next Monday", date: monday },
    { label: "In a week", date: plus(7) },
    { label: "In two weeks", date: plus(14) },
    { label: "End of the month", date: endOfMonth },
  ];
  if (current) presets.push({ label: "Remove the due date", date: null });
  openPicker({
    placeholder: "Due date: pick one, or type 2026-11-14, 14/11, +3, 2w…",
    provide: (q) => {
      const typed = q.trim() ? parseDateInput(q) : null;
      const items = typed
        ? [{ label: `Due ${typed}`, icon: "calendar", value: typed }]
        : presets.map((p) => ({ label: p.label, hint: p.date ?? undefined, icon: "calendar", value: p.date }));
      return { items, empty: "Not a date: try 2026-11-14, 14/11, +3 or 2w" };
    },
    pick: (it) => {
      const due = it.value as string | null;
      const state = app.view.state;
      const changes: ChangeSpec[] = [];
      for (const n of lines) {
        const line = state.doc.line(n);
        const edit = setDueInLine(line.text, app.taskCfg, due);
        if (edit) for (const c of edit.changes) changes.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
      }
      if (changes.length) app.applyToDoc(doc, { changes, userEvent: "input.due" });
    },
  });
}
