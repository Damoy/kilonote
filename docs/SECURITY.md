# KiloNote security sheet

For an IT or security team that needs to assess KiloNote before it is used on a managed
workstation. Every point can be checked in the source code, and most are enforced by
automated tests.

## At a glance

| Question | Answer |
|---|---|
| What it is | A local text file editor (functionally like Notepad++) |
| Network access | **None.** No HTTP client is compiled in, no telemetry, no automatic update, no license check |
| Running programs | **Never.** Opening, dropping or passing a file on the command line only reads text; a non-text file (`.exe`, `.msi`…, or any file whose content is binary, whatever its extension) can only be revealed in the file manager |
| Child processes | Only the WebView2 engine (`msedgewebview2.exe`), and the default browser or mail app when the user clicks a web or mail link |
| Data | Text files chosen by the user, on the local disk, in plain text (like Notepad) |
| Privileges | **Standard user.** No administrator rights, no service, no driver, nothing launched at startup, no scheduled task |
| Rendering engine | Microsoft Edge WebView2, a component of Windows 10/11 |
| Source code | Public, MIT license; widely used open-source dependencies (Tauri, CodeMirror) |
| Signature | **Not signed** (no Authenticode certificate): see [Points of attention](#points-of-attention) |
| Provenance | Every release file has a SHA-256 checksum and a signed build provenance ([Verify a file](#verify-a-file)) |

## Recommended deployment on a managed PC

The **portable exe** (`KiloNote_<version>_x64-portable.exe`, or `kilonote.exe` built from
source) is the simplest to assess: a single file, no installer, nothing written to the
registry by KiloNote. Put it in a folder of the user profile (for example
`%LOCALAPPDATA%\Programs\KiloNote\`), start it, and pin it to the taskbar.

To open text files with it from Explorer: right-click a file → *Open with* → *Choose
another app* → *Choose an app on your PC* → `kilonote.exe`. Windows records this choice
itself; KiloNote never changes file associations.

The per-user installer (`KiloNote_<version>_x64-setup.exe`, NSIS) is also available: see
[The Windows installer](#the-windows-installer).

## What the program does

### Processes

| Process | When |
|---|---|
| `kilonote.exe` | the application (one process for all its windows) |
| `msedgewebview2.exe` | the WebView2 rendering engine, started by Windows for the interface, like any other WebView2 application |
| default browser / mail app | only when the user clicks an `http://`, `https://` or `mailto:` link (handed to Windows; any other kind of address is refused, by the interface and by the window permissions) |
| File Explorer window | only when the user chooses *Reveal in file manager* (Windows Shell API, the file is selected, never opened) |

KiloNote never starts a command interpreter, a script host, PowerShell or any other
program.

### Network

- The binary contains no HTTP request library: in `src-tauri`,
  `cargo tree -e normal -i reqwest --target x86_64-pc-windows-msvc` returns nothing (the
  same for macOS and Linux; Tauri only uses an HTTP client on mobile platforms, which
  KiloNote does not target).
- The interface runs under a strict content security policy
  (`src-tauri/tauri.conf.json`): `connect-src 'self' ipc:` forbids any request to the
  outside, `script-src 'self'` forbids any remote or inline script. Fonts, images and
  icons are bundled with the application.
- The HTML preview runs in a sandbox that loads nothing (see
  [Technical surface](#technical-surface)).

### Files

| Location | Content |
|---|---|
| program folder | `kilonote.exe` (and `uninstall.exe` with the installer, in `%LOCALAPPDATA%\KiloNote\`) |
| `%APPDATA%\dev.damoy.kilonote\` | settings (`settings.json`), sessions (open tabs, one file per window), window positions, local history (`history\`: copies of versions KiloNote replaced, the 300 newest are kept) |
| `%LOCALAPPDATA%\dev.damoy.kilonote\` | WebView2 engine data |
| next to a file being saved | `.<name>.kilonote-tmp`, renamed over the file at once (atomic save, so a file is never left half written) |

- KiloNote only reads and writes the files and folders the user opens, plus the
  `<name>_done.txt` archive files it creates next to them on request.
- Files are saved one at a time, when the user types or saves. "Replace in files" only
  rewrites the files of the folder the user opened, after a confirmation, keeps a copy of
  each in the local history and can be undone.
- Deleting goes through the Windows recycle bin.
- The session may contain the text of unsaved tabs (so that nothing is lost when the
  app closes): this can be turned off with `"hot_exit": false` in the settings.
- KiloNote writes nothing to `%TEMP%`, to the startup folders or to system folders.

### Registry

KiloNote itself writes nothing to the registry (the WebView2 runtime manages its own
data).

## The Windows installer

`KiloNote_<version>_x64-setup.exe` is built by GitHub Actions with Tauri's standard NSIS
template. It installs per user, **without administrator rights**:

| What | Where |
|---|---|
| program | `%LOCALAPPDATA%\KiloNote\` (`kilonote.exe`, `uninstall.exe`) |
| "Apps & features" entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\KiloNote` |
| install folder | `HKCU\Software\Damoy\KiloNote` |
| shortcuts | Start menu, Desktop |

- It **downloads nothing and runs no other installer**: WebView2 is part of Windows 10/11,
  so the installer is built without the WebView2 download step (`webviewInstallMode`:
  `skip`). On a system without WebView2, install the *Microsoft Edge WebView2 Runtime*
  from Microsoft or from the company catalog.
- It writes **no file association** and no "Open with" entry (since 0.2.0; the
  uninstaller still removes the entries written by earlier versions).
- An update runs the previous version's uninstaller first (standard NSIS behavior), and
  the installer can start KiloNote at the end, as the current user.
- Silent install: `KiloNote_<version>_x64-setup.exe /S`. Full uninstall: "Apps &
  features", then delete the two `dev.damoy.kilonote` folders.

## Verify a file

Each release publishes `SHA256SUMS.txt`, and a signed **build provenance** for each file:
it proves the file was built by this repository's release workflow, from the tagged
source, on GitHub's servers.

```powershell
Get-FileHash .\KiloNote_0.2.0_x64-portable.exe -Algorithm SHA256
gh attestation verify .\KiloNote_0.2.0_x64-portable.exe -R Damoy/kilonote
```

The hash must match the one listed in `SHA256SUMS.txt`; it can also be used to allow the
file in an application control or endpoint protection policy.

## Building from source on a managed PC

Building locally avoids downloading an executable: only source code and packages are
fetched. Prerequisites, from the company catalog or the official installers: Node.js
LTS, Rust (rustup) and the Visual Studio C++ Build Tools. Then, in a **Command Prompt**
(cmd.exe, so that no PowerShell script and no execution-policy change is involved):

```bat
git clone https://github.com/Damoy/kilonote.git
cd kilonote
npm ci --ignore-scripts
npx tauri build --no-bundle
```

- `npm ci --ignore-scripts` installs the exact versions of `package-lock.json` and lets
  no package run code during installation (none needs to).
- `--no-bundle` builds `src-tauri\target\release\kilonote.exe` only: no installer
  tooling is downloaded or run.
- Network use: the npm registry, crates.io and, the first time, the Rust toolchain.
  During the build, the Rust compiler runs the build scripts of the dependencies (small
  programs compiled into `src-tauri\target\`), as for any Rust project.
- The result is the portable exe described in
  [Recommended deployment](#recommended-deployment-on-a-managed-pc); copy it out of the
  `target` folder.

## Technical surface

- The web interface runs in WebView2, isolated from the system: it can only call a
  closed list of native commands declared in `src-tauri/src/main.rs` (read/write a text
  file, list a folder, rename, move to the trash, open a KiloNote window) and the
  permissions of `src-tauri/capabilities/default.json`. The only "opener" permissions are
  opening `http(s)://` and `mailto:` addresses with the default app and revealing a file
  in the file manager: there is no permission to open or execute files, and no shell or
  process plugin. Developer tools are not compiled into the distributed build.
- Automated tests enforce this (`src/security.test.ts`, `src/security.behavior.test.ts`):
  they fail if a launch capability, a broader link scope, a download or registry write in
  the installer, developer tools, or an unpinned CI action is added; they check with a
  recording backend that opening executables from every entry point never does more than
  read. The end-to-end tests (`e2e/app.e2e.mjs`, run in CI on the real app) put
  executables in a notes folder, open them every possible way, check that none ran, and
  check that the window is denied the system's "open file" call and any non-web address.
- Note content is never interpreted as HTML (it is displayed by a text editor), which
  rules out script injection through an opened file. The Markdown preview builds its
  output element by element: raw HTML is shown as text, images and other remote content
  are never loaded, and only http(s)/mailto links can be opened (in the browser).
- The HTML and SVG preview shows the page in a sandboxed frame that is not allowed to run
  scripts, submit forms, open windows or navigate; the frame's own policy only allows
  inline styles and embedded (data:) images and fonts, so nothing is loaded from the
  network or the disk. The page is also cleaned before it is shown (scripts, frames,
  plugins, `<base>`, `<link>`, refresh, event attributes, autofocus and remote sources
  removed), and its links only open http(s)/mailto addresses in the browser. An SVG file
  is shown as an image, which never runs scripts. The end-to-end tests check that a
  page's script does not run.
- The JSON and YAML tree view only reads the text and, when a value is edited, replaces
  that value in the editor (one undo step); YAML is parsed by the `yaml` package, without
  custom tags, and aliases are never expanded. Documents nested deeper than 500 levels
  are refused instead of exhausting memory.
- The content security policy keeps `'unsafe-inline'` for styles only (the editor sets
  element styles); `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri from
  replacing it with nonces, which would block those styles. Scripts stay `'self'` only.

## Dependencies and supply chain

- `npm audit` and `cargo audit` (RustSec) report **no vulnerability**. The only RustSec
  notices are "unmaintained / unsound" warnings on Linux-only crates (GTK, D-Bus), which
  are not part of the Windows build. To check again: `npm audit` and, in `src-tauri`,
  `cargo audit`.
- The only npm package with an install script is `fsevents` (macOS only); builds use
  `--ignore-scripts`.
- Releases are built by GitHub Actions on GitHub-hosted runners. Every action is pinned
  to a commit (not a movable tag), workflows run with a read-only token unless a job
  needs to publish, and the release job signs the build provenance of every file.
- The Rust release build uses link-time optimization and stripped symbols; the
  executable is not packed or obfuscated.

## Points of attention

1. **Unsigned executable.** Without an Authenticode signature, SmartScreen may warn the
   first time, and endpoint protection or an application control policy (AppLocker,
   WDAC, Smart App Control) may treat an unknown executable in the user profile as
   suspicious, or block it. Options: allow it by SHA-256 hash or by path, sign it with a
   company certificate, or build it locally (see above). The provenance attestation lets
   a security team tie a file to its source.
2. **Software outside the catalog.** Even without administrator rights, installing it may
   fall under the company's IT policy.
3. **Downloads.** A web security gateway may scan or hold an unsigned executable
   downloaded from GitHub. Building from source only fetches source code and packages.
