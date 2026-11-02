#!/usr/bin/env bash
# Sets up (once) the Linux/WSL → Windows cross-compilation toolchain:
#   - Rust target x86_64-pc-windows-msvc + cargo-xwin (downloads the Windows SDK by itself)
#   - LLVM: clang-cl, lld-link, llvm-lib, llvm-rc (icon and metadata of the exe)
#   - NSIS: makensis (.exe installer)
#
# Without root rights, LLVM and NSIS are extracted from the Ubuntu/Debian packages into
# ~/.local/share/kilonote-toolchain (nothing is installed system-wide).
# With sudo, you can simply run instead:
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
command -v rustup >/dev/null 2>&1 || die "Rust is required: https://rustup.rs (curl ... | sh)"
say "Rust target x86_64-pc-windows-msvc"
rustup target add x86_64-pc-windows-msvc >/dev/null
if ! command -v cargo-xwin >/dev/null 2>&1; then
  say "Installing cargo-xwin (a few minutes)"
  cargo install --locked cargo-xwin
fi

# --- LLVM + NSIS -----------------------------------------------------------
have_system_tools() {
  command -v clang-cl >/dev/null && command -v lld-link >/dev/null && command -v llvm-rc >/dev/null &&
    command -v llvm-lib >/dev/null && command -v makensis >/dev/null
}

if have_system_tools; then
  say "LLVM and NSIS are already installed system-wide: nothing to do."
  exit 0
fi

command -v apt-get >/dev/null 2>&1 || die "apt-get not found: install clang, lld, llvm and nsis with your package manager."

say "Downloading LLVM $LLVM_VERSION and NSIS into $TOOLCHAIN_DIR"
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

# Small launchers: local libraries + the names cargo-xwin and Tauri expect.
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
# lld-link, llvm-lib… are multi-call links: the name they are called by matters.
for tool in lld-link llvm-lib llvm-rc llvm-ar llvm-mt llvm-cvtres llvm-dlltool llvm-windres llvm-ranlib; do
  wrap "$tool" "$llvm_bin/$tool"
done
cat >"$TOOLCHAIN_DIR/bin/makensis" <<EOF
#!/usr/bin/env bash
export NSISDIR="$root/usr/share/nsis"
exec "$root/usr/bin/makensis" "\$@"
EOF
chmod +x "$TOOLCHAIN_DIR/bin/makensis"

# Check: every tool must at least start.
for tool in clang-cl lld-link llvm-lib llvm-rc makensis; do
  if "$TOOLCHAIN_DIR/bin/$tool" --version 2>&1 | grep -q "error while loading shared libraries"; then
    die "$tool does not work (missing library)"
  fi
done
say "Toolchain ready: $TOOLCHAIN_DIR/bin"
