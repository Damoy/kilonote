# Working on KiloNote

A guide for coding agents (Claude Code on a PC or in a cloud session, or any other).

## The project

KiloNote is a light, keyboard-driven note app with built-in task tracking (todo /
ongoing / done, archives, activity reports), for Windows, macOS, Linux and Android. It is a
[Tauri 2](https://tauri.app) app: a vanilla TypeScript frontend (no UI framework) with
[CodeMirror 6](https://codemirror.net) as the editor, built by Vite, and a small Rust
backend in `src-tauri/` (atomic file reads and writes, archives, trash, windows; `lib.rs`,
started by `main.rs` on the desktop and as a library by the Android app, whose project is
`src-tauri/gen/android/`). The
repository is public and MIT licensed. The README describes every feature; `docs/SECURITY.md`
lists what the app may and may not do (keep it true when you change one of those things).

## Rules

- Code, comments, commit messages and docs are in **English**. Talk to Damoy, the
  maintainer, in **French**.
- The repository is public: nothing personal or sensitive in code, commits, docs or
  releases (no user paths, no names of other projects, no work details).
- Commit messages: a short summary line, then what changed and why, in plain words.
- A new feature comes with tests (Vitest, next to the code) and its line in the README, the
  in-app guide (`src/app/guide.ts`) and, for a shortcut, the cheat sheet (`src/ui/cheatsheet.ts`).
- Every change ends with a new version (Damoy asks for it): once the work is committed and
  checked, publish one, *minor* for a feature, *patch* for a fix (see *Releasing a version*).
  Never delete a tag, never force-push.

## Commands

| Command | What it does |
|---|---|
| `npm ci --ignore-scripts` | installs the dependencies (as CI does) |
| `npm test` | all the Vitest tests (frontend, security rules, scripts) |
| `npm run build` | type-checks (`tsc`) and builds the frontend |
| `npm run dev` | the frontend in a browser, with a demo file system (no Rust needed) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | the Rust tests (needs WebKitGTK on Linux) |
| `npx tauri android build --apk --target aarch64` | the Android app (needs the Android SDK and NDK: CI builds it at release) |
| `npm run test:e2e` | end-to-end tests of the real app (after `npx tauri build --debug --no-bundle`, needs `tauri-driver` and a display: CI runs them) |
| `node scripts/check-versions.mjs` | checks that the version is the same in its five places |

## Where things are

```
src/app/        the window's controller (app.ts) and its features: commands, pickers, tasks,
                history, files, session, panes layout (layout.ts), templates, links, secrets…
src/core/       backend (Tauri or browser demo), paths, settings, themes, command registry
src/editor/     CodeMirror setup, note highlighting, languages, slash menu
src/text/       pure text logic, no DOM (tasks, reports, formatters, parsers, Kilo's hints)
src/ui/         tab bars, panes, sidebar, palette, menus, status bar, settings, views
src/security/   tests that lock the security rules (CSP, sandbox, permissions, pinned actions)
src-tauri/      Rust backend (lib.rs), Tauri config (tauri.conf.json holds the version),
                capabilities (default.json: desktop, mobile.json: Android), gen/android
scripts/        releases and version bump, Windows and Linux builds, packaging, cloud setup
.github/        ci.yml (checks on every push and PR) and release.yml (installers, release)
e2e/            end-to-end tests (WebDriver)
```

## Releasing a version

The version lives in five places (`package.json`, `package-lock.json` twice,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`): always
change it with the commands below, never by hand.

**From the PC** (git and `gh` logged in):

```bash
npm run release -- patch     # or minor, major, X.Y.Z; --dry-run shows what would happen
```

It bumps the version, runs the tests and the build, commits `Version X.Y.Z`, tags
`vX.Y.Z` and pushes both. GitHub Actions builds and publishes the release.

**From a cloud session** (Claude Code on the web or on the phone):

```bash
npm run version:bump -- patch   # or minor, major, X.Y.Z: prints the new version
npm test
npm run build
git add -A && git commit -m "Version X.Y.Z"
```

The commit must only bump the version (do the work in earlier commits). Then push:

- **to `main`** when the session may: `git pull --rebase origin main` first (the release
  workflow commits packaging manifests to `main` after each release), then `git push origin HEAD:main`;
- **otherwise to the session's branch**: `git push -u origin HEAD` (if the branch was pushed
  before, `git merge origin/main` rather than a rebase: never force-push). The session cannot
  open the pull request itself (`gh` is not logged in): tell Damoy to open it (the *Create PR*
  button of the Claude app, or on github.com the *Compare & pull request* banner of the
  branch) and to merge it (GitHub app: Pull requests → the PR → Merge). The release starts
  once it is merged.

When `main` receives a new version, `.github/workflows/release.yml` runs the checks, creates
the tag `vX.Y.Z`, builds Windows, macOS and Linux and publishes the release "KiloNote vX.Y.Z"
with the list of changes (about 15 to 25 minutes), then adds the Android APK, signed with the
`ANDROID_KEYSTORE` and `ANDROID_KEYSTORE_PASSWORD` secrets (without them, only the Android job
fails). Do not create the tag yourself.

If the checks fail, nothing is tagged or published. Fix the problem on `main` (a fix alone
does not start the release: only a change of `src-tauri/tauri.conf.json` does), then run the
release by hand: Actions → Release → Run workflow, on `main`. The same button retries a
release whose build failed. "Dry run" only shows what would be released.

## What works in a cloud session

| | Cloud session | PC |
|---|---|---|
| `npm test`, `npm run build` | yes (dependencies installed at start by `scripts/cloud-setup.sh`) | yes |
| Rust checks, macOS build, end-to-end tests | no: CI runs them on the pull request | Rust: with WebKitGTK |
| Android APK | only if the network lets the SDK and Gradle download; otherwise the release builds it | with the Android SDK and NDK |
| Windows or macOS installers | no: the release workflow builds them | Windows: `npm run build:windows` |
| Push the session's branch | yes | yes |
| Push `main` | sometimes refused: push the branch, Damoy merges the PR | yes |
| Push a tag | no (and not needed: the release workflow creates it) | yes (`npm run release`) |
| `gh` (runs, PRs, releases) | not logged in: Damoy uses the GitHub app | yes |
| Downloads (npm…) | depends on the environment's network setting | yes |

If `npm ci` fails in a cloud session (see `/tmp/kilonote-cloud-setup.log`), the
environment's network setting may block the npm registry: Damoy can allow it in the
environment's settings on claude.ai/code.
