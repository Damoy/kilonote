// Screens loaded the first time they open: none of them is needed to start the
// app, so their code stays out of the start-up bundle.

import type { App } from "../app/app";
import type { SettingsSection } from "./settings-view";

export function openCheatSheet(app: App, opts: { startup?: boolean } = {}): Promise<void> {
  return import("./cheatsheet").then((m) => m.showCheatSheet(app, opts));
}

export function openSettingsView(app: App, section?: SettingsSection): Promise<void> {
  return import("./settings-view").then((m) => m.showSettingsView(app, section));
}
