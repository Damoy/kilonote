# KiloNote security sheet

For an IT or security team that needs to assess KiloNote before it is used on a
workstation. Every point can be checked in the source code.

## At a glance

| Question | Answer |
|---|---|
| What it is | A local text file editor (functionally like Notepad++) |
| Network access | **None.** No HTTP client is compiled in, no telemetry, no automatic updates |
| Running programs | **Never.** Opening, dropping or passing a file on the command line only reads text; a non-text file (`.exe`, `.msi`…, or any file whose content is binary, whatever its extension) can only be revealed in the file manager |
| Data | Text files chosen by the user, on the local disk, in plain text (like Notepad) |
| Privileges | **Standard user.** No administrator rights, no service, nothing launched at startup |
| Rendering engine | Microsoft Edge WebView2 (part of Windows 10/11, updated by Windows Update) |
| Source code | Public, MIT license; widely used open-source dependencies (Tauri, CodeMirror) |
| Signature | **Not signed** (no Authenticode certificate): see "Points of attention" |

## Network

- The binary contains no HTTP request library: `cargo tree -e normal -i reqwest`
  returns nothing, whatever the target platform.
- The interface runs under a strict content security policy
  (`src-tauri/tauri.conf.json`): `connect-src 'self' ipc:` forbids any request to the
  outside, `script-src 'self'` forbids any remote script. Fonts and images are bundled
  with the application.
- Only network-related action: Ctrl+click on a link inside a note opens it in the
  default browser, at the user's initiative.
- The installer downloads WebView2 from Microsoft **only if it is missing** (it ships
  with Windows 10/11).

## Files and registry

| Location | Content |
|---|---|
| `%LOCALAPPDATA%\KiloNote\` | program (`kilonote.exe`, `uninstall.exe`) |
| `%APPDATA%\dev.damoy.kilonote\` | settings (`settings.json`), sessions (open tabs, one file per window), window positions, local history (`history\`: copies of versions KiloNote replaced, the 300 newest are kept) |
| `%LOCALAPPDATA%\dev.damoy.kilonote\` | WebView2 engine cache |
| `HKCU\…\Uninstall\KiloNote` | "Apps & features" entry |
| `HKCU\Software\Classes\KiloNote.Document`, `…\Applications\kilonote.exe`, `…\.<ext>\OpenWithProgids` | "Open with" entries for `.txt .text .md .markdown .note .todo .log` (installer only; default apps are never changed; removed on uninstall) |
| Start menu, Desktop | shortcuts |

- KiloNote only reads and writes the files and folders the user opens, plus the
  `<name>_done.txt` archive files it creates next to them on request.
- Deleting goes through the Windows recycle bin.
- The session may contain the text of unsaved tabs (so that nothing is lost when the
  app closes): this can be turned off with `"hot_exit": false` in the settings.
- Full uninstall: "Apps & features", then delete the two `dev.damoy.kilonote` folders.

## Technical surface

- The web interface runs in WebView2, isolated from the system: it can only call a
  closed list of native commands declared in `src-tauri/src/main.rs` (read/write a text
  file, list a folder, rename, move to the trash, open a KiloNote window) and the
  permissions of `src-tauri/capabilities/default.json`. The only "opener" permissions are
  opening http(s)/mailto links in the browser and revealing a file in the file manager:
  there is no permission to open or execute files, and no shell or process plugin.
- Automated tests enforce this (`src/security.test.ts`, `src/security.behavior.test.ts`):
  they fail if a launch capability is added, and they check with a recording backend that
  opening executables from every entry point never does more than read. The end-to-end
  tests (`e2e/app.e2e.mjs`, run in CI on the real app) put executables in a notes folder,
  open them every possible way, check that none ran, and check that the window is denied
  the system's "open file" call.
- Note content is never interpreted as HTML (it is displayed by a text editor), which
  rules out script injection through an opened file. The Markdown preview builds its
  output element by element: raw HTML is shown as text, images and other remote content
  are never loaded, and only http(s)/mailto links can be opened (in the browser).
- "Replace in files" only rewrites the files of the folder the user opened, after a
  confirmation, keeps a copy of each in the local history and can be undone.
- Browser developer tools are disabled in the distributed build.

## Points of attention

1. **Unsigned executable.** SmartScreen may show a warning, and an EDR or an
   AppLocker / WDAC / Smart App Control policy may block an unknown executable stored in
   the user profile. Solutions: allow it by SHA-256 hash (`SHA256SUMS.txt` is published
   with every release), or sign it with a company certificate.
2. **Software outside the catalog.** Even without administrator rights, installing it may
   fall under the company's IT policy.
3. **Building from source.** It requires Node.js, Rust and the Microsoft build tools, and
   downloads packages from npm and crates.io: it is simpler to validate the installer
   that CI (GitHub Actions) builds from these same sources.

## Verify an installer

```powershell
Get-FileHash .\KiloNote_0.1.0_x64-setup.exe -Algorithm SHA256
```

The hash must match the one listed in the release's `SHA256SUMS.txt`.
