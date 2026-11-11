// Note templates, on the app side: a new note from a template, today's note
// (a file of the daily notes folder, made from the "Daily note" template), and
// the templates of the user, files of the `templates` folder of the settings
// directory (one with the name of a built-in template replaces it).

import { basename, extname, join, stem } from "../core/path";
import { fuzzyFilter } from "../core/fuzzy";
import { BUILTIN_TEMPLATES, fillTemplate, isoDate, mergeTemplates, type Template } from "../text/templates";
import { openPicker } from "../ui/palette";
import { prompt, toast } from "../ui/overlay";
import type { App } from "./app";

export const templatesDir = (app: App) => join(app.configDir, "templates");

/** The templates offered: built-in ones and the user's (from the templates folder). */
export async function loadTemplates(app: App): Promise<Template[]> {
  const entries = await app.backend.listDir(templatesDir(app), false).catch(() => []);
  const files = entries.filter((e) => !e.isDir && app.isNoteFile(e.path));
  const texts = await app.readFiles(files.map((e) => e.path));
  const user = files.flatMap((e, i) =>
    texts[i] == null ? [] : [{ name: stem(e.name), text: texts[i]!.replace(/\r\n?/g, "\n"), ext: extname(e.name) || "txt", path: e.path }],
  );
  return mergeTemplates(user);
}

/** Puts the cursor of the active note at `pos`. */
function placeCursor(app: App, pos: number) {
  const anchor = Math.min(pos, app.view.state.doc.length);
  app.view.dispatch({ selection: { anchor }, scrollIntoView: true });
  app.view.focus();
}

/** Picks a template, then calls `use` with it. */
async function pickTemplate(app: App, placeholder: string, use: (t: Template) => unknown, extra?: { label: string; run: () => unknown }) {
  const templates = await loadTemplates(app);
  openPicker({
    placeholder,
    provide: (q) => ({
      items: [
        ...fuzzyFilter(q, templates, (t) => t.name).map(({ item, result }) => ({
          label: item.name,
          detail: item.path ? basename(item.path) : `built-in · .${item.ext}`,
          icon: item.ext === "md" ? "fileMd" : "file",
          positions: result.positions,
          value: item,
        })),
        ...(extra && !q ? [{ label: extra.label, icon: "plus", value: extra }] : []),
      ],
      empty: "No such template",
    }),
    pick: (it) => (it.value === extra ? extra!.run() : use(it.value as Template)),
  });
}

/** File: New note from template… (an unsaved note, filled in now). */
export function newFromTemplate(app: App) {
  return pickTemplate(app, "New note from template…", (t) => {
    const { text, cursor } = fillTemplate(t.text, new Date());
    // (Its title is the file name offered when it is saved: with the template's extension.)
    app.newDoc({ text, lang: t.ext === "md" ? "markdown" : "text", title: `${t.name}.${t.ext}` });
    placeCursor(app, cursor);
  });
}

/** File: Today's note: `<folder>/daily/2026-11-11.txt`, made from the "Daily note" template the first time. */
export async function openDailyNote(app: App) {
  if (!app.workspace) {
    toast(`Open a folder first: today's note is kept in its "${app.settings.daily_notes_folder}" folder.`, {
      action: { label: "Open folder…", run: () => app.openFolder() },
    });
    return;
  }
  const now = new Date();
  const templates = await loadTemplates(app);
  const daily = templates.find((t) => t.name.toLowerCase() === "daily note") ?? BUILTIN_TEMPLATES[0];
  const dir = join(app.workspace, ...app.settings.daily_notes_folder.split(/[\\/]+/).filter(Boolean));
  const date = isoDate(now);
  // Today's note may already exist with another note extension.
  const existing = (await app.backend.listDir(dir, false).catch(() => [])).find((e) => !e.isDir && stem(e.name) === date && app.isNoteFile(e.path));
  if (existing) {
    await app.openFile(existing.path);
    return;
  }
  const path = join(dir, `${date}.${daily.ext}`);
  const { text, cursor } = fillTemplate(daily.text, now, date);
  try {
    await app.backend.createDir(dir);
    await app.backend.createFile(path); // never over an existing file
    await app.backend.writeText(path, text);
  } catch (e) {
    toast(`Could not create today's note: ${e}`, { kind: "error" });
    return;
  }
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
  if (await app.openFile(path)) placeCursor(app, cursor);
}

const TEMPLATE_HELP = "{{date}}, {{time}}, {{weekday}}, {{title}} and {{cursor}} are filled in when a note is made from it.\n";

/** Template: Edit templates… (a built-in one is copied to the templates folder first, then changed there). */
export function editTemplates(app: App) {
  const open = async (path: string, text: string | null) => {
    try {
      await app.backend.createDir(templatesDir(app));
      if (text != null) {
        await app.backend.createFile(path);
        await app.backend.writeText(path, text);
      }
    } catch (e) {
      toast(`Could not create the template: ${e}`, { kind: "error" });
      return;
    }
    await app.openFile(path);
    toast(TEMPLATE_HELP.trim(), { timeout: 6000 });
  };
  return pickTemplate(app, "Edit a template…", (t) => open(t.path ?? join(templatesDir(app), `${t.name}.${t.ext}`), t.path ? null : t.text), {
    label: "New template…",
    run: async () => {
      const r = await prompt({
        title: "New template",
        message: TEMPLATE_HELP,
        placeholder: "Weekly review",
        okLabel: "Create",
        validate: (v) => (!v ? "A name is needed" : /[\\/:*?"<>|]/.test(v) ? "A name without \\ / : * ? \" < > |" : null),
      });
      if (r) await open(join(templatesDir(app), /\.[a-z]+$/i.test(r.value) ? r.value : `${r.value}.txt`), `# {{title}}\n{{date}}\n\n{{cursor}}\n`);
    },
  });
}
