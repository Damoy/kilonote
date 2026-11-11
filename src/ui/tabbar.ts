// Tab bar: per-tab colors, browser-style collapsible groups,
// mouse drag and drop (pointer events, works in WebView2 and WebKit).

import type { App, Doc, TabGroup } from "../app/app";
import { shortcutFor, titleWithKey } from "../core/commands";
import { isDoneFile, relative } from "../core/path";
import { resolveColor } from "../core/themes";
import { h, icon } from "./dom";
import { fileIcon } from "./sidebar";
import { SIDE_LABELS, sideKindFor } from "./views/preview";
import { showMenu, type MenuItem } from "./overlay";
import { copyText, renamePath } from "../app/files";
import { openCommandPalette } from "../app/pickers";
import { dropTabOutside, moveToNewWindow } from "../app/windows";

export class TabBar {
  private scroller: HTMLElement;
  private dragging: {
    doc: Doc; el: HTMLElement; startX: number; offset: number; active: boolean; pointerId: number; outside: boolean;
  } | null = null;
  private marker = h("div", { class: "kn-tab-marker" });
  private wasCollapsed = new Set<string>();
  private listBtn: HTMLElement;
  /** Preview / tree view of the active document (only when it has one). */
  private sideBtn = h("button", { class: "kn-side-btn" });

  constructor(private app: App, private el: HTMLElement) {
    this.scroller = h("div", { class: "kn-tabs" });
    this.listBtn = h("button", { class: "kn-icon-btn kn-tab-list", title: titleWithKey("All tabs", "tab.list"), onclick: (e: MouseEvent) => this.showTabList(e) }, icon("list"));
    this.sideBtn.addEventListener("click", () => app.preview.toggle());
    const actions = h(
      "div",
      { class: "kn-tabbar-actions" },
      this.sideBtn,
      this.listBtn,
      h("button", { class: "kn-icon-btn", title: titleWithKey("New note", "file.new"), onclick: () => app.newDoc() }, icon("plus")),
      h("button", { class: "kn-icon-btn", title: titleWithKey("Command palette", "palette.commands"), onclick: () => openCommandPalette(app) }, icon("more")),
    );
    // Shown only while the sidebar is hidden (see .no-sidebar in the CSS).
    const showSidebar = h("button", { class: "kn-icon-btn kn-show-sidebar", title: titleWithKey("Show sidebar", "view.sidebar"), onclick: () => app.sidebar.toggle() }, icon("panelOpen"));
    el.append(showSidebar, this.scroller, actions);
    this.scroller.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    this.scroller.addEventListener("dblclick", (e) => {
      if (e.target === this.scroller) app.newDoc();
    });
    // The list of all tabs shows up when they no longer fit.
    new ResizeObserver(() => this.updateOverflow()).observe(this.scroller);
    app.on("docs", () => this.render());
    app.on("active", () => this.render());
    app.on("settings", () => this.render());
    app.on("workspace", () => this.updateSideBtn());
  }

  private updateSideBtn() {
    const kind = sideKindFor(this.app.active);
    this.sideBtn.hidden = !kind;
    if (!kind) return;
    const { label, icon: ic, title } = SIDE_LABELS[kind];
    const on = this.app.preview?.visible ?? false;
    this.sideBtn.classList.toggle("active", on);
    this.sideBtn.title = titleWithKey(`${on ? "Hide" : "Show"} the ${title.toLowerCase()}`, "view.preview");
    this.sideBtn.setAttribute("aria-pressed", String(on));
    if (this.sideBtn.dataset.kind !== kind) {
      this.sideBtn.dataset.kind = kind;
      this.sideBtn.replaceChildren(icon(ic), h("span", {}, label));
    }
  }

  /** What is on screen: the groups and tabs, in order (when it is the same, the tabs are updated in place). */
  private shown = "";
  private shownActive: Doc | null = null;
  private overflowPending = false;

  render() {
    if (this.dragging?.active) return;
    const app = this.app;
    // Groups expanded since the last render: their tabs slide in.
    const opened = new Set(app.groups.filter((g) => !g.collapsed && this.wasCollapsed.has(g.id)).map((g) => g.id));
    this.wasCollapsed = new Set(app.groups.filter((g) => g.collapsed).map((g) => g.id));
    const items: ({ group: TabGroup } | { doc: Doc; group?: TabGroup })[] = [];
    const seenGroups = new Set<string>();
    for (const doc of app.docs) {
      const group = doc.groupId ? app.groups.find((g) => g.id === doc.groupId) : undefined;
      if (group && !seenGroups.has(group.id)) {
        seenGroups.add(group.id);
        items.push({ group });
      }
      if (group?.collapsed && doc !== app.active) continue;
      items.push({ doc, group });
    }
    const shown = items.map((i) => ("doc" in i ? `t${i.doc.id}` : `g${i.group.id}`)).join(",");
    const els = [...this.scroller.children].filter((e) => e !== this.marker) as HTMLElement[];
    if (shown === this.shown && !opened.size && els.length === items.length) {
      // The same tabs: only their state changes (dirty, active, name…), no new elements.
      items.forEach((it, i) => {
        if ("doc" in it) this.applyTab(els[i], it.doc, it.group);
        else els[i].replaceWith(this.renderGroupChip(it.group));
      });
    } else {
      this.scroller.replaceChildren(
        ...items.map((it) => {
          if (!("doc" in it)) return this.renderGroupChip(it.group);
          const tab = this.renderTab(it.doc, it.group);
          if (it.group && opened.has(it.group.id) && it.doc !== app.active) tab.classList.add("appearing");
          return tab;
        }),
      );
      this.shown = shown;
    }
    this.updateSideBtn();
    if (app.active !== this.shownActive) {
      this.shownActive = app.active;
      this.scroller.querySelector<HTMLElement>(".kn-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // Measured once per frame (reading the widths forces a layout).
    if (!this.overflowPending) {
      this.overflowPending = true;
      requestAnimationFrame(() => {
        this.overflowPending = false;
        this.updateOverflow();
      });
    }
  }

  private updateOverflow() {
    this.el.classList.toggle("overflowing", this.scroller.scrollWidth > this.scroller.clientWidth + 1);
  }

  /** Menu of every tab (by group), to reach the ones scrolled out of view. */
  showTabList(e?: MouseEvent) {
    const app = this.app;
    const items: MenuItem[] = [];
    let lastGroup: string | null = null;
    for (const doc of app.docs) {
      if (doc.groupId !== lastGroup) {
        const g = app.groups.find((x) => x.id === doc.groupId);
        if (g) items.push({ header: g.name || "Group" });
        else if (lastGroup) items.push({ separator: true });
        lastGroup = doc.groupId;
      }
      items.push({
        label: `${doc.dirty ? "● " : ""}${app.docName(doc)}`,
        color: doc.color ?? undefined,
        icon: doc.path ? fileIcon(doc.path, app.settings.archive_suffix)[0] : "file",
        checked: doc === app.active,
        action: () => app.activate(doc),
      });
    }
    if (!items.length) items.push({ header: "No open tab" });
    const r = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect() ?? this.listBtn.getBoundingClientRect();
    showMenu(items, r.right - 240, r.bottom + 4);
  }

  private renderGroupChip(group: TabGroup) {
    const count = this.app.docs.filter((d) => d.groupId === group.id).length;
    const chip = h(
      "div",
      {
        class: `kn-group-chip${group.collapsed ? " collapsed" : ""}`,
        style: { "--g": resolveColor(group.color) },
        title: `${group.name || "Group"} · ${count} tab${count > 1 ? "s" : ""} — click to ${group.collapsed ? "expand" : "collapse"}`,
        role: "button",
        "aria-expanded": String(!group.collapsed),
      },
      icon("chevron", "kn-group-arrow"),
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

  /** Shows the state of a document on its tab (made by renderTab). */
  private applyTab(tab: HTMLElement, doc: Doc, group?: TabGroup) {
    const app = this.app;
    const cls = `kn-tab${doc === app.active ? " active" : ""}${doc.dirty ? " dirty" : ""}${doc.missing ? " missing" : ""}${group ? " grouped" : ""}${doc.color ? " colored" : ""}`;
    if (tab.className !== cls) tab.className = cls;
    const tabColor = doc.color ? resolveColor(doc.color) : "";
    const groupColor = group ? resolveColor(group.color) : "";
    if (tab.style.getPropertyValue("--tab-c") !== tabColor) tab.style.setProperty("--tab-c", tabColor || null);
    if (tab.style.getPropertyValue("--g") !== groupColor) tab.style.setProperty("--g", groupColor || null);
    const title = doc.path ? relative(app.workspace, doc.path) : `${doc.title} (unsaved)`;
    if (tab.title !== title) tab.title = title;
    const name = tab.querySelector(".kn-tab-name")!;
    if (name.textContent !== app.docName(doc)) name.textContent = app.docName(doc);
    const done = !!doc.path && isDoneFile(doc.path, app.settings.archive_suffix);
    const doneIcon = tab.querySelector(".kn-tab-icon");
    if (done && !doneIcon) tab.prepend(icon("fileDone", "kn-tab-icon"));
    else if (!done) doneIcon?.remove();
  }

  private renderTab(doc: Doc, group?: TabGroup) {
    const app = this.app;
    const tab = h(
      "div",
      { role: "tab" },
      h("span", { class: "kn-tab-name" }),
      h("button", { class: "kn-tab-close", title: "Close", tabindex: "-1" }, h("span", { class: "kn-tab-dirty" }), icon("x")),
    );
    this.applyTab(tab, doc, group);
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
    this.dragging = { doc, el: fresh, startX: e.clientX, offset: 0, active: false, pointerId: e.pointerId, outside: false };
    const move = (ev: PointerEvent) => this.onPointerMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.onPointerUp(ev.type === "pointerup" ? ev : null);
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
      // Keep receiving the pointer when it leaves the window (drop on another window).
      try {
        this.scroller.setPointerCapture(d.pointerId);
      } catch {
        /* not supported: the drop stays inside the window */
      }
    }
    // Outside the window: the tab will move to another window.
    d.outside = e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight;
    this.el.classList.toggle("detaching", d.outside);
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

  private onPointerUp(e: PointerEvent | null) {
    const d = this.dragging;
    if (!d) return;
    if (d.active) {
      const pointerX = d.startX + (parseFloat(d.el.style.transform.replace(/[^\d.-]/g, "")) || 0);
      const { docIndex } = this.dropIndex(pointerX);
      d.el.style.transform = "";
      d.el.classList.remove("dragging");
      this.el.classList.remove("is-dragging", "detaching");
      this.marker.remove();
      this.dragging = null;
      if (d.outside && e) {
        void dropTabOutside(this.app, d.doc, e.screenX, e.screenY);
        return;
      }
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
      { label: "Close all", shortcut: shortcutFor("tab.closeAll"), action: () => app.closeMany([...app.docs]) },
      { label: "Move to new window", icon: "newWindow", disabled: !doc.path, action: () => moveToNewWindow(app, doc) },
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
        { label: "Copy path", action: () => copyText(path) },
        { label: "Reveal in file manager", icon: "folderOpen", action: () => app.backend.reveal(path) },
        { label: "Rename…", action: () => renamePath(app, path) },
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
        { label: group.collapsed ? "Expand" : "Collapse", icon: group.collapsed ? "expand" : "collapse", action: () => app.toggleGroup(group) },
        { label: "Collapse the other groups", icon: "collapse", disabled: app.groups.length < 2, action: () => {
          for (const g of app.groups) g.collapsed = g !== group;
          app.emit("docs");
        } },
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
