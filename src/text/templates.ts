// Note templates: the text a new note starts with. Placeholders are filled in
// when the note is made:
//   {{date}} 2026-11-11   {{time}} 14:05   {{weekday}} Wednesday
//   {{title}} the name of the note   {{cursor}} where the cursor goes

export interface Template {
  name: string;
  text: string;
  /** Extension of the notes made from it. */
  ext: string;
  /** The file of a template of the user (null: a built-in one). */
  path: string | null;
}

export const BUILTIN_TEMPLATES: readonly Template[] = [
  {
    name: "Daily note",
    ext: "txt",
    path: null,
    text: "# {{weekday}} {{date}}\n\n## Today\n- {{cursor}} - todo\n\n## Notes\n\n",
  },
  {
    name: "Meeting notes",
    ext: "txt",
    path: null,
    text: "# Meeting: {{cursor}}\n{{date}} {{time}}\n\n## Attendees\n- \n\n## Agenda\n- \n\n## Notes\n\n\n## Actions\n- first action - todo\n",
  },
  {
    name: "Project",
    ext: "txt",
    path: null,
    text: "# {{cursor}}\nStarted {{date}}\n\n## Goal\n\n\n## Tasks\n- first step - todo\n\n## Links\n\n",
  },
  {
    name: "Markdown page",
    ext: "md",
    path: null,
    text: "# {{cursor}}\n\n_{{date}}_\n\n## Summary\n\n\n## Details\n\n| Item | Notes |\n| --- | --- |\n|  |  |\n",
  },
];

const p2 = (n: number) => String(n).padStart(2, "0");

/** `2026-11-11` (local time). */
export function isoDate(at: Date): string {
  return `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}`;
}

/** The text of a new note made from a template, and where its cursor goes. */
export function fillTemplate(text: string, at: Date, title = ""): { text: string; cursor: number } {
  const values: Record<string, string> = {
    date: isoDate(at),
    time: `${p2(at.getHours())}:${p2(at.getMinutes())}`,
    weekday: at.toLocaleDateString("en-US", { weekday: "long" }),
    title,
  };
  let out = "";
  let cursor = -1;
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*(date|time|weekday|title|cursor)\s*\}\}/gi)) {
    out += text.slice(last, m.index);
    const key = m[1].toLowerCase();
    if (key !== "cursor") out += values[key];
    else if (cursor < 0) cursor = out.length;
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return { text: out, cursor: cursor < 0 ? out.length : cursor };
}

/**
 * The templates offered: the built-in ones, replaced by a template of the user
 * with the same name, then the user's other templates (by name).
 */
export function mergeTemplates(user: Template[]): Template[] {
  const key = (t: Template) => t.name.toLowerCase();
  const mine = new Map(user.map((t) => [key(t), t]));
  const builtins = BUILTIN_TEMPLATES.map((t) => mine.get(key(t)) ?? t);
  const others = user.filter((t) => !BUILTIN_TEMPLATES.some((b) => key(b) === key(t))).sort((a, b) => a.name.localeCompare(b.name));
  return [...builtins, ...others];
}
