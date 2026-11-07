// Tree view of a JSON or YAML document, next to the editor.
// Hover a node: its text is highlighted in the editor. Click: the editor goes
// there. Double-click (or Enter / F2): edit a value or rename a key in place.
// The tree follows the cursor of the editor.

import type { Text } from "@codemirror/state";
import type { App, Doc } from "../../app/app";
import { setTreeHighlight } from "../../editor/setup";
import { keySource, nodePath, parseTree, valueSource, xmlPath, type ParsedTree, type TreeFormat, type TreeNode } from "../../text/tree-parse";
import { h, icon } from "../dom";
import { showMenu, toast } from "../overlay";

/** Children shown at first in a big array or object ("Show more" for the rest). */
const PAGE = 200;
/** Above this size, no tree (parsing at every pause in typing would be too slow). */
export const MAX_TREE_SIZE = 8 * 1024 * 1024;

interface Row {
  node: TreeNode;
  chain: TreeNode[];
  id: string;
  depth: number;
  el: HTMLElement;
}

const SEP = "\u0001";
/** XML siblings may share a name: their position tells them apart. */
let byIndex = false;
const childId = (parent: string, n: TreeNode, i: number) => parent + SEP + (byIndex ? `${i}:` : "") + String(n.key);

export class TreeView {
  readonly el: HTMLElement;
  private body = h("div", { class: "tv-body", tabindex: "0", role: "tree" });
  private status = h("div", { class: "tv-status" });
  private title = h("span", { class: "tv-title" });
  private doc: Doc | null = null;
  private tree: ParsedTree | null = null;
  /** The text the tree was read from: its positions are only valid for it. */
  private source: Text | null = null;
  /** The text has an error: the last good tree is shown, read-only. */
  private stale = false;
  private rows: Row[] = [];
  private focused = -1;
  private current: string | null = null;
  private editing = false;
  /** Expanded nodes and page sizes, per document. */
  private expanded = new Map<number, Set<string>>();
  private limits = new Map<string, number>();
  private renderToken = 0;

  constructor(private app: App) {
    const tools = h("div", { class: "tv-tools" },
      this.title,
      h("span", { class: "kn-spacer" }),
      h("button", { class: "kn-icon-btn", title: "Expand all", onclick: () => this.expandAll(true) }, icon("expand")),
      h("button", { class: "kn-icon-btn", title: "Collapse all", onclick: () => this.expandAll(false) }, icon("collapse")),
    );
    this.el = h("div", { class: "tv" }, tools, this.status, this.body);
    this.body.addEventListener("keydown", (e) => this.onKey(e));
    this.body.addEventListener("mouseleave", () => this.highlight(null));
  }

  private get open(): Set<string> {
    const id = this.doc?.id ?? 0;
    let set = this.expanded.get(id);
    if (!set) this.expanded.set(id, (set = new Set()));
    return set;
  }

  /** Parses the document again and redraws (keeps what was expanded). */
  async render(doc: Doc, source: Text, format: TreeFormat) {
    const token = ++this.renderToken;
    if (source.length > MAX_TREE_SIZE) {
      this.doc = doc;
      this.tree = null;
      this.source = null;
      this.title.textContent = format.toUpperCase();
      this.status.hidden = true;
      this.rows = [];
      this.body.replaceChildren(h("div", { class: "tv-empty" }, `This file is too large for the tree view (${Math.round(source.length / 1024 / 1024)} MB).`));
      return;
    }
    const tree = await parseTree(source.toString(), format);
    if (token !== this.renderToken || this.editing) return;
    byIndex = format === "xml";
    const first = !this.expanded.has(doc.id);
    // While the text has an error (often: in the middle of typing), the last
    // good tree of the same document stays, dimmed and read-only.
    const keep = !!tree.error && !tree.roots.length && this.doc === doc && !!this.tree?.roots.length && this.tree.format === format;
    this.stale = keep;
    this.doc = doc;
    if (!keep) {
      this.tree = tree;
      this.source = source;
    } else this.tree = { ...this.tree!, error: tree.error };
    if (first) {
      // The first look: the root and its direct children open.
      for (const r of tree.roots) {
        const id = String(r.key);
        this.open.add(id);
        if ((r.children?.length ?? 0) <= 30) (r.children ?? []).forEach((c, i) => c.children && this.open.add(childId(id, c, i)));
      }
    }
    this.title.textContent = format.toUpperCase();
    if (tree.error) {
      const pos = tree.error.pos;
      this.status.replaceChildren(icon("x"), h("span", {}, tree.error.message),
        h("button", { class: "kn-btn subtle", onclick: () => this.reveal(pos, pos, true) }, "Go to"));
      this.status.hidden = false;
    } else this.status.hidden = true;
    this.draw();
  }

  private draw() {
    const tree = this.tree;
    if (!tree) return;
    const focusedId = this.rows[this.focused]?.id;
    const top = this.body.scrollTop;
    this.rows = [];
    const frag = document.createDocumentFragment();
    const walk = (n: TreeNode, chain: TreeNode[], id: string, depth: number) => {
      const row = this.row(n, [...chain, n], id, depth);
      frag.append(row.el);
      this.rows.push(row);
      if (!n.children || !this.open.has(id)) return;
      const limit = this.limits.get(`${this.doc?.id}:${id}`) ?? PAGE;
      n.children.slice(0, limit).forEach((c, i) => walk(c, [...chain, n], childId(id, c, i), depth + 1));
      if (n.children.length > limit) {
        const more = h("div", { class: "tv-row tv-more", style: { paddingLeft: `${(depth + 1) * 14 + 22}px` } },
          `Show ${Math.min(PAGE * 5, n.children.length - limit)} more of ${n.children.length - limit}…`);
        more.addEventListener("click", () => {
          this.limits.set(`${this.doc?.id}:${id}`, limit + PAGE * 5);
          this.draw();
        });
        frag.append(more);
      }
    };
    for (const r of tree.roots) walk(r, [], String(r.key), 0);
    if (!tree.roots.length && !tree.error) frag.append(h("div", { class: "tv-empty" }, "Empty document"));
    this.body.replaceChildren(frag);
    this.body.classList.toggle("stale", this.stale);
    this.body.scrollTop = top;
    this.focused = focusedId ? this.rows.findIndex((r) => r.id === focusedId) : -1;
    this.rows[this.focused]?.el.classList.add("focused");
    this.markCurrent();
  }

  private row(n: TreeNode, chain: TreeNode[], id: string, depth: number): Row {
    const isOpen = this.open.has(id);
    const el = h("div", { class: `tv-row${n.children ? " tv-branch" : ""}`, role: "treeitem", style: { paddingLeft: `${depth * 14 + 4}px` } });
    if (n.children) el.setAttribute("aria-expanded", String(isOpen));
    const toggle = n.children ? icon("chevron", `tv-toggle${isOpen ? " open" : ""}`) : h("span", { class: "tv-toggle" });
    el.append(toggle);
    if (n.key !== null) {
      const key = typeof n.key === "number" ? h("span", { class: "tv-index" }, String(n.key)) : h("span", { class: n.isDocument ? "tv-doc" : "tv-key" }, n.key);
      el.append(key);
      if (!n.isDocument) el.append(h("span", { class: "tv-colon" }, ":"));
      if (n.keyEditable) key.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.edit(this.rows.findIndex((r) => r.id === id), "key");
      });
    }
    if (n.children) {
      const count = n.children.length;
      el.append(h("span", { class: "tv-summary" }, n.type === "array" ? `[${count}]` : `{${count}}`));
    } else {
      const shown = n.type === "string" ? JSON.stringify(n.text ?? "") : (n.text ?? "");
      el.append(h("span", { class: `tv-val tv-${n.type}`, title: n.editable ? "Double-click to edit" : "" }, shown.length > 300 ? shown.slice(0, 300) + "…" : shown));
    }
    const row: Row = { node: n, chain, id, depth, el };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle(id);
    });
    el.addEventListener("mouseenter", () => this.highlight(n));
    el.addEventListener("click", () => {
      this.setFocus(this.rows.indexOf(row));
      this.reveal(n.from, n.to, false);
    });
    el.addEventListener("dblclick", () => {
      if (n.children) this.toggle(id);
      else this.edit(this.rows.indexOf(row), "value");
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.setFocus(this.rows.indexOf(row));
      this.menu(row, e.clientX, e.clientY);
    });
    return row;
  }

  // -------------------------------------------------------------------------

  private toggle(id: string, open = !this.open.has(id)) {
    if (open) this.open.add(id);
    else this.open.delete(id);
    this.draw();
  }

  private expandAll(open: boolean) {
    if (!this.tree) return;
    const set = this.open;
    set.clear();
    if (open) {
      let count = 0;
      const walk = (n: TreeNode, id: string) => {
        if (!n.children || count > 5000) return;
        set.add(id);
        count += n.children.length;
        n.children.forEach((c, i) => walk(c, childId(id, c, i)));
      };
      for (const r of this.tree.roots) walk(r, String(r.key));
    } else for (const r of this.tree.roots) set.add(String(r.key));
    this.draw();
  }

  private setFocus(i: number) {
    this.rows[this.focused]?.el.classList.remove("focused");
    this.focused = Math.max(0, Math.min(i, this.rows.length - 1));
    const row = this.rows[this.focused];
    row?.el.classList.add("focused");
    row?.el.scrollIntoView({ block: "nearest" });
    this.body.focus({ preventScroll: true });
  }

  /** Selects a node's text in the editor (and focuses the editor when asked). */
  private reveal(from: number, to: number, focus: boolean) {
    const doc = this.doc;
    if (!doc || doc !== this.app.active) return;
    const len = this.app.view.state.doc.length;
    this.app.view.dispatch({
      selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
      scrollIntoView: true,
    });
    if (focus) this.app.focusEditor();
  }

  private highlight(n: TreeNode | null) {
    if (this.doc !== this.app.active || !this.app.active) return;
    const range = n && n.to > n.from ? { from: n.from, to: n.to } : null;
    this.app.view.dispatch({ effects: setTreeHighlight.of(range) });
  }

  /** The node under the editor's cursor, shown (its parents expanded) and marked. */
  followCursor(pos: number) {
    if (!this.tree || this.editing) return;
    let best: { node: TreeNode; id: string; ancestors: string[] } | null = null;
    const walk = (n: TreeNode, id: string, ancestors: string[]) => {
      if (pos < n.from || pos > n.to) {
        // A key belongs to its member too.
        if (n.keyFrom === undefined || pos < n.keyFrom || pos > n.to) return;
      }
      best = { node: n, id, ancestors };
      (n.children ?? []).forEach((c, i) => walk(c, childId(id, c, i), [...ancestors, id]));
    };
    for (const r of this.tree.roots) walk(r, String(r.key), []);
    const found = best as { id: string; ancestors: string[] } | null;
    if (!found || found.id === this.current) return;
    this.current = found.id;
    let changed = false;
    for (const a of found.ancestors) if (!this.open.has(a)) (this.open.add(a), (changed = true));
    if (changed) this.draw();
    else this.markCurrent();
    this.rows.find((r) => r.id === this.current)?.el.scrollIntoView({ block: "nearest" });
  }

  private markCurrent() {
    for (const r of this.rows) r.el.classList.toggle("current", r.id === this.current);
  }

  // -------------------------------------------------------------------------
  // Editing

  private edit(i: number, what: "value" | "key") {
    const row = this.rows[i];
    const doc = this.doc;
    const tree = this.tree;
    if (!row || !doc || !tree || this.editing) return;
    const n = row.node;
    if (this.stale || this.app.view.state.doc !== this.source) {
      toast(this.stale ? "Fix the error in the text first: the tree shows its last valid version." : "The text just changed: try again in a moment.");
      return;
    }
    if (what === "value" && !n.editable) {
      if (n.children) this.toggle(row.id);
      else {
        toast(n.type === "alias" ? "An alias is edited in the text." : n.type === "null" && tree.format === "xml" ? "An empty element (<name/>) is edited in the text." : "Multi-line values are edited in the text.");
        this.reveal(n.from, n.to, true);
      }
      return;
    }
    if (what === "key" && !n.keyEditable) return;
    const target = row.el.querySelector<HTMLElement>(what === "key" ? ".tv-key" : ".tv-val");
    if (!target) return;
    this.setFocus(i);
    this.editing = true;
    const original = what === "key" ? String(n.key) : n.type === "string" ? (n.text ?? "") : (n.text ?? "");
    const input = h("input", { class: "kn-input tv-edit", type: "text", spellcheck: "false" }) as HTMLInputElement;
    input.value = original;
    target.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      // The positions are those of the text the tree was read from: if it
      // changed in the meantime (typing, reload), nothing is written.
      const fresh = this.app.view.state.doc === this.source;
      if (commit && input.value !== original && !fresh) toast("The text changed while you were editing: the change was not applied.", { kind: "error" });
      if (commit && input.value !== original && doc === this.app.active && fresh) {
        const from = what === "key" ? n.keyFrom! : n.from;
        const to = what === "key" ? n.keyTo! : n.to;
        const insert = what === "key" ? keySource(n, input.value, tree.format) : valueSource(n, input.value, tree.format);
        this.app.applyToDoc(doc, { changes: { from, to, insert }, userEvent: "input.tree" });
        // The preview redraws the tree from the new text.
      } else this.app.preview.update(true); // (a redraw may have been skipped while editing)
      this.body.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private menu(row: Row, x: number, y: number) {
    const n = row.node;
    const i = this.rows.indexOf(row);
    const path = this.tree?.format === "xml" ? xmlPath(row.chain) : nodePath(row.chain);
    const src = this.app.view.state.sliceDoc(n.from, n.to);
    showMenu(
      [
        { label: "Edit value", icon: "replace", shortcut: "Enter", disabled: !n.editable, action: () => this.edit(i, "value") },
        { label: "Rename key", disabled: !n.keyEditable, shortcut: "F2", action: () => this.edit(i, "key") },
        { separator: true },
        { label: "Go to in the text", icon: "chevron", action: () => this.reveal(n.from, n.to, true) },
        { label: "Copy path", icon: "files", disabled: !path, action: () => this.app.copyText(path, "Path copied") },
        { label: "Copy value", icon: "files", action: () => this.app.copyText(src, "Value copied") },
        ...(n.children ? [
          { separator: true } as const,
          { label: "Expand everything inside", icon: "expand", action: () => this.expandBelow(row) },
        ] : []),
      ],
      x,
      y,
    );
  }

  private expandBelow(row: Row) {
    const walk = (n: TreeNode, id: string) => {
      if (!n.children) return;
      this.open.add(id);
      n.children.forEach((c, i) => walk(c, childId(id, c, i)));
    };
    walk(row.node, row.id);
    this.draw();
  }

  private onKey(e: KeyboardEvent) {
    if (this.editing) return;
    const row = this.rows[this.focused];
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        this.setFocus(this.focused + 1);
        break;
      case "ArrowUp":
        this.setFocus(this.focused - 1);
        break;
      case "Home":
        this.setFocus(0);
        break;
      case "End":
        this.setFocus(this.rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.node.children && !this.open.has(row.id)) this.toggle(row.id, true);
        else this.setFocus(this.focused + 1);
        break;
      case "ArrowLeft":
        if (row?.node.children && this.open.has(row.id)) this.toggle(row.id, false);
        else if (row) {
          const parent = row.id.slice(0, row.id.lastIndexOf(SEP));
          const p = this.rows.findIndex((r) => r.id === parent);
          if (p >= 0) this.setFocus(p);
        }
        break;
      case "Enter":
        if (row) this.edit(this.focused, "value");
        break;
      case "F2":
        if (row) this.edit(this.focused, row.node.keyEditable ? "key" : "value");
        break;
      case "Escape":
        this.app.focusEditor();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      const cur = this.rows[this.focused];
      if (cur && e.key.startsWith("Arrow")) {
        this.highlight(cur.node);
        this.reveal(cur.node.from, cur.node.to, false);
      }
    }
  }
}
