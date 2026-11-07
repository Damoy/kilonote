#!/usr/bin/env bash
# Writes the Scoop and winget manifests of a published release, from its
# SHA256SUMS.txt (run by the release workflow once the installers are online).
#
#   scripts/update-packaging.sh            → version of src-tauri/tauri.conf.json
#   scripts/update-packaging.sh 0.1.1      → that version
#
# Output:
#   packaging/scoop/kilonote.json                                    (Scoop, portable exe)
#   packaging/winget/manifests/d/Damoy/KiloNote/<version>/*.yaml     (winget, per-user installer)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./src-tauri/tauri.conf.json').version")}"
REPO="Damoy/kilonote"
BASE="https://github.com/$REPO/releases/download/v$VERSION"
PORTABLE="KiloNote_${VERSION}_x64-portable.exe"
SETUP="KiloNote_${VERSION}_x64-setup.exe"

SUMS=$(curl -fsSL "$BASE/SHA256SUMS.txt") || { echo "No SHA256SUMS.txt in release v$VERSION yet" >&2; exit 1; }
hash_of() { printf '%s\n' "$SUMS" | awk -v f="$1" '$2 == f { print $1 }'; }
PORTABLE_SHA=$(hash_of "$PORTABLE")
SETUP_SHA=$(hash_of "$SETUP")
[ -n "$PORTABLE_SHA" ] && [ -n "$SETUP_SHA" ] || { echo "Missing $PORTABLE or $SETUP in SHA256SUMS.txt" >&2; exit 1; }

DESCRIPTION="Light, keyboard-driven notes with built-in task tracking"

# --- Scoop: the portable exe, with a Start menu shortcut (no command-line shim).
mkdir -p packaging/scoop
cat > packaging/scoop/kilonote.json <<EOF
{
  "version": "$VERSION",
  "description": "$DESCRIPTION",
  "homepage": "https://github.com/$REPO",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "$BASE/$PORTABLE#/KiloNote.exe",
      "hash": "$PORTABLE_SHA"
    }
  },
  "shortcuts": [["KiloNote.exe", "KiloNote"]],
  "checkver": "github",
  "autoupdate": {
    "architecture": {
      "64bit": {
        "url": "https://github.com/$REPO/releases/download/v\$version/KiloNote_\$version_x64-portable.exe#/KiloNote.exe",
        "hash": { "url": "\$baseurl/SHA256SUMS.txt" }
      }
    }
  }
}
EOF

# --- winget: the per-user NSIS installer (silent with /S).
DIR="packaging/winget/manifests/d/Damoy/KiloNote/$VERSION"
rm -rf packaging/winget/manifests/d/Damoy/KiloNote
mkdir -p "$DIR"
cat > "$DIR/Damoy.KiloNote.yaml" <<EOF
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: Damoy.KiloNote
PackageVersion: $VERSION
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
EOF
cat > "$DIR/Damoy.KiloNote.installer.yaml" <<EOF
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: Damoy.KiloNote
PackageVersion: $VERSION
InstallerType: nullsoft
Scope: user
InstallModes:
  - interactive
  - silent
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: $BASE/$SETUP
    InstallerSha256: $(printf '%s' "$SETUP_SHA" | tr '[:lower:]' '[:upper:]')
ManifestType: installer
ManifestVersion: 1.6.0
EOF
cat > "$DIR/Damoy.KiloNote.locale.en-US.yaml" <<EOF
# yaml-language-server: \$schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: Damoy.KiloNote
PackageVersion: $VERSION
PackageLocale: en-US
Publisher: Damoy
PublisherUrl: https://github.com/Damoy
PackageName: KiloNote
PackageUrl: https://github.com/$REPO
License: MIT
LicenseUrl: https://github.com/$REPO/blob/main/LICENSE
ShortDescription: $DESCRIPTION
Description: KiloNote is a fast, keyboard-driven note-taking editor built to track tasks (todo / ongoing / done), archive completed ones and produce activity reports. Notes stay plain text files; no network access, no telemetry.
Moniker: kilonote
Tags:
  - notes
  - todo
  - tasks
  - text-editor
  - markdown
ReleaseNotesUrl: https://github.com/$REPO/releases/tag/v$VERSION
ManifestType: defaultLocale
ManifestVersion: 1.6.0
EOF

echo "Manifests of KiloNote $VERSION written in packaging/"
