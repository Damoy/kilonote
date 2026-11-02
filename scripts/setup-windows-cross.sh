#!/usr/bin/env bash
# Prépare (une seule fois) la chaîne de compilation croisée Linux/WSL → Windows :
#   - cible Rust x86_64-pc-windows-msvc + cargo-xwin (SDK Windows téléchargé automatiquement)
#   - LLVM : clang-cl, lld-link, llvm-lib, llvm-rc (icône et métadonnées de l'exe)
#   - NSIS : makensis (installeur .exe)
#
# Sans droits root, LLVM et NSIS sont extraits des paquets Ubuntu/Debian dans
# ~/.local/share/kilonote-toolchain (rien n'est installé dans le système).
# Avec sudo, on peut aussi simplement faire :
#   sudo apt install clang lld llvm nsis
set -euo pipefail

TOOLCHAIN_DIR="${KILONOTE_TOOLCHAIN:-$HOME/.local/share/kilonote-toolchain}"
LLVM_VERSION="${LLVM_VERSION:-18}"

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- Rust ------------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
command -v rustup >/dev/null 2>&1 || die "Rust est requis : https://rustup.rs (curl ... | sh)"
say "Cible Rust x86_64-pc-windows-msvc"
rustup target add x86_64-pc-windows-msvc >/dev/null
if ! command -v cargo-xwin >/dev/null 2>&1; then
  say "Installation de cargo-xwin (quelques minutes)"
  cargo install --locked cargo-xwin
fi

# --- LLVM + NSIS -----------------------------------------------------------
have_system_tools() {
  command -v clang-cl >/dev/null && command -v lld-link >/dev/null && command -v llvm-rc >/dev/null &&
    command -v llvm-lib >/dev/null && command -v makensis >/dev/null
}

if have_system_tools; then
  say "LLVM et NSIS déjà présents dans le système : rien à faire."
  exit 0
fi

command -v apt-get >/dev/null 2>&1 || die "apt-get introuvable : installez clang, lld, llvm et nsis avec le gestionnaire de paquets de votre système."

say "Téléchargement de LLVM $LLVM_VERSION et NSIS dans $TOOLCHAIN_DIR"
debs="$TOOLCHAIN_DIR/debs"
root="$TOOLCHAIN_DIR/root"
mkdir -p "$debs" "$root" "$TOOLCHAIN_DIR/bin"
(
  cd "$debs"
  apt-get download \
    "clang-$LLVM_VERSION" "libclang-cpp$LLVM_VERSION" "libclang-common-$LLVM_VERSION-dev" "libclang1-$LLVM_VERSION" \
    "llvm-$LLVM_VERSION" "llvm-$LLVM_VERSION-linker-tools" "lld-$LLVM_VERSION" "libllvm$LLVM_VERSION" \
    nsis nsis-common >/dev/null
)
for deb in "$debs"/*.deb; do dpkg -x "$deb" "$root"; done

llvm_bin="$root/usr/lib/llvm-$LLVM_VERSION/bin"
libs="$root/usr/lib/x86_64-linux-gnu:$root/usr/lib/llvm-$LLVM_VERSION/lib"

# Petits lanceurs : bibliothèques locales + noms attendus par cargo-xwin et Tauri.
wrap() { # wrap <nom> <binaire> [args…]
  local name="$1" target="$2"; shift 2
  cat >"$TOOLCHAIN_DIR/bin/$name" <<EOF
#!/usr/bin/env bash
export LD_LIBRARY_PATH="$libs\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$target" $* "\$@"
EOF
  chmod +x "$TOOLCHAIN_DIR/bin/$name"
}
wrap clang "$llvm_bin/clang"
wrap clang-cl "$llvm_bin/clang" --driver-mode=cl
# lld-link, llvm-lib… sont des liens multi-usages : le nom d'appel compte.
for tool in lld-link llvm-lib llvm-rc llvm-ar llvm-mt llvm-cvtres llvm-dlltool llvm-windres llvm-ranlib; do
  wrap "$tool" "$llvm_bin/$tool"
done
cat >"$TOOLCHAIN_DIR/bin/makensis" <<EOF
#!/usr/bin/env bash
export NSISDIR="$root/usr/share/nsis"
exec "$root/usr/bin/makensis" "\$@"
EOF
chmod +x "$TOOLCHAIN_DIR/bin/makensis"

# Vérification : chaque outil doit au moins pouvoir se lancer.
for tool in clang-cl lld-link llvm-lib llvm-rc makensis; do
  if "$TOOLCHAIN_DIR/bin/$tool" --version 2>&1 | grep -q "error while loading shared libraries"; then
    die "$tool ne fonctionne pas (bibliothèque manquante)"
  fi
done
say "Chaîne de compilation prête : $TOOLCHAIN_DIR/bin"
