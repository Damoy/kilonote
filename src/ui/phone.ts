// The Android app on a phone: the sidebar becomes a drawer over the editor,
// which closes itself once a note is opened or the editor is touched (the
// matching styles are under html[data-platform="android"] in styles.css).

import type { App } from "../app/app";
import { runCommand } from "../core/commands";
import { showMenu, type MenuItem } from "./overlay";

/** A phone screen (a tablet keeps the side-by-side layout). */
export const PHONE_QUERY = "(max-width: 760px)";

export function installPhoneLayout(app: App, phone: Pick<MediaQueryList, "matches"> = matchMedia(PHONE_QUERY)) {
  const close = () => {
    if (phone.matches && app.sidebar.visible) app.sidebar.hide();
  };
  // At startup the editor shows first.
  close();
  // A note opened from the drawer (explorer, tasks, search).
  app.on("active", close);
  // A touch on the editor or on the tabs.
  document.getElementById("main")?.addEventListener("pointerdown", close, true);
}

/**
 * The ⋯ button on Android: the everyday actions in big rows, Open folder first,
 * then every command through the palette (the shortcuts need a keyboard).
 */
export function showPhoneMenu(app: App, anchor: HTMLElement) {
  const run = (id: string) => () => runCommand(id);
  const items: MenuItem[] = [
    { label: "Open folder…", icon: "folderOpen", action: run("folder.open") },
    { label: "Open file…", icon: "file", action: run("file.open") },
    { label: "Recent folders…", icon: "history", action: run("folder.recent") },
    { separator: true },
    { label: "New note", icon: "plus", action: run("file.new") },
    { label: "Today's note", icon: "calendar", action: run("file.dailyNote") },
    { label: "Save as…", icon: "save", disabled: !app.active, action: run("file.saveAs") },
    { separator: true },
    { label: "Go to file…", icon: "search", disabled: !app.workspace, action: run("palette.files") },
    { label: "Search in files", icon: "replace", disabled: !app.workspace, action: run("view.search") },
    { label: "Task board", icon: "board", action: run("view.board") },
    { separator: true },
    { label: "All commands…", icon: "command", action: run("palette.commands") },
    { label: "Settings", icon: "gear", action: run("settings.open") },
  ];
  const r = anchor.getBoundingClientRect();
  showMenu(items, Math.max(8, r.right - 280), r.bottom + 4);
}
