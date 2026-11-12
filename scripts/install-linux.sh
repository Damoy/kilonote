#!/usr/bin/env bash
# Installs KiloNote built from the sources on Linux, for the current user (no
# root needed): the program, its icons and its entry in the applications menu,
# so that the menu, the dock and Alt+Tab show Kilo's icon.
#
#   scripts/install-linux.sh              → builds, then installs (or updates)
#   scripts/install-linux.sh --no-build   → installs the last build
#   scripts/install-linux.sh --uninstall  → removes what it installed
#
# Files (XDG locations of the user):
#   ~/.local/bin/kilonote                                  the program
#   ~/.local/share/applications/kilonote.desktop           the menu entry
#   ~/.local/share/icons/hicolor/<size>/apps/kilonote.png  the icons
#
# The .deb and .rpm packages do the same for the whole system (see the README).
# Building needs the system packages listed in the README (WebKitGTK…).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
NAME=kilonote
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICONS_DIR="$DATA_DIR/icons/hicolor"
BUILT="${KILONOTE_BUILT_BIN:-$ROOT/src-tauri/target/release/$NAME}"
# The icons of the app, by size (scripts/generate-icons.py makes them).
ICON_SIZES=("32x32:32x32.png" "64x64:64x64.png" "128x128:128x128.png" "256x256:128x128@2x.png" "512x512:icon.png")

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }

refresh_caches() {
  # The menu and the icon theme pick up the changes (each tool is optional).
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS_DIR" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -f -t "$ICONS_DIR" || true
  command -v xdg-desktop-menu >/dev/null && xdg-desktop-menu forceupdate || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$BIN_DIR/$NAME" "$APPS_DIR/$NAME.desktop"
  for entry in "${ICON_SIZES[@]}"; do rm -f "$ICONS_DIR/${entry%%:*}/apps/$NAME.png"; done
  refresh_caches
  say "KiloNote is uninstalled (your notes and settings are kept)."
  exit 0
fi

if [[ "${1:-}" != "--no-build" ]]; then
  say "Building KiloNote (release)…"
  [[ -d node_modules ]] || npm ci
  npx tauri build --no-bundle
fi
[[ -x "$BUILT" ]] || { echo "No build found at $BUILT (run without --no-build)." >&2; exit 1; }

say "Installing in $BIN_DIR and $DATA_DIR…"
mkdir -p "$BIN_DIR" "$APPS_DIR"
# A copy then a rename: an open KiloNote keeps running, the new version starts next time.
cp "$BUILT" "$BIN_DIR/.$NAME.new"
chmod 755 "$BIN_DIR/.$NAME.new"
mv -f "$BIN_DIR/.$NAME.new" "$BIN_DIR/$NAME"

for entry in "${ICON_SIZES[@]}"; do
  size="${entry%%:*}"
  file="${entry#*:}"
  install -Dm644 "$ROOT/src-tauri/icons/$file" "$ICONS_DIR/$size/apps/$NAME.png"
done

# StartupWMClass ties the window to this entry: the dock shows its icon, not a generic one.
cat > "$APPS_DIR/$NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=KiloNote
Comment=Light, keyboard-driven notes with built-in task tracking
Exec="$BIN_DIR/$NAME" %F
Icon=$NAME
StartupWMClass=$NAME
Terminal=false
Categories=Office;TextEditor;Utility;
MimeType=text/plain;text/markdown;text/x-markdown;
EOF
chmod 644 "$APPS_DIR/$NAME.desktop"
refresh_caches

say "KiloNote is installed: open it from the applications menu (or run \"$NAME\")."
# Another KiloNote installed for the whole system (.deb or .rpm): two entries in the menu.
if [[ -e "/usr/bin/$NAME" ]]; then
  say "Note: a system-wide KiloNote is installed too (/usr/bin/$NAME). Remove it to keep a single"
  say "entry in the menu: sudo apt remove $NAME  (or: sudo dnf remove $NAME)"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "To run \"$NAME\" from a terminal, add $BIN_DIR to your PATH (the menu entry works without it)." ;;
esac
