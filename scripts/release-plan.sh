#!/usr/bin/env bash
# Decides what the release workflow does (the "version" job of
# .github/workflows/release.yml), from the version in src-tauri/tauri.conf.json:
#
#   push of the tag vX.Y.Z     → release it (fails when the tag is not the version)
#   push to main               → release when the tag vX.Y.Z is not on origin yet, and
#                                create it; otherwise "already released", nothing to do
#   run by hand (Actions tab)  → release the version (again: to retry a failed release),
#                                creating its tag when missing; "dry run" only shows what
#                                would happen
#
# Writes version, release, create_tag and notes (the commits since the previous tag,
# without the "Version X.Y.Z" and "Packaging manifests" ones) to $GITHUB_OUTPUT, and a
# summary to $GITHUB_STEP_SUMMARY. Runs locally too (git and node only):
#
#   GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main bash scripts/release-plan.sh
set -euo pipefail
cd "$(dirname "$0")/.."

EVENT="${GITHUB_EVENT_NAME:-workflow_dispatch}"
REF="${GITHUB_REF:-refs/heads/$(git rev-parse --abbrev-ref HEAD)}"
DRY_RUN="${DRY_RUN:-false}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
fail() { echo "::error::$*" >&2; exit 1; }

# The five places that hold the version agree (a half bump never gets released).
VERSION=$(node scripts/check-versions.mjs) || fail "The version is not the same everywhere: see above."
TAG="v$VERSION"

# Is the tag on origin? (0: yes, 2: no; anything else is an error, never "no".)
tag_on_origin() {
  local rc=0
  git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    2) return 1 ;;
    *) fail "Could not read the tags of origin (git ls-remote: $rc)." ;;
  esac
}

release=false
create_tag=false
target=HEAD
case "$EVENT" in
  push)
    if [[ "$REF" == refs/tags/* ]]; then
      [ "${REF#refs/tags/}" = "$TAG" ] || fail "The tag ${REF#refs/tags/} is not the version of src-tauri/tauri.conf.json ($VERSION)."
      release=true
      reason="tag $TAG pushed"
    elif [ "$REF" = refs/heads/main ]; then
      if tag_on_origin; then
        reason="$TAG already released (its tag exists): nothing to do"
      else
        release=true
        create_tag=true
        reason="new version $VERSION on main: tag $TAG and release it"
      fi
    else
      fail "Unexpected ref $REF (main or a vX.Y.Z tag)."
    fi
    ;;
  workflow_dispatch)
    if [[ "$REF" == refs/tags/* ]]; then
      [ "${REF#refs/tags/}" = "$TAG" ] || fail "The tag ${REF#refs/tags/} is not the version of src-tauri/tauri.conf.json ($VERSION)."
      reason="run by hand on $TAG: release it again"
    elif [ "$REF" = refs/heads/main ]; then
      if tag_on_origin; then
        reason="run by hand: release $TAG again (its tag exists)"
        target="$TAG^{commit}"
      else
        create_tag=true
        reason="run by hand: tag $TAG on main and release it"
      fi
    else
      fail "Run the release from main (or from a vX.Y.Z tag), not from $REF."
    fi
    release=true
    if [ "$DRY_RUN" = true ]; then
      release=false
      create_tag=false
      reason="dry run (nothing published): $reason"
    fi
    ;;
  *) fail "Unexpected event $EVENT." ;;
esac

# The changes: the commits since the previous version's tag.
prev=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude "$TAG" "$target" 2>/dev/null || true)
notes=$(git log --no-merges --pretty='- %s' ${prev:+"$prev.."}"$target" | grep -v -E '^- (Version [0-9]+\.[0-9]+\.[0-9]+$|Packaging manifests for )' || true)
[ -n "$notes" ] || notes="- (no change listed)"

echo "$reason"
{
  echo "version=$VERSION"
  echo "release=$release"
  echo "create_tag=$create_tag"
  # (A random end marker: no commit message can end the notes early.)
  delim="NOTES_$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
  echo "notes<<$delim"
  printf '%s\n' "$notes"
  echo "$delim"
} >>"$OUT"
{
  echo "### KiloNote $VERSION"
  echo
  echo "**$reason**"
  echo
  echo "Changes since ${prev:-the first commit}:"
  echo
  printf '%s\n' "$notes"
} >>"$SUMMARY"
