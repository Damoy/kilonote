// Tab bar: per-tab colors, browser-style collapsible groups,
// mouse drag and drop (pointer events, works in WebView2 and WebKit).

import type { App, Doc, TabGroup } from "../app";
import { shortcutFor, titleWithKey } from "../core/commands";
import { isDoneFile, relative } from "../core/path";
import { resolveColor } from "../core/themes";
import { h, icon } from "./dom";
import { showMenu, type MenuItem } from "./overlay";

export class TabBar {
  private scroller: HTMLElement;
  private dragging: { doc: Doc; el: HTMLElement; startX: number; offset: number; active: boolean; pointerId: number } | null = null;
  private marker = h("div", { class: "kn-tab-marker" });

  constructor(private app: App, private el: HTMLElement) {
    this.scroller = h("div", { class: "kn-tabs" });
    const actions = h(
      "div",
      { class: "kn-tabbar-actions" },
      h("button", { class: "kn-icon-btn", title: titleWithKey("New note", "file.new"), onclick: () => app.newDoc() }, icon("plus")),
      h("button", { class: "kn-icon-btn", title: titleWithKey("Command palette", "palette.commands"), onclick: () => app.openCommandPalette() }, icon("more")),
    );
    el.append(this.scroller, actions);
    this.scroller.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    this.scroller.addEventListener("dblclick", (e) => {
      if (e.target === this.scroller) app.newDoc();
    });
    app.on("docs", () => this.render());
    app.on("active", () => this.render());
    app.on("settings", () => this.render());
  }

  render() {
    if (this.dragging?.active) return;
    const app = this.app;
    this.scroller.replaceChildren();
    const seenGroups = new Set<string>();
    for (const doc of app.docs) {
      const group = doc.groupId ? app.groups.find((g) => g.id === doc.groupId) : undefined;
      if (group && !seenGroups.has(group.id)) {
        seenGroups.add(group.id);
        this.scroller.append(this.renderGroupChip(group));
      }
      if (group?.collapsed && doc !== app.active) continue;
      this.scroller.append(this.renderTab(doc, group));
    }
    const activeEl = this.scroller.querySelector<HTMLElement>(".kn-tab.active");
    activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderGroupChip(group: TabGroup) {
    const count = this.app.docs.filter((d) => d.groupId === group.id).length;
    const chip = h(
      "div",
      {
        class: `kn-group-chip${group.collapsed ? " collapsed" : ""}`,
        style: { "--g": resolveColor(group.color) },
        title: `${group.name || "Group"} — click to ${group.collapsed ? "expand" : "collapse"}`,
      },
      h("span", { class: "kn-group-name" }, group.name || " "),
      group.collapsed ? h("span", { class: "kn-group-count" }, String(count)) : null,
    );
    chip.addEventListener("click", () => this.app.toggleGroup(group));
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showGroupMenu(group, e.clientX, e.clientY);
    });
    return chip;
  }

  private renderTab(doc: Doc, group?: TabGroup) {
    const app = this.app;
    const isActive = doc === app.active;
    const done = doc.path && isDoneFile(doc.path, app.settings.archive_suffix);
    const tab = h(
      "div",
      {
        class: `kn-tab${isActive ? " active" : ""}${doc.dirty ? " dirty" : ""}${doc.missing ? " missing" : ""}${group ? " grouped" : ""}${doc.color ? " colored" : ""}`,
        style: { "--tab-c": doc.color ? resolveColor(doc.color) : null, "--g": group ? resolveColor(group.color) : null },
        title: doc.path ? relative(app.workspace, doc.path) : `${doc.title} (unsaved)`,
        role: "tab",
      },
      done ? icon("fileDone", "kn-tab-icon") : null,
      h("span", { class: "kn-tab-name" }, app.docName(doc)),
      h("button", { class: "kn-tab-close", title: "Close", tabindex: "-1" }, h("span", { class: "kn-tab-dirty" }), icon("x")),
    );
    tab.querySelector(".kn-tab-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void app.closeDoc(doc);
    });
    tab.addEventListener("pointerdown", (e) => this.onPointerDown(e, doc, tab));
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void app.closeDoc(doc);
      }
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showTabMenu(doc, e.clientX, e.clientY);
    });
    return tab;
  }

  // ---------------------------------------------------------------------------
  // Drag and drop

  private onPointerDown(e: PointerEvent, doc: Doc, el: HTMLElement) {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".kn-tab-close")) return;
    this.app.activate(doc);
    const fresh = this.scroller.querySelector<HTMLElement>(".kn-tab.active") ?? el;
    this.dragging = { doc, el: fresh, startX: e.clientX, offset: 0, active: false, pointerId: e.pointerId };
    const move = (ev: PointerEvent) => this.onPointerMove(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.onPointerUp();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.dragging;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.active) {
      if (Math.abs(dx) < 5) return;
      d.active = true;
      d.el.classList.add("dragging");
      this.el.classList.add("is-dragging");
      this.scroller.append(this.marker);
    }
    d.el.style.transform = `translateX(${dx}px)`;
    const target = this.dropIndex(e.clientX);
    const tabs = this.tabElements();
    const ref = tabs[target.visualIndex];
    const box = this.scroller.getBoundingClientRect();
    const x = ref ? ref.getBoundingClientRect().left : (tabs[tabs.length - 1]?.getBoundingClientRect().right ?? box.left);
    this.marker.style.left = `${x - box.left + this.scroller.scrollLeft - 1}px`;
  }

  private tabElements() {
    return [...this.scroller.querySelectorAll<HTMLElement>(".kn-tab")];
  }

  /** Insertion index in app.docs for the given mouse position. */
  private dropIndex(clientX: number): { docIndex: number; visualIndex: number } {
    const tabs = this.tabElements();
    const visibleDocs = this.app.docs.filter((d) => {
      const g = d.groupId ? this.app.groups.find((x) => x.id === d.groupId) : null;
      return !g?.collapsed || d === this.app.active;
    });
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return { docIndex: this.app.docs.indexOf(visibleDocs[i]), visualIndex: i };
    }
    return { docIndex: this.app.docs.length, visualIndex: tabs.length };
  }

  private onPointerUp() {
    const d = this.dragging;
    if (!d) return;
    if (d.active) {
      const pointerX = d.startX + (parseFloat(d.el.style.transform.replace(/[^\d.-]/g, "")) || 0);
      const { docIndex } = this.dropIndex(pointerX);
      d.el.style.transform = "";
      d.el.classList.remove("dragging");
      this.el.classList.remove("is-dragging");
      this.marker.remove();
      this.dragging = null;
      this.app.moveDoc(d.doc, docIndex);
    } else this.dragging = null;
    this.app.focusEditor();
  }

  // ---------------------------------------------------------------------------
  // Menus

  showColorMenu(doc: Doc) {
    const r = this.scroller.querySelector(".kn-tab.active")?.getBoundingClientRect();
    showMenu(
      [{ header: "Tab color" }, { colors: this.app.settings.tab_colors, selected: doc.color, allowNone: true, onPick: (c) => this.setColor(doc, c) }],
      r?.left ?? 100,
      r?.bottom ?? 40,
    );
  }

  private setColor(doc: Doc, color: string | null) {
    doc.color = color;
    this.app.emit("docs");
  }

  private showTabMenu(doc: Doc, x: number, y: number) {
    const app = this.app;
    const idx = app.docs.indexOf(doc);
    const items: MenuItem[] = [
      { label: "Close", icon: "x", shortcut: shortcutFor("tab.close"), action: () => app.closeDoc(doc) },
      { label: "Close others", action: () => app.closeMany(app.docs.filter((d) => d !== doc)) },
      { label: "Close tabs to the right", disabled: idx === app.docs.length - 1, action: () => app.closeMany(app.docs.slice(idx + 1)) },
      { separator: true },
      { header: "Color" },
      { colors: app.settings.tab_colors, selected: doc.color, allowNone: true, onPick: (c) => this.setColor(doc, c) },
      { separator: true },
      { label: "Add to new group…", icon: "plus", action: () => app.createGroup([doc]) },
    ];
    for (const g of app.groups) {
      if (g.id === doc.groupId) continue;
      items.push({ label: `Add to "${g.name || "unnamed group"}"`, color: g.color, action: () => app.addToGroup(doc, g.id) });
    }
    if (doc.groupId) items.push({ label: "Remove from group", action: () => app.addToGroup(doc, null) });
    if (doc.path) {
      const path = doc.path;
      items.push(
        { separator: true },
        { label: "Copy path", action: () => app.copyText(path) },
        { label: "Reveal in file manager", icon: "folderOpen", action: () => app.backend.reveal(path) },
        { label: "Rename…", action: () => app.renamePath(path) },
      );
    }
    showMenu(items, x, y);
  }

  private showGroupMenu(group: TabGroup, x: number, y: number) {
    const app = this.app;
    const members = app.docs.filter((d) => d.groupId === group.id);
    showMenu(
      [
        { header: group.name || "Group" },
        { label: "Rename / color…", icon: "palette", action: () => app.editGroup(group) },
        { colors: app.settings.tab_colors, selected: group.color, onPick: (c) => { if (c) group.color = c; app.emit("docs"); } },
        { label: group.collapsed ? "Expand" : "Collapse", icon: group.collapsed ? "chevronDown" : "collapse", action: () => app.toggleGroup(group) },
        { label: "New note in this group", icon: "plus", action: () => app.newDoc({ groupId: group.id }) },
        { separator: true },
        { label: "Ungroup", action: () => app.ungroup(group) },
        { label: `Close group (${members.length})`, danger: true, icon: "x", action: () => app.closeMany(members) },
      ],
      x,
      y,
    );
  }
}
