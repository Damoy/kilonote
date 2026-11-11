// Screens loaded the first time they open: none of them is needed to start the
// app, so their code stays out of the start-up bundle.

import type { App } from "../app/app";
import type { SettingsSection } from "./settings-view";

export function openCheatSheet(app: App, opts: { startup?: boolean } = {}): Promise<void> {
  return import("./cheatsheet").then((m) => m.showCheatSheet(app, opts));
}

export function openBoard(app: App): Promise<void> {
  return import("./board").then((m) => m.showBoard(app));
}

export function openSettingsView(app: App, section?: SettingsSection): Promise<void> {
  return import("./settings-view").then((m) => m.showSettingsView(app, section));
}

/** Kilo the assistant, as the settings say (his code is loaded only when he is on). */
let assistant: Promise<typeof import("./assistant")> | null = null;
export function syncAssistant(app: App): void {
  if (!app.settings.assistant && !assistant) return;
  void (assistant ??= import("./assistant")).then((m) => m.syncAssistant(app));
}
