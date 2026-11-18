// The Android app on a phone: the sidebar becomes a drawer over the editor,
// which closes itself once a note is opened or the editor is touched (the
// matching styles are under html[data-platform="android"] in styles.css).

import type { App } from "../app/app";

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
