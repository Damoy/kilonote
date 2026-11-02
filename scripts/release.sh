#!/usr/bin/env bash
# Publie une nouvelle version de KiloNote sur GitHub.
#
#   scripts/release.sh patch|minor|major|X.Y.Z [--local] [--dry-run]
#
#   patch   0.1.0 → 0.1.1      (corrections)
#   minor   0.1.0 → 0.2.0      (nouveautés)
#   major   0.1.0 → 1.0.0
#
# Étapes :
#   1. vérifie que tout est propre (branche main, rien en attente, dépôt GitHub « origin ») ;
#   2. met la version à jour partout (package.json, tauri.conf.json, Cargo.toml, Cargo.lock) ;
#   3. lance les tests et le build ;
#   4. commit « Version X.Y.Z », tag vX.Y.Z, push.
#
# GitHub Actions (.github/workflows/release.yml) construit alors les installeurs
# Windows, macOS et Linux et les publie dans la release vX.Y.Z.
#
#   --local    construit aussi l'installeur Windows ici et crée la release tout de suite
#              avec GitHub CLI (gh), sans attendre la CI
#   --dry-run  affiche ce qui serait fait, sans rien modifier
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
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) die "Argument inconnu : $arg (voir --help)" ;;
  esac
done
[ -n "$BUMP" ] || die "Précisez patch, minor, major ou une version X.Y.Z (voir --help)"

# --- 1. Vérifications -------------------------------------------------------
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "Placez-vous sur la branche main (actuellement : $BRANCH)"
[ -z "$(git status --porcelain)" ] || die "Des modifications ne sont pas commitées : commitez-les d'abord."
git remote get-url origin >/dev/null 2>&1 || die "Aucun dépôt distant « origin ». Créez le dépôt sur GitHub puis :
    git remote add origin git@github.com:<vous>/kilonote.git && git push -u origin main"
if [ "$LOCAL" = 1 ]; then
  command -v gh >/dev/null 2>&1 || die "--local nécessite GitHub CLI : https://cli.github.com (puis « gh auth login »)"
  gh auth status >/dev/null 2>&1 || die "GitHub CLI n'est pas connecté : lancez « gh auth login »"
fi

CURRENT=$(node -p "require('./package.json').version")
NEXT=$(node -e '
  const [cur, bump] = process.argv.slice(1);
  const [a, b, c] = cur.split(".").map(Number);
  const next = bump === "major" ? [a + 1, 0, 0] : bump === "minor" ? [a, b + 1, 0] : bump === "patch" ? [a, b, c + 1] : bump.split(".").map(Number);
  if (next.some(Number.isNaN)) process.exit(1);
  console.log(next.join("."));
' "$CURRENT" "$BUMP") || die "Version invalide : $BUMP"
TAG="v$NEXT"
git rev-parse "$TAG" >/dev/null 2>&1 && die "Le tag $TAG existe déjà"
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)

NOTES=$(git log --no-merges --pretty='- %s' ${PREV_TAG:+$PREV_TAG..}HEAD | grep -v -- '- Version [0-9]' || true)
say "KiloNote $CURRENT → $NEXT ($TAG)"
printf '%s\n' "${NOTES:-- (aucun commit depuis la dernière version)}" | sed 's/^/    /'

if [ "$DRY" = 1 ]; then
  say "Simulation : rien n'a été modifié."
  exit 0
fi

# --- 2. Numéros de version --------------------------------------------------
node -e '
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

# --- 3. Contrôles -----------------------------------------------------------
say "Tests et build…"
npm test --silent
npm run build --silent >/dev/null

# --- 4. Commit, tag, push ---------------------------------------------------
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -q -m "Version $NEXT"
git tag -a "$TAG" -m "KiloNote $NEXT"

if [ "$LOCAL" = 1 ]; then
  bash scripts/build-windows.sh
  git push -q origin main "$TAG"
  gh release create "$TAG" dist-windows/*-setup.exe --title "KiloNote $NEXT" --notes "${NOTES:-Nouvelle version.}"
  say "Release publiée : $(gh release view "$TAG" --json url -q .url)"
  say "La CI ajoutera les versions macOS et Linux d'ici quelques minutes."
else
  git push -q origin main "$TAG"
  REPO=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
  say "Tag $TAG poussé : GitHub Actions construit les installeurs (≈ 10 min)."
  say "Suivi : https://github.com/$REPO/actions — release : https://github.com/$REPO/releases/tag/$TAG"
fi
