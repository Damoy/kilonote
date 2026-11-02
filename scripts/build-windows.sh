#!/usr/bin/env bash
# Builds KiloNote for Windows from Linux or WSL (cross-compilation).
#
#   scripts/build-windows.sh            → installer + portable exe in dist-windows/
#   scripts/build-windows.sh --install  → same, then installs/updates KiloNote on Windows (WSL)
#
# Output:
#   dist-windows/KiloNote_<version>_x64-setup.exe   installer (no administrator rights needed)
#   dist-windows/KiloNote.exe                       portable version (a single file)
#   dist-windows/SHA256SUMS.txt                     SHA-256 checksums
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
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
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
[ -d node_modules ] || { say "Installing npm dependencies"; npm ci; }

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

if [ "$INSTALL" = 1 ]; then
  command -v powershell.exe >/dev/null 2>&1 || die "--install requires WSL (powershell.exe not found)"
  say "Installing on Windows…"
  WIN_TEMP=$(powershell.exe -NoProfile -Command '[IO.Path]::GetTempPath()' | tr -d '\r')
  WIN_TEMP_WSL=$(wslpath -u "$WIN_TEMP")
  cp "$OUT/$(basename "$SETUP")" "$WIN_TEMP_WSL/kilonote-setup.exe"
  # Close a running instance, then install silently (user folder, no admin rights).
  powershell.exe -NoProfile -Command "
    Get-Process KiloNote, kilonote -ErrorAction SilentlyContinue | ForEach-Object { \$_.CloseMainWindow() | Out-Null };
    Start-Sleep -Milliseconds 800;
    Start-Process -Wait -FilePath '${WIN_TEMP}kilonote-setup.exe' -ArgumentList '/S';
    Remove-Item '${WIN_TEMP}kilonote-setup.exe' -ErrorAction SilentlyContinue
  " | tr -d '\r'
  INSTALLED=$(powershell.exe -NoProfile -Command '(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KiloNote" -ErrorAction SilentlyContinue).InstallLocation' | tr -d '\r"')
  say "KiloNote is installed${INSTALLED:+ in $INSTALLED}."
  say "Start menu → KiloNote, then right-click its taskbar icon → \"Pin to taskbar\"."
fi
