// Every command of the app (the palette lists them) and the default shortcuts.

import { registerCommands, type Command } from "../core/commands";
import { goToOccurrence, openFind } from "../editor/matches";
import { confirm, toast } from "../ui/overlay";
import { openBoard, openCheatSheet } from "../ui/lazy";
import type { App } from "./app";
import { formatDocument } from "./editing";
import { deleteUnusedImages } from "./images";
import { copyText, renamePath } from "./files";
import { showLocalHistory } from "./history";
import { openCommandPalette, openQuickOpen, selectAccent, selectLanguage, selectMascot, selectTheme } from "./pickers";
import { archiveAllDone, archiveSelection, cycleTasks, generateReport, generateTagReport, setDueDate, toggleDoneFile } from "./tasks";
import { moveToNewWindow } from "./windows";
import { isPinned, setPinned } from "./pins";

// Features loaded on first use (their code stays out of the start-up bundle).
const templates = () => import("./templates");
const links = () => import("./links");
const secrets = () => import("./secrets");
const exporting = () => import("./export");

export function showAbout() {
  void confirm({
    title: `KiloNote ${__APP_VERSION__}`,
    message: "Notes as light as a kilobyte. A fast editor with todo / ongoing / done tasks, archives and yearly activity reports. Built with Tauri and CodeMirror.",
    okLabel: "Nice!",
    cancelLabel: "Close",
  });
}

/** File: Pin or unpin this note. */
function togglePin(app: App) {
  const path = app.active?.path;
  if (!path) {
    toast("Save this note first: a pinned note is a file.");
    return;
  }
  const pinned = !isPinned(path);
  setPinned(path, pinned);
  toast(pinned ? "Pinned: at the top of the explorer and of Go to file." : "Unpinned", { timeout: 1800 });
}

export function defaultKeybindings(app: App): Record<string, string> {
  const keys: Record<string, string> = {
    "Mod+N": "file.new",
    "Mod+Shift+N": "window.new",
    "Mod+O": "file.open",
    "Mod+Shift+O": "folder.open",
    "Mod+S": "file.save",
    "Mod+Shift+S": "file.saveAs",
    "Mod+W": "tab.close",
    "Ctrl+F4": "tab.close",
    "Mod+Shift+T": "tab.reopen",
    "Ctrl+Tab": "tab.next",
    "Ctrl+Shift+Tab": "tab.prev",
    "Mod+PageDown": "tab.next",
    "Mod+PageUp": "tab.prev",
    "Mod+P": "palette.files",
    "Mod+Shift+P": "palette.commands",
    F1: "palette.commands",
    "Mod+G": "palette.line",
    "Mod+R": "palette.symbol",
    "Mod+B": "view.sidebar",
    "Mod+Shift+E": "view.files",
    "Mod+Shift+A": "view.tasks",
    "Mod+Shift+F": "view.search",
    "Mod+Enter": "task.cycle",
    "Mod+Shift+Enter": "task.archive",
    "Mod+Shift+D": "file.toggleDone",
    "Mod+Shift+U": "task.due",
    "Mod+,": "settings.open",
    "Mod+=": "view.uiZoomIn",
    "Mod++": "view.uiZoomIn",
    "Mod+-": "view.uiZoomOut",
    "Mod+0": "view.uiZoomReset",
    F11: "view.fullscreen",
    "Shift+F11": "view.zen",
    "Alt+Z": "view.wrap",
    "Mod+Shift+V": "view.preview",
    "Shift+Alt+F": "edit.format",
    "Mod+F3": "edit.nextOccurrence",
    "Mod+Alt+N": "file.newFromTemplate",
    "Mod+Alt+D": "file.dailyNote",
    "Mod+Alt+B": "palette.backlinks",
    "Mod+Alt+K": "view.board",
    "Mod+Shift+F3": "edit.prevOccurrence",
    "Mod+Shift+C": "edit.copyRich",
    "Mod+?": "help.shortcuts",
  };
  if (app.backend.platform !== "macos") keys["Mod+H"] = "edit.replace";
  for (let i = 1; i <= 9; i++) keys[`Mod+${i}`] = `tab.goto.${i}`;
  return keys;
}

export function registerStatusCommands(app: App) {
  const cmds: Command[] = Object.keys(app.taskCfg.statuses).map((name) => ({
    id: `task.set.${name}`,
    title: `Task: Mark as "${name}"`,
    run: () => cycleTasks(app, name),
  }));
  app.commandList = app.commandList.filter((c) => !c.id.startsWith("task.set."));
  app.commandList.push(...cmds);
  registerCommands(cmds);
}

export function registerAllCommands(app: App) {
  const cmds: Command[] = [
    { id: "file.new", title: "File: New note", run: () => app.newDoc() },
    { id: "window.new", title: "Window: New window", run: () => app.backend.openWindow([]) },
    { id: "window.moveTab", title: "Window: Move tab to new window", run: () => app.active && moveToNewWindow(app, app.active) },
    { id: "file.open", title: "File: Open…", run: async () => { for (const p of await app.backend.pickFiles()) await app.openFile(p); } },
    { id: "folder.open", title: "Folder: Open…", run: () => app.openFolder() },
    { id: "folder.close", title: "Folder: Close", run: () => app.closeFolder() },
    { id: "file.save", title: "File: Save", run: () => app.active && app.save(app.active) },
    { id: "file.saveAs", title: "File: Save as…", run: () => app.active && app.saveAs(app.active) },
    { id: "file.saveAll", title: "File: Save all", run: () => app.saveAll() },
    { id: "file.rename", title: "File: Rename…", run: () => app.active?.path && renamePath(app, app.active.path) },
    { id: "file.reveal", title: "File: Reveal in file manager", run: () => app.active?.path && app.backend.reveal(app.active.path) },
    { id: "file.pin", title: "File: Pin or unpin this note (top of the explorer and of Go to file)", run: () => togglePin(app) },
    { id: "file.copyPath", title: "File: Copy path", run: () => app.active?.path && copyText(app.active.path) },
    { id: "edit.copyRich", title: "Edit: Copy as rich text (for an e-mail, Outlook, Teams…)", run: () => exporting().then((m) => m.copyRich(app)) },
    { id: "file.exportHtml", title: "File: Export as HTML page…", run: () => exporting().then((m) => m.exportHtml(app)) },
    { id: "file.print", title: "File: Print or save as PDF…", run: () => exporting().then((m) => m.printNote(app)) },
    { id: "file.toggleDone", title: "Tasks: Switch between note and its _done archive", run: () => toggleDoneFile(app) },
    { id: "file.reload", title: "File: Reload from disk", run: () => app.active && app.reloadDoc(app.active, true) },
    { id: "file.history", title: "File: Local history (earlier versions)…", run: () => showLocalHistory(app) },
    { id: "tab.close", title: "Tab: Close", run: () => app.active && app.closeDoc(app.active) },
    { id: "tab.closeOthers", title: "Tab: Close others", run: () => app.closeMany(app.docs.filter((d) => d !== app.active)) },
    { id: "tab.closeAll", title: "Tab: Close all", run: () => app.closeMany(app.docs) },
    { id: "tab.reopen", title: "Tab: Reopen last closed", run: () => app.reopenClosed() },
    { id: "tab.list", title: "Tab: List all tabs", run: () => app.tabbar.showTabList() },
    { id: "tab.next", title: "Tab: Next", run: () => app.cycleTab(1) },
    { id: "tab.prev", title: "Tab: Previous", run: () => app.cycleTab(-1) },
    { id: "tab.color", title: "Tab: Color…", run: () => app.active && app.tabbar.showColorMenu(app.active) },
    { id: "tab.group", title: "Tab: Add to new group…", run: () => app.active && app.createGroup([app.active]) },
    { id: "tab.ungroup", title: "Tab: Remove from group", run: () => app.active && app.addToGroup(app.active, null) },
    { id: "tab.toggleGroup", title: "Tab: Collapse or expand its group", run: () => app.toggleActiveGroup() },
    { id: "tab.collapseGroups", title: "Tab: Collapse all groups", run: () => app.setAllGroupsCollapsed(true) },
    { id: "tab.expandGroups", title: "Tab: Expand all groups", run: () => app.setAllGroupsCollapsed(false) },
    { id: "palette.commands", title: "Command palette", run: () => openCommandPalette(app) },
    { id: "palette.files", title: "Go to file…", run: () => openQuickOpen(app) },
    { id: "palette.line", title: "Go to line…", run: () => openQuickOpen(app, ":") },
    { id: "palette.backlinks", title: "Go to: Notes linking here", run: () => links().then((m) => m.showBacklinks(app)) },
    { id: "edit.encrypt", title: "Edit: Encrypt selection with a password…", run: () => secrets().then((m) => m.encryptSelection(app)) },
    { id: "edit.forgetPassword", title: "Edit: Forget the remembered secrets password", run: () => secrets().then((m) => m.forgetPassword()) },
    { id: "edit.linkNote", title: "Edit: Link to a note…", run: () => links().then((m) => m.insertNoteLink(app)) },
    { id: "palette.symbol", title: "Go to heading or task…", run: () => openQuickOpen(app, "@") },
    { id: "edit.find", title: "Edit: Find", run: () => app.active && openFind(app.view) },
    { id: "edit.replace", title: "Edit: Find and replace", run: () => app.active && openFind(app.view) },
    { id: "edit.nextOccurrence", title: "Edit: Next occurrence of the selected text", run: () => app.active && goToOccurrence(app.view, true) },
    { id: "edit.prevOccurrence", title: "Edit: Previous occurrence of the selected text", run: () => app.active && goToOccurrence(app.view, false) },
    { id: "file.newFromTemplate", title: "File: New note from template…", run: () => templates().then((m) => m.newFromTemplate(app)) },
    { id: "file.dailyNote", title: "File: Today's note", run: () => templates().then((m) => m.openDailyNote(app)) },
    { id: "template.edit", title: "Template: Edit templates…", run: () => templates().then((m) => m.editTemplates(app)) },
    { id: "file.deleteUnusedImages", title: "File: Delete unused images…", run: () => deleteUnusedImages(app) },
    { id: "edit.format", title: "Edit: Format document (JSON, XML, HTML, CSS, SQL, Markdown tables)", run: () => formatDocument(app) },
    { id: "edit.minify", title: "Edit: Minify JSON", run: () => formatDocument(app, "minify") },
    { id: "view.sidebar", title: "View: Toggle sidebar", run: () => app.sidebar.toggle() },
    { id: "view.files", title: "View: File explorer", run: () => app.sidebar.show("files") },
    { id: "view.tasks", title: "View: Folder tasks", run: () => app.sidebar.show("tasks") },
    { id: "view.board", title: "View: Task board", run: () => openBoard(app) },
    { id: "view.assistant", title: "View: Kilo, the assistant (show / hide)", run: () => app.updateSetting("assistant", !app.settings.assistant) },
    { id: "view.search", title: "View: Search in files", run: () => app.sidebar.show("search") },
    { id: "view.zen", title: "View: Zen mode", run: () => app.setZen(!app.zen) },
    { id: "view.fullscreen", title: "View: Full screen", run: () => app.backend.toggleFullscreen() },
    { id: "view.uiZoomIn", title: "View: Zoom in (whole interface)", run: () => app.zoomInterface(1) },
    { id: "view.uiZoomOut", title: "View: Zoom out (whole interface)", run: () => app.zoomInterface(-1) },
    { id: "view.uiZoomReset", title: "View: Reset zoom (whole interface)", run: () => app.zoomInterface(null) },
    { id: "view.zoomIn", title: "View: Increase editor text size (Ctrl+wheel)", run: () => app.zoom(1) },
    { id: "view.zoomOut", title: "View: Decrease editor text size (Ctrl+wheel)", run: () => app.zoom(-1) },
    { id: "view.zoomReset", title: "View: Reset editor text size", run: () => app.zoom(null) },
    { id: "view.wrap", title: "View: Toggle word wrap", run: () => app.updateSetting("word_wrap", !app.settings.word_wrap) },
    { id: "view.preview", title: "View: Toggle preview or tree view (Markdown, HTML, SVG, JSON, YAML)", run: () => app.preview.toggle() },
    { id: "view.previewOnly", title: "View: Preview only (hide the editor) / side by side", run: () => app.preview.visible ? app.preview.setOnly(!app.preview.only) : app.preview.toggle() },
    { id: "view.previewSize", title: "View: Preview and editor half and half", run: () => app.preview.setSize(0.5) },
    { id: "view.language", title: "View: Document type (syntax coloring)…", run: () => selectLanguage(app) },
    { id: "view.lineNumbers", title: "View: Toggle line numbers", run: () => app.updateSetting("line_numbers", !app.settings.line_numbers) },
    { id: "theme.select", title: "Theme: Select…", run: () => selectTheme(app) },
    { id: "theme.accent", title: "Theme: Accent color…", run: () => selectAccent(app) },
    { id: "theme.mascot", title: "Theme: Kilo's color…", run: () => selectMascot(app) },
    { id: "settings.open", title: "Preferences: Settings", run: () => app.openSettings() },
    { id: "settings.json", title: "Preferences: Open settings.json", run: () => app.openSettings(true) },
    { id: "task.cycle", title: "Task: Next status", run: () => cycleTasks(app) },
    { id: "task.archive", title: "Task: Archive line to _done", run: () => archiveSelection(app) },
    { id: "task.archiveDone", title: "Task: Archive all completed tasks", run: () => archiveAllDone(app) },
    { id: "report.generate", title: "Report: Generate activity report…", run: () => generateReport(app) },
    { id: "report.tag", title: "Report: Generate activity report for a #tag…", run: () => generateTagReport(app) },
    { id: "task.due", title: "Task: Set due date…", run: () => setDueDate(app) },
    { id: "help.shortcuts", title: "Help: Keyboard shortcuts (cheat sheet)", run: () => openCheatSheet(app) },
    { id: "help.guide", title: "Help: KiloNote guide", run: async () => app.newDoc({ text: (await import("./guide")).GUIDE, title: "KiloNote guide.md", lang: "markdown" }) },
    { id: "help.about", title: "Help: About", run: () => showAbout() },
  ];
  for (let i = 1; i <= 9; i++) {
    cmds.push({ id: `tab.goto.${i}`, title: `Tab ${i}`, hidden: true, run: () => app.gotoTab(i) });
  }
  app.commandList = cmds;
  registerCommands(cmds);
}
