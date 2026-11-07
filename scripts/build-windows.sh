#!/usr/bin/env bash
# Builds KiloNote for Windows from Linux or WSL (cross-compilation).
#
#   scripts/build-windows.sh            → installer + portable exe in dist-windows/
#                                         (and in %USERPROFILE%\dev-builds\kilonote\ on WSL)
#   scripts/build-windows.sh --install  → same, then updates the installed KiloNote (WSL)
#
# Output:
#   dist-windows/KiloNote_<version>_x64-setup.exe   installer (no administrator rights needed)
#   dist-windows/KiloNote.exe                       portable version (a single file)
#   dist-windows/SHA256SUMS.txt                     SHA-256 checksums
#
# --install only copies files from WSL: it never starts a Windows process, never
# runs the installer and never launches KiloNote. If KiloNote is installed, its exe
# is swapped in place (an open window keeps running; the new build starts the next
# time KiloNote is opened). A first install is done by running the installer yourself.
# Set KILONOTE_WINDOWS_HOME=/mnt/c/Users/<you> if your Windows profile is not detected.
#
# The first run sets up the toolchain automatically (scripts/setup-windows-cross.sh).
# On a Windows machine, use scripts/build-windows.ps1 instead.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
TARGET=x86_64-pc-windows-msvc
TOOLCHAIN_BIN="${KILONOTE_TOOLCHAIN:-$HOME/.local/share/kilonote-toolchain}/bin"
OUT="$ROOT/dist-windows"
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$TOOLCHAIN_BIN:$HOME/.cargo/bin:$PATH"

need_setup=0
for tool in cargo cargo-xwin clang-cl lld-link llvm-rc llvm-lib makensis; do
  command -v "$tool" >/dev/null 2>&1 || need_setup=1
done
rustup target list --installed 2>/dev/null | grep -q "$TARGET" || need_setup=1
if [ "$need_setup" = 1 ]; then
  say "Setting up the Windows toolchain (first run only)"
  bash "$ROOT/scripts/setup-windows-cross.sh"
fi

command -v node >/dev/null 2>&1 || die "Node.js is required (https://nodejs.org)"
[ -d node_modules ] || { say "Installing npm dependencies"; npm ci --ignore-scripts; }

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
say "Building KiloNote $VERSION for Windows (x64)…"
npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

RELEASE_DIR="$ROOT/src-tauri/target/$TARGET/release"
SETUP="$RELEASE_DIR/bundle/nsis/KiloNote_${VERSION}_x64-setup.exe"
[ -f "$SETUP" ] || die "Installer not found: $SETUP"
EXE=""
for candidate in "$RELEASE_DIR/KiloNote.exe" "$RELEASE_DIR/kilonote.exe"; do
  if [ -f "$candidate" ]; then EXE="$candidate"; break; fi
done

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SETUP" "$OUT/"
if [ -n "$EXE" ]; then cp "$EXE" "$OUT/KiloNote.exe"; fi
# Checksums to verify the files (Get-FileHash on Windows).
(cd "$OUT" && sha256sum -- *.exe > SHA256SUMS.txt)
say "Files ready in dist-windows/:"
ls -lh "$OUT" | tail -n +2 | awk '{print "    " $5 "\t" $9}'

# --- Windows side (WSL): plain file copies, no Windows process ----------------
# The Windows profile: the one where KiloNote is installed, otherwise the only real one.
windows_home() {
  if [ -n "${KILONOTE_WINDOWS_HOME:-}" ]; then echo "$KILONOTE_WINDOWS_HOME"; return 0; fi
  local exe profiles=()
  for exe in /mnt/c/Users/*/AppData/Local/KiloNote/kilonote.exe; do
    if [ -f "$exe" ]; then echo "${exe%/AppData/Local/KiloNote/kilonote.exe}"; return 0; fi
  done
  for exe in /mnt/c/Users/*/; do
    case "$(basename "$exe")" in Public|Default|"Default User"|"All Users") ;; *) profiles+=("${exe%/}") ;; esac
  done
  if [ "${#profiles[@]}" = 1 ]; then echo "${profiles[0]}"; return 0; fi
  return 1
}

WIN_HOME=""
if [ -d /mnt/c/Users ]; then WIN_HOME=$(windows_home || true); fi
if [ -n "$WIN_HOME" ]; then
  BUILDS="$WIN_HOME/dev-builds/kilonote"
  mkdir -p "$BUILDS"
  cp "$OUT"/* "$BUILDS/"
  say "Copied to $(wslpath -w "$BUILDS")"
fi

if [ "$INSTALL" = 1 ]; then
  [ -n "$WIN_HOME" ] || die "Windows profile not found: set KILONOTE_WINDOWS_HOME=/mnt/c/Users/<you>"
  APP_DIR="$WIN_HOME/AppData/Local/KiloNote"
  if [ ! -f "$APP_DIR/kilonote.exe" ]; then
    say "KiloNote is not installed yet. Run the installer yourself:"
    say "  $(wslpath -w "$BUILDS/$(basename "$SETUP")")"
    exit 0
  fi
  [ -f "$OUT/KiloNote.exe" ] || die "No portable exe in dist-windows/: the installed KiloNote was left as is"
  # Executables left by previous updates (one still in use stays until next time).
  for old in "$APP_DIR"/kilonote.*.old; do [ -e "$old" ] && rm -f "$old" 2>/dev/null || true; done
  # A running exe can be renamed on Windows, not overwritten: rename, then copy.
  PREVIOUS="$APP_DIR/kilonote.$(date +%Y%m%d-%H%M%S).old"
  mv "$APP_DIR/kilonote.exe" "$PREVIOUS" ||
    die "Could not update $(wslpath -w "$APP_DIR"): close KiloNote and run this again"
  if ! cp "$OUT/KiloNote.exe" "$APP_DIR/kilonote.exe"; then
    # Never leave KiloNote without its exe: put the previous one back.
    rm -f "$APP_DIR/kilonote.exe"
    mv "$PREVIOUS" "$APP_DIR/kilonote.exe"
    die "Could not copy the new exe: the previous version was put back"
  fi
  say "KiloNote is updated: the new build starts the next time you open it."
fi
