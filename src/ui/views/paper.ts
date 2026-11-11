// A note "on paper": light colors and every style written inline on its
// elements, so that it keeps its looks wherever it goes: pasted into an e-mail
// or a chat (Outlook, Teams…), saved as an HTML page, or printed (and saved as
// a PDF by the print dialog).
// Markdown notes go through the preview's renderer; plain notes are rendered
// line by line, the way the editor shows them (headings, lists, tasks with
// their status). Secrets stay hidden, links lead only to web pages and e-mail
// addresses, and nothing is loaded from the network.

import { findTheme, PALETTE_NAMES } from "../../core/themes";
import { imageRefs } from "../../text/images";
import { noteLinks } from "../../text/links";
import { maskSecrets } from "../../text/secrets";
import { isDoneStatus, parseTask, type TaskConfig } from "../../text/tasks";
import { renderMarkdown } from "./markdown-render";

export interface PaperOptions {
  /** "markdown", "text", or a code language (then shown as code). */
  lang: string;
  taskCfg: TaskConfig;
  today?: string;
  /** An image of the note as a data URL (null: its description is shown). */
  image?: (ref: string) => Promise<string | null>;
  /** A ```mermaid block drawn as an SVG (left as code without it). */
  diagram?: (code: string) => Promise<string>;
}

const C = findTheme("paper", false).colors;
const FONT = `"Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif`;
const MONO = `Consolas, "Cascadia Mono", Menlo, "Courier New", monospace`;

/** A status color of the settings ("blue", "#e91e63") on paper. */
export function paperColor(value: string | undefined): string {
  if (!value) return C.grey;
  if ((PALETTE_NAMES as readonly string[]).includes(value) || value === "accent") return (C as Record<string, string>)[value];
  return /^#[0-9a-f]{3,8}$|^rgb|^hsl/i.test(value) ? value : C.grey;
}

/** Dark text on a light color, white text on a dark one. */
function textOn(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(color)?.[1];
  if (!hex) return "#ffffff";
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#1f1e24" : "#ffffff";
}

/** The style of each element, by tag (then by class, added to it). */
const TAG_STYLE: Record<string, string> = {
  h1: "font-size:1.6em;line-height:1.25;margin:0.6em 0 0.35em;font-weight:700;",
  h2: "font-size:1.3em;line-height:1.3;margin:0.8em 0 0.3em;font-weight:700;",
  h3: "font-size:1.12em;margin:0.8em 0 0.25em;font-weight:700;",
  h4: "font-size:1em;margin:0.7em 0 0.2em;font-weight:700;",
  h5: "font-size:1em;margin:0.7em 0 0.2em;font-weight:600;",
  h6: `font-size:1em;margin:0.7em 0 0.2em;font-weight:600;color:${C.fg_muted};`,
  p: "margin:0 0 0.6em;",
  ul: "margin:0 0 0.6em;padding-left:1.6em;",
  ol: "margin:0 0 0.6em;padding-left:1.6em;",
  li: "margin:0.1em 0;",
  blockquote: `margin:0 0 0.6em;padding:0.1em 0.9em;border-left:3px solid ${C.border};color:${C.fg_muted};`,
  pre: `margin:0 0 0.7em;padding:0.6em 0.8em;background:${C.bg_alt};border:1px solid ${C.border};border-radius:6px;font-family:${MONO};font-size:0.9em;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;`,
  code: `font-family:${MONO};font-size:0.9em;background:${C.bg_alt};padding:0.05em 0.3em;border-radius:4px;`,
  a: `color:${C.blue};text-decoration:underline;`,
  hr: `border:none;border-top:1px solid ${C.border};margin:1em 0;`,
  // (Some e-mail editors do not pass the font on to tables.)
  table: `border-collapse:collapse;margin:0 0 0.7em;font-family:${FONT};font-size:14px;color:${C.fg};`,
  th: `border:1px solid ${C.border};padding:0.3em 0.6em;text-align:left;vertical-align:top;background:${C.bg_alt};font-weight:600;`,
  td: `border:1px solid ${C.border};padding:0.3em 0.6em;text-align:left;vertical-align:top;`,
  img: "max-width:100%;height:auto;",
  del: `color:${C.fg_muted};`,
  figure: "margin:0 0 0.7em;",
};
const CLASS_STYLE: Record<string, string> = {
  "md-task-text done": `text-decoration:line-through;color:${C.fg_muted};`,
  "md-stamp": `color:${C.fg_muted};font-size:0.85em;`,
  "md-image": `color:${C.fg_muted};`,
  "md-note-link": `color:${C.accent};`,
  "md-secret": `color:${C.fg_muted};font-style:italic;`,
  "md-line": "margin:0;",
  "md-blank": "margin:0;",
};

/** The note on paper: a `div` with every style inline. */
export async function renderPaper(src: string, opts: PaperOptions): Promise<HTMLElement> {
  const text = maskSecrets(src.replace(/\r\n?/g, "\n"));
  let body: HTMLElement;
  if (opts.lang === "markdown") body = renderMarkdown(text, { taskCfg: opts.taskCfg, today: opts.today });
  else if (opts.lang === "text") body = renderPlainNote(text, opts.taskCfg);
  else {
    body = document.createElement("div");
    body.appendChild(document.createElement("pre")).textContent = text;
  }
  const root = document.createElement("div");
  root.style.cssText = `font-family:${FONT};font-size:14px;line-height:1.55;color:${C.fg};`;
  root.append(...body.childNodes);
  await finish(root, opts);
  return root;
}

/** Links, check boxes, status badges, images and diagrams, then the styles inline. */
async function finish(root: HTMLElement, opts: PaperOptions) {
  for (const a of root.querySelectorAll<HTMLElement>("a")) {
    const url = a.dataset.url;
    if (url) {
      a.setAttribute("href", url);
      a.removeAttribute("title");
    } else {
      // A link inside the note's folder means nothing elsewhere: its text stays.
      a.replaceWith(...a.childNodes);
    }
  }
  // (The item's text starts with the space after "[x]".)
  for (const box of root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.replaceWith(box.checked ? "☑" : "☐");
  for (const badge of root.querySelectorAll<HTMLElement>(".md-status")) {
    const key = (badge.textContent ?? "").trim().toLowerCase();
    const color = paperColor(opts.taskCfg.statuses[key]);
    badge.removeAttribute("style");
    badge.style.cssText = `background-color:${color};color:${textOn(color)};border-radius:9px;padding:0 0.5em;font-size:0.82em;font-weight:600;white-space:nowrap;`;
    // A space before the badge (the renderer leaves it to the CSS).
    badge.before(" ");
  }
  if (opts.diagram) {
    for (const code of root.querySelectorAll<HTMLElement>("pre > code[data-lang]")) {
      if (!/^mermaid\b/i.test(code.dataset.lang!)) continue;
      const svg = await opts.diagram(code.textContent ?? "").catch(() => null);
      if (!svg) continue;
      const img = document.createElement("img");
      img.alt = "Diagram";
      img.src = svg;
      const figure = document.createElement("figure");
      figure.append(img);
      code.parentElement!.replaceWith(figure);
    }
  }
  await Promise.all(
    [...root.querySelectorAll<HTMLImageElement>("img[data-ref]")].map(async (img) => {
      const url = opts.image ? await opts.image(img.dataset.ref!).catch(() => null) : null;
      if (url) img.src = url;
      else {
        const span = document.createElement("span");
        span.className = "md-image";
        span.textContent = `[${img.alt || "image"}]`;
        img.replaceWith(span);
      }
    }),
  );
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const tag = el.tagName.toLowerCase();
    let style = tag === "code" && el.parentElement?.tagName === "PRE" ? "" : (TAG_STYLE[tag] ?? "");
    style += CLASS_STYLE[el.className] ?? "";
    if (style) el.style.cssText = style + el.style.cssText;
    el.removeAttribute("class");
    for (const name of el.getAttributeNames()) if (name.startsWith("data-") || name === "title" || name === "tabindex") el.removeAttribute(name);
  }
  // Nothing after the last block: no blank space at the end of an e-mail.
  const last = root.lastElementChild as HTMLElement | null;
  if (last) last.style.marginBottom = "0";
}

// --- Plain notes ---------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const HR = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;
const INLINE = /`[^`\n]+`|\*\*[^*\n]+\*\*|\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]|\[\[[^[\]\n]+\]\]/g;
const SECRET_LINE = /^🔒 Encrypted secret\s*$/;
/** `![description](images/shot.png)` (the path may be written `<with spaces.png>`). */
const IMAGE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

/** A plain note, line by line: a line stays a line, as in the editor. */
export function renderPlainNote(text: string, cfg: TaskConfig): HTMLElement {
  const root = document.createElement("div");
  const el = (tag: string, cls?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  /** The lists being filled: one per indentation level. */
  let lists: { indent: number; ordered: boolean; list: HTMLElement }[] = [];
  /** The lines of the code block being read (null: not in one). */
  let code: string[] | null = null;

  const content = (parent: HTMLElement, line: string) => {
    const task = line.length > 4 ? parseTask(line, cfg) : null;
    if (!task) return inline(parent, line);
    const done = isDoneStatus(task.key, cfg);
    inline(parent.appendChild(el("span", done ? "md-task-text done" : "md-task-text")), line.slice(task.textFrom, task.textTo));
    parent.appendChild(el("span", "md-status")).textContent = task.status;
    if (task.stamp) parent.appendChild(el("span", "md-stamp")).textContent = ` ${task.stamp}`;
  };

  const inline = (parent: HTMLElement, s: string) => {
    let pos = 0;
    for (const m of s.matchAll(INLINE)) {
      if (m.index > pos) parent.append(s.slice(pos, m.index));
      const t = m[0];
      if (t[0] === "`") parent.appendChild(el("code")).textContent = t.slice(1, -1);
      else if (t.startsWith("**")) parent.appendChild(el("strong")).textContent = t.slice(2, -2);
      else if (t.startsWith("[[")) {
        const link = noteLinks(t)[0];
        const label = /\|([^\]]*)\]\]$/.exec(t)?.[1]?.trim();
        parent.appendChild(el("span", "md-note-link")).textContent = label || link?.target || t;
      } else {
        const a = parent.appendChild(el("a"));
        a.dataset.url = t;
        a.textContent = t;
      }
      pos = m.index + t.length;
    }
    if (pos < s.length) parent.append(s.slice(pos));
  };

  const blocks: (() => void)[] = [];

  /** Leading spaces kept (a plain note uses them to indent). */
  const indented = (line: string) => line.replace(/^[ \t]+/, (ws) => " ".repeat(ws.replace(/\t/g, "    ").length));

  for (const line of text.split("\n")) {
    if (code) {
      if (FENCE.test(line)) code = null;
      else code.push(line);
      continue;
    }
    if (FENCE.test(line)) {
      lists = [];
      const lines: string[] = (code = []);
      // (Filled as the lines come; written once the note is read.)
      const pre = root.appendChild(el("pre"));
      blocks.push(() => (pre.textContent = lines.join("\n")));
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && !HR.test(line)) {
      const indent = bullet[1].replace(/\t/g, "    ").length;
      const ordered = /\d/.test(bullet[2]);
      // Back to a shallower level, or another kind of list at the same level: the list above ends.
      const ends = (l: { indent: number; ordered: boolean }) => l.indent > indent || (l.indent === indent && l.ordered !== ordered);
      while (lists.length && ends(lists[lists.length - 1])) lists.pop();
      let top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        const list = el(ordered ? "ol" : "ul");
        if (ordered && parseInt(bullet[2], 10) > 1) list.setAttribute("start", String(parseInt(bullet[2], 10)));
        // A deeper list goes inside the item above it.
        (top?.list.lastElementChild ?? root).appendChild(list);
        lists.push((top = { indent, ordered, list }));
      }
      const li = top.list.appendChild(el("li"));
      content(li, bullet[3]);
      continue;
    }
    lists = [];
    const heading = HEADING.exec(line);
    if (heading) inline(root.appendChild(el(`h${heading[1].length}`)), heading[2]);
    else if (HR.test(line)) root.appendChild(el("hr"));
    else if (!line.trim()) root.appendChild(el("p", "md-blank")).append(" ");
    else if (SECRET_LINE.test(line)) root.appendChild(el("p", "md-secret")).textContent = line.trim();
    else {
      const refs = imageRefs(line);
      if (refs.length && !line.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "").trim()) {
        const p = root.appendChild(el("p", "md-line"));
        for (const m of line.matchAll(IMAGE)) {
          const img = p.appendChild(el("img")) as HTMLImageElement;
          img.alt = m[1] || "image";
          img.dataset.ref = m[2] ?? m[3];
        }
      } else content(root.appendChild(el("p", "md-line")), indented(line));
    }
  }
  for (const fill of blocks) fill();
  return root;
}

/** A whole HTML page with the note: for a file, or to print. */
export function paperDocument(note: HTMLElement, title: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="KiloNote">
<title>${esc(title)}</title>
<style>
body { margin: 0; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { max-width: 820px; margin: 0 auto; padding: 40px 28px 56px; }
@media print { .page { max-width: none; padding: 0; } }
</style>
</head>
<body>
<div class="page">
${note.outerHTML}
</div>
</body>
</html>
`;
}
