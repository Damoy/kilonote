#!/usr/bin/env bash
# Publishes a new KiloNote version on GitHub.
#
#   scripts/release.sh patch|minor|major|X.Y.Z [--local] [--dry-run]
#   scripts/release.sh 0.1.0      first release of the current version
#
#   patch   0.1.0 → 0.1.1      (fixes)
#   minor   0.1.0 → 0.2.0      (new features)
#   major   0.1.0 → 1.0.0
#
# Steps:
#   1. checks that everything is clean (main branch, nothing uncommitted, "origin" remote);
#   2. bumps the version everywhere (package.json, tauri.conf.json, Cargo.toml, Cargo.lock);
#   3. runs the tests and the build;
#   4. commits "Version X.Y.Z", tags vX.Y.Z, pushes.
#
# GitHub Actions (.github/workflows/release.yml) then builds the Windows, macOS
# and Linux installers and publishes them in the vX.Y.Z release.
#
#   --local    also builds the Windows installer here and creates the release right
#              away with the GitHub CLI (gh), without waiting for CI
#   --dry-run  shows what would happen, without changing anything
set -euo pipefail

cd "$(dirname "$0")/.."
say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

BUMP=""
LOCAL=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) die "Unknown argument: $arg (see --help)" ;;
  esac
done
[ -n "$BUMP" ] || die "Give patch, minor, major or a version X.Y.Z (see --help)"

# --- 1. Checks ---------------------------------------------------------------
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "Switch to the main branch first (currently: $BRANCH)"
[ -z "$(git status --porcelain)" ] || die "There are uncommitted changes: commit them first."
git remote get-url origin >/dev/null 2>&1 || die "No \"origin\" remote. Create the repository on GitHub, then:
    git remote add origin git@github.com:<you>/kilonote.git && git push -u origin main"
if [ "$LOCAL" = 1 ]; then
  command -v gh >/dev/null 2>&1 || die "--local needs the GitHub CLI: https://cli.github.com (then \"gh auth login\")"
  gh auth status >/dev/null 2>&1 || die "The GitHub CLI is not logged in: run \"gh auth login\""
fi

CURRENT=$(node -p "require('./package.json').version")
NEXT=$(node -e '
  const [cur, bump] = process.argv.slice(1);
  const [a, b, c] = cur.split(".").map(Number);
  const next = bump === "major" ? [a + 1, 0, 0] : bump === "minor" ? [a, b + 1, 0] : bump === "patch" ? [a, b, c + 1] : bump.split(".").map(Number);
  if (next.some(Number.isNaN)) process.exit(1);
  console.log(next.join("."));
' "$CURRENT" "$BUMP") || die "Invalid version: $BUMP"
TAG="v$NEXT"
git rev-parse "$TAG" >/dev/null 2>&1 && die "Tag $TAG already exists"
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)

NOTES=$(git log --no-merges --pretty='- %s' ${PREV_TAG:+$PREV_TAG..}HEAD | grep -v -- '- Version [0-9]' || true)
say "KiloNote $CURRENT → $NEXT ($TAG)"
printf '%s\n' "${NOTES:-- (no commit since the last version)}" | sed 's/^/    /'

if [ "$DRY" = 1 ]; then
  say "Dry run: nothing was changed."
  exit 0
fi

# --- 2. Version numbers -----------------------------------------------------
# (first release of the current version: nothing to change, just tag it)
[ "$NEXT" != "$CURRENT" ] && node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  lock.version = v;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = v;
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8").replace(/^version = ".*"$/m, `version = "${v}"`);
  fs.writeFileSync("src-tauri/Cargo.toml", cargo);
  const clock = fs.readFileSync("src-tauri/Cargo.lock", "utf8").replace(/(name = "kilonote"\nversion = ")[^"]+/, `$1${v}`);
  fs.writeFileSync("src-tauri/Cargo.lock", clock);
' "$NEXT"

# --- 3. Checks: tests and build ---------------------------------------------
say "Tests and build…"
npm test --silent
npm run build --silent >/dev/null

# --- 4. Commit, tag, push ---------------------------------------------------
if [ "$NEXT" != "$CURRENT" ]; then
  git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -q -m "Version $NEXT"
fi
git tag -a "$TAG" -m "KiloNote $NEXT"

if [ "$LOCAL" = 1 ]; then
  bash scripts/build-windows.sh
  git push -q origin main "$TAG"
  gh release create "$TAG" dist-windows/*-setup.exe dist-windows/SHA256SUMS.txt --title "KiloNote $NEXT" --notes "${NOTES:-New version.}"
  say "Release published: $(gh release view "$TAG" --json url -q .url)"
  say "CI will add the macOS and Linux builds within a few minutes."
else
  git push -q origin main "$TAG"
  REPO=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
  say "Tag $TAG pushed: GitHub Actions is building the installers (≈ 10 min)."
  say "Progress: https://github.com/$REPO/actions — release: https://github.com/$REPO/releases/tag/$TAG"
fi
