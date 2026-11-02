#!/usr/bin/env bash
# Construit KiloNote pour Windows depuis Linux ou WSL (compilation croisée).
#
#   scripts/build-windows.sh            → installeur + version portable dans dist-windows/
#   scripts/build-windows.sh --install  → idem, puis installe/met à jour KiloNote sous Windows (WSL)
#
# Résultat :
#   dist-windows/KiloNote_<version>_x64-setup.exe   installeur (sans droits administrateur)
#   dist-windows/KiloNote.exe                       version portable (un seul fichier)
#   dist-windows/SHA256SUMS.txt                     empreintes SHA-256
#
# La première fois, la chaîne de compilation est préparée automatiquement
# (scripts/setup-windows-cross.sh). Sur une machine Windows, utilisez plutôt
# scripts/build-windows.ps1.
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
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
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
  say "Préparation de la chaîne de compilation Windows (une seule fois)"
  bash "$ROOT/scripts/setup-windows-cross.sh"
fi

command -v node >/dev/null 2>&1 || die "Node.js est requis (https://nodejs.org)"
[ -d node_modules ] || { say "Installation des dépendances npm"; npm ci; }

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
say "Compilation de KiloNote $VERSION pour Windows (x64)…"
npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

RELEASE_DIR="$ROOT/src-tauri/target/$TARGET/release"
SETUP="$RELEASE_DIR/bundle/nsis/KiloNote_${VERSION}_x64-setup.exe"
[ -f "$SETUP" ] || die "Installeur introuvable : $SETUP"
EXE=""
for candidate in "$RELEASE_DIR/KiloNote.exe" "$RELEASE_DIR/kilonote.exe"; do
  if [ -f "$candidate" ]; then EXE="$candidate"; break; fi
done

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SETUP" "$OUT/"
if [ -n "$EXE" ]; then cp "$EXE" "$OUT/KiloNote.exe"; fi
# Empreintes pour vérifier les fichiers (Get-FileHash sous Windows).
(cd "$OUT" && sha256sum -- *.exe > SHA256SUMS.txt)
say "Fichiers prêts dans dist-windows/ :"
ls -lh "$OUT" | tail -n +2 | awk '{print "    " $5 "\t" $9}'

if [ "$INSTALL" = 1 ]; then
  command -v powershell.exe >/dev/null 2>&1 || die "--install nécessite WSL (powershell.exe introuvable)"
  say "Installation sous Windows…"
  WIN_TEMP=$(powershell.exe -NoProfile -Command '[IO.Path]::GetTempPath()' | tr -d '\r')
  WIN_TEMP_WSL=$(wslpath -u "$WIN_TEMP")
  cp "$OUT/$(basename "$SETUP")" "$WIN_TEMP_WSL/kilonote-setup.exe"
  # Ferme une éventuelle instance ouverte, puis installation silencieuse (dossier utilisateur, sans admin).
  powershell.exe -NoProfile -Command "
    Get-Process KiloNote, kilonote -ErrorAction SilentlyContinue | ForEach-Object { \$_.CloseMainWindow() | Out-Null };
    Start-Sleep -Milliseconds 800;
    Start-Process -Wait -FilePath '${WIN_TEMP}kilonote-setup.exe' -ArgumentList '/S';
    Remove-Item '${WIN_TEMP}kilonote-setup.exe' -ErrorAction SilentlyContinue
  " | tr -d '\r'
  INSTALLED=$(powershell.exe -NoProfile -Command '(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\KiloNote" -ErrorAction SilentlyContinue).InstallLocation' | tr -d '\r"')
  say "KiloNote est installé${INSTALLED:+ dans $INSTALLED}."
  say "Menu Démarrer → KiloNote, puis clic droit sur son icône dans la barre des tâches → « Épingler »."
fi
