#!/usr/bin/env bash
# Prepares a Claude Code cloud session on this repository (run at the start of
# every session by the SessionStart hook of .claude/settings.json). On a PC it
# does nothing at all. In the cloud it installs the npm dependencies when they
# are missing or older than package-lock.json, so that `npm test` and
# `npm run build` work. It never fails the session: a problem is reported in
# one line, with the log in /tmp/kilonote-cloud-setup.log.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$(dirname "$0")/.." || exit 0

LOG=/tmp/kilonote-cloud-setup.log
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  if npm ci --ignore-scripts --no-audit --no-fund >"$LOG" 2>&1; then
    echo "KiloNote: npm dependencies installed (npm ci)."
  else
    echo "KiloNote: npm ci failed, see $LOG. If the network is blocked, allow the npm registry in the cloud environment's settings (claude.ai/code)."
  fi
else
  echo "KiloNote: npm dependencies already installed."
fi
echo "KiloNote: npm test and npm run build run here; the Rust checks (cargo, WebKitGTK, macOS) run in CI on the pull request."
exit 0
