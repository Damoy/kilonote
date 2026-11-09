// Markdown → DOM for the preview, from the same parser as the editor
// (@lezer/markdown with GitHub extensions). Safe by construction: elements are
// created one by one, raw HTML is shown as text, nothing is loaded from the
// network (images show their description) and links go through the app.

import { GFM, parser as baseParser } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { resolveColor } from "../../core/themes";
import { dueState, isDoneStatus, parseTask, type TaskConfig } from "../../text/tasks";

const parser = baseParser.configure(GFM);

/** Nodes that only carry syntax (*, #, [, `…): never shown. */
const MARKS = new Set([
  "EmphasisMark", "HeaderMark", "LinkMark", "CodeMark", "QuoteMark", "ListMark", "TaskMarker",
  "TableDelimiter", "StrikethroughMark", "LinkTitle", "LinkLabel",
]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", hellip: "…", mdash: "—", ndash: "–" };

function decodeEntity(s: string): string {
  const m = /^&(#x[0-9a-f]+|#\d+|\w+);$/i.exec(s);
  if (!m) return s;
  const v = m[1];
  if (v[0] === "#") {
    const code = v[1].toLowerCase() === "x" ? parseInt(v.slice(2), 16) : parseInt(v.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : s;
  }
  return ENTITIES[v.toLowerCase()] ?? s;
}

export interface RenderOptions {
  taskCfg: TaskConfig;
  today?: string;
  /** The syntax tree of `src`, when the editor already has it (no parsing then). */
  tree?: Tree;
  /** The blocks of the previous rendering, reused when their text did not change. */
  reuse?: BlockCache;
}

/**
 * The rendered top-level blocks of a note, by source text: while typing, only
 * the block being edited is built again, the others are moved over as they are.
 */
export class BlockCache {
  private blocks = new Map<string, Node[][]>();
  take(source: string): Node[] | undefined {
    const list = this.blocks.get(source);
    return list?.shift();
  }
  put(source: string, nodes: Node[]) {
    const list = this.blocks.get(source);
    if (list) list.push(nodes);
    else this.blocks.set(source, [nodes]);
  }
}

/** The note as HTML elements, and the cache of its blocks for the next time. */
export function renderMarkdown(src: string, opts: RenderOptions): HTMLElement {
  return renderMarkdownBlocks(src, opts).root;
}

/** A top-level block of a note: its source text, and how to render it (on demand). */
export interface MarkdownBlock {
  source: string;
  render: () => Node[];
}

/**
 * The top-level blocks of a note, each rendered only when asked: the preview
 * renders the blocks that changed and keeps the others where they are. A block
 * that does not end before the end of `src` (a cut text) is left out.
 */
export function markdownBlocks(src: string, opts: RenderOptions): MarkdownBlock[] {
  const { tree, renderTop } = prepare(src, opts);
  const out: MarkdownBlock[] = [];
  for (let c: SyntaxNode | null = tree.topNode.firstChild; c && c.to <= src.length; c = c.nextSibling) {
    const node = c;
    out.push({ source: src.slice(node.from, node.to), render: () => renderTop(node) });
  }
  return out;
}

export function renderMarkdownBlocks(src: string, opts: RenderOptions): { root: HTMLElement; blocks: BlockCache } {
  const root = document.createElement("div");
  root.className = "md";
  const blocks = new BlockCache();
  for (const b of markdownBlocks(src, opts)) {
    const nodes = opts.reuse?.take(b.source) ?? b.render();
    root.append(...nodes);
    blocks.put(b.source, nodes);
  }
  return { root, blocks };
}

function prepare(src: string, opts: RenderOptions): { tree: Tree; renderTop: (node: SyntaxNode) => Node[] } {
  const tree = opts.tree ?? parser.parse(src);
  const el = (tag: string, cls?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const text = (parent: Node, s: string) => s && parent.appendChild(document.createTextNode(s));

  /** Inline content of `node` limited to [from, to): text between children, children rendered. */
  const inline = (node: SyntaxNode, parent: HTMLElement, from = node.from, to = node.to) => {
    let pos = from;
    for (let c = node.firstChild; c && c.from < to; c = c.nextSibling) {
      if (c.to <= from) continue;
      if (c.from > pos) text(parent, src.slice(pos, c.from));
      renderInline(c, parent);
      pos = c.to;
    }
    if (pos < to) text(parent, src.slice(pos, to));
  };

  const urlOf = (node: SyntaxNode) => {
    const u = node.getChild("URL");
    return u ? src.slice(u.from, u.to).replace(/^<|>$/g, "") : null;
  };

  const link = (parent: HTMLElement, url: string | null) => {
    const a = el("a", "md-link");
    if (url && /^(https?:|mailto:)/i.test(url)) {
      a.dataset.url = url;
      a.title = url;
    } else a.classList.add("md-link-local");
    parent.appendChild(a);
    return a;
  };

  function renderInline(node: SyntaxNode, parent: HTMLElement) {
    const name = node.name;
    if (MARKS.has(name)) return;
    switch (name) {
      case "Emphasis":
        return inline(node, parent.appendChild(el("em")));
      case "StrongEmphasis":
        return inline(node, parent.appendChild(el("strong")));
      case "Strikethrough":
        return inline(node, parent.appendChild(el("del")));
      case "InlineCode": {
        const code = parent.appendChild(el("code"));
        const marks = node.getChildren("CodeMark");
        const from = marks[0]?.to ?? node.from;
        const to = marks[1]?.from ?? node.to;
        return text(code, src.slice(from, to));
      }
      case "Link": {
        const a = link(parent, urlOf(node));
        const marks = node.getChildren("LinkMark");
        // The label sits between "[" and "]".
        return inline(node, a, marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
      }
      case "Autolink":
      case "URL": {
        const url = name === "URL" ? src.slice(node.from, node.to) : urlOf(node);
        const a = link(parent, url);
        return text(a, url ?? "");
      }
      case "Image": {
        // An image element without a source: the view loads it (local files only).
        const marks = node.getChildren("LinkMark");
        const alt = src.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
        const url = urlOf(node);
        if (!url) return text(parent.appendChild(el("span", "md-image")), `🖼 ${alt || "image"}`);
        const img = parent.appendChild(el("img", "md-img")) as HTMLImageElement;
        img.alt = alt || "image";
        img.title = url;
        img.dataset.ref = url;
        return;
      }
      case "Escape":
        return text(parent, src.slice(node.from + 1, node.to));
      case "Entity":
        return text(parent, decodeEntity(src.slice(node.from, node.to)));
      case "HardBreak":
        return void parent.appendChild(el("br"));
      case "Comment":
        return;
      default:
        // HTMLTag and anything unknown: shown as typed.
        if (node.firstChild) return inline(node, parent);
        return text(parent, src.slice(node.from, node.to));
    }
  }

  /** A paragraph; a KiloNote task ("… - todo") gets its status badge. */
  const paragraph = (node: SyntaxNode, parent: HTMLElement, tight: boolean) => {
    const p = tight ? parent : parent.appendChild(el("p"));
    const raw = src.slice(node.from, node.to);
    const task = !raw.includes("\n") ? parseTask(raw, opts.taskCfg) : null;
    if (!task) return inline(node, p);
    const done = isDoneStatus(task.key, opts.taskCfg);
    const body = p.appendChild(el("span", done ? "md-task-text done" : "md-task-text"));
    inline(node, body, node.from + task.textFrom, node.from + task.textTo);
    const badge = p.appendChild(el("span", "md-status"));
    badge.style.setProperty("--c", resolveColor(opts.taskCfg.statuses[task.key]));
    badge.textContent = task.status;
    if (task.due && !done) badge.dataset.due = dueState(task.due, opts.today);
    if (task.stamp) text(p.appendChild(el("span", "md-stamp")), ` ${task.stamp}`);
  };

  const codeBlock = (node: SyntaxNode, parent: HTMLElement) => {
    const pre = parent.appendChild(el("pre"));
    const code = pre.appendChild(el("code"));
    const info = node.getChild("CodeInfo");
    if (info) code.dataset.lang = src.slice(info.from, info.to);
    const parts = node.getChildren("CodeText");
    if (node.name === "FencedCode") text(code, parts.map((c) => src.slice(c.from, c.to)).join(""));
    else {
      // Indented code: strip the indentation of every line.
      text(code, src.slice(node.from, node.to).split("\n").map((l) => l.replace(/^( {4}|\t)/, "")).join("\n"));
    }
  };

  function renderBlock(node: SyntaxNode, parent: HTMLElement, tight = false) {
    const name = node.name;
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      const hEl = parent.appendChild(el(`h${heading[1]}`));
      const marks = node.getChildren("HeaderMark");
      // ATX: "## Title ##" → between the marks; Setext: the line above the underline.
      const from = name.startsWith("ATX") && marks[0] ? marks[0].to : node.from;
      const to = name.startsWith("ATX") ? (marks[1]?.from ?? node.to) : (marks[0]?.from ?? node.to);
      inline(node, hEl, from, to);
      hEl.normalize();
      if (hEl.firstChild?.nodeType === Node.TEXT_NODE) hEl.firstChild.textContent = hEl.firstChild.textContent!.trimStart();
      return;
    }
    switch (name) {
      case "Paragraph":
        return paragraph(node, parent, tight);
      case "BulletList":
      case "OrderedList": {
        const list = parent.appendChild(el(name === "BulletList" ? "ul" : "ol"));
        const first = node.firstChild?.getChild("ListMark");
        if (name === "OrderedList" && first) {
          const n = parseInt(src.slice(first.from, first.to), 10);
          if (n > 1) list.setAttribute("start", String(n));
        }
        // A "tight" list (no blank line between items) has no paragraph spacing.
        const isTight = !/\n[ \t]*\n/.test(src.slice(node.from, node.to).replace(/\n+$/, ""));
        for (let c: SyntaxNode | null = node.firstChild; c; c = c.nextSibling) if (c.name === "ListItem") renderBlock(c, list, isTight);
        return;
      }
      case "ListItem": {
        const li = parent.appendChild(el("li"));
        for (let c: SyntaxNode | null = node.firstChild; c; c = c.nextSibling) {
          if (c.name === "ListMark") continue;
          if (c.name === "Task") {
            li.classList.add("md-checkbox-item");
            const marker = c.getChild("TaskMarker");
            const box = li.appendChild(el("input")) as HTMLInputElement;
            box.type = "checkbox";
            box.disabled = true;
            box.checked = !!marker && /x/i.test(src.slice(marker.from, marker.to));
            inline(c, li, marker ? marker.to : c.from, c.to);
          } else renderBlock(c, li, tight);
        }
        return;
      }
      case "Blockquote": {
        const q = parent.appendChild(el("blockquote"));
        for (let c: SyntaxNode | null = node.firstChild; c; c = c.nextSibling) if (!MARKS.has(c.name)) renderBlock(c, q);
        return;
      }
      case "FencedCode":
      case "CodeBlock":
        return codeBlock(node, parent);
      case "HorizontalRule":
        return void parent.appendChild(el("hr"));
      case "Table": {
        const table = parent.appendChild(el("table"));
        for (let row: SyntaxNode | null = node.firstChild; row; row = row.nextSibling) {
          if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
          const tr = (row.name === "TableHeader" ? table.appendChild(el("thead")) : (table.querySelector("tbody") ?? table.appendChild(el("tbody")))).appendChild(el("tr"));
          for (let cell: SyntaxNode | null = row.firstChild; cell; cell = cell.nextSibling) {
            if (cell.name !== "TableCell") continue;
            inline(cell, tr.appendChild(el(row.name === "TableHeader" ? "th" : "td")));
          }
        }
        return;
      }
      case "HTMLBlock":
      case "CommentBlock":
      case "ProcessingInstructionBlock": {
        // Raw HTML is never interpreted: shown as typed.
        const pre = parent.appendChild(el("pre", "md-html"));
        return text(pre, src.slice(node.from, node.to));
      }
      case "LinkReference":
        return;
      default:
        if (MARKS.has(name)) return;
        if (node.firstChild) for (let c: SyntaxNode | null = node.firstChild; c; c = c.nextSibling) renderBlock(c, parent, tight);
        else text(parent.appendChild(el("p")), src.slice(node.from, node.to));
    }
  }

  const holder = document.createElement("div");
  const renderTop = (node: SyntaxNode): Node[] => {
    renderBlock(node, holder);
    const nodes = [...holder.childNodes];
    holder.replaceChildren();
    return nodes;
  };
  return { tree, renderTop };
}
