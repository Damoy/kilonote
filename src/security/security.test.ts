/// <reference types="node" />
// Security regression tests: KiloNote must never be able to run programs.
// A note folder can contain anything (including executables): opening,
// clicking, dropping or passing a file on the command line must never
// launch it, whatever its extension.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isProbablyBinary } from "../core/path";

/** A file of the repository, from its root. */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
/** The native backend: the library (lib.rs) and the desktop executable that starts it (main.rs). */
const rustSource = () => read("src-tauri/src/lib.rs") + read("src-tauri/src/main.rs");
/** The capabilities of the windows: desktop, and the Android app. */
const CAPABILITIES = ["src-tauri/capabilities/default.json", "src-tauri/capabilities/mobile.json"];

describe("no program execution", () => {
  it("the window capabilities grant no way to open or run files", () => {
    for (const f of CAPABILITIES) {
      const caps = JSON.parse(read(f)) as { permissions: unknown[] };
      const ids = caps.permissions.map((p) => (typeof p === "string" ? p : (p as { identifier: string }).identifier));
      for (const id of ids) {
        expect(id, f).not.toMatch(/open-path|^shell:|^process:|execute|spawn/);
      }
    }
  });

  it("the Android app has fewer permissions than the desktop one, and asks the system only for the network and the files", () => {
    const ids = (f: string) =>
      (JSON.parse(read(f)) as { permissions: unknown[] }).permissions.map((p) => (typeof p === "string" ? p : (p as { identifier: string }).identifier));
    const desktop = new Set(ids(CAPABILITIES[0]));
    for (const id of ids(CAPABILITIES[1])) expect(desktop.has(id), id).toBe(true);
    expect(ids(CAPABILITIES[1])).not.toContain("opener:allow-reveal-item-in-dir");
    expect((JSON.parse(read(CAPABILITIES[0])) as { platforms: string[] }).platforms).not.toContain("android");
    // The manifest: the files ("All files access", granted by the user in the system
    // settings), nothing else (contacts, camera, microphone, location…).
    const manifest = read("src-tauri/gen/android/app/src/main/AndroidManifest.xml");
    const asked = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(asked.sort()).toEqual(["android.permission.INTERNET", "android.permission.MANAGE_EXTERNAL_STORAGE"]);
    // Other apps can only launch it, or hand it a file to view or edit ("Open with").
    const actions = [...manifest.matchAll(/<action android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(actions.sort()).toEqual(["android.intent.action.EDIT", "android.intent.action.MAIN", "android.intent.action.VIEW"]);
    expect([...manifest.matchAll(/android:exported="true"/g)]).toHaveLength(1);
    // The Android side only reads paths and copies what other apps hand to it: it starts nothing else.
    const plugin = read("src-tauri/gen/android/app/src/main/java/dev/damoy/kilonote/StoragePlugin.kt");
    expect(plugin.match(/startActivity\w*\(/g)).toEqual(["startActivityForResult("]);
    expect(plugin).toMatch(/ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION/);
    expect(plugin).not.toMatch(/Runtime\.getRuntime|ProcessBuilder|ACTION_VIEW, |setDataAndType/);
    // Plain http only in the debug build (the release has usesCleartextTraffic false).
    expect(read("src-tauri/gen/android/app/build.gradle.kts")).toMatch(/defaultConfig \{\s*manifestPlaceholders\["usesCleartextTraffic"\] = "false"/);
  });

  it("no shell or process plugin is compiled in", () => {
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).not.toMatch(/tauri-plugin-shell|tauri-plugin-process/);
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@tauri-apps/plugin-shell");
  });

  it("the native backend never starts a process", () => {
    const rust = rustSource();
    expect(rust).not.toMatch(/std::process::Command|Command::new|ShellExecute|CreateProcess/);
  });

  it("the video protocol only reads video files, piece by piece, and media load from nowhere else", () => {
    const rust = rustSource();
    expect(rust).toMatch(/register_asynchronous_uri_scheme_protocol\("knmedia"/);
    const types = /const VIDEO_TYPES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/.exec(rust)![1];
    const exts = [...types.matchAll(/\("(\w+)",/g)].map((m) => m[1]);
    expect(exts.sort()).toEqual(["m4v", "mkv", "mov", "mp4", "ogv", "webm"]);
    // The protocol answers with a piece of the file: no write, no listing.
    const fn = /fn media_response[\s\S]*?\n}\n/.exec(rust)![0];
    expect(fn).not.toMatch(/fs::write|remove|read_dir|create/);
    const csp = (JSON.parse(read("src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp;
    expect(/media-src ([^;]*)/.exec(csp)![1].trim()).toBe("'self' knmedia: http://knmedia.localhost");
  });

  it("the image commands only read and write image files, and never overwrite one", () => {
    const rust = rustSource();
    expect(rust).toMatch(/const IMAGE_EXTS: &\[&str\] = &\["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"\];/);
    const fn = (name: string) => rust.slice(rust.indexOf(`fn ${name}(`), rust.indexOf("\n}\n", rust.indexOf(`fn ${name}(`)));
    expect(fn("read_image")).toMatch(/if !is_image_path\(&p\)/);
    expect(fn("read_image")).toMatch(/MAX_IMAGE_SIZE/);
    expect(fn("write_image")).toMatch(/save_new_image\(/);
    expect(fn("save_new_image")).toMatch(/if !is_image_path\(target\)/);
    expect(fn("save_new_image")).toMatch(/\.create_new\(true\)/);
    expect(fn("save_new_image")).not.toMatch(/File::create|fs::write|\.truncate\(/);
  });

  it("the frontend backend has no method that opens files with the system", () => {
    const backend = read("src/core/backend.ts");
    expect(backend).not.toMatch(/openPath|plugin-shell|\.execute\(/);
  });

  it("executables and other binaries are never opened", () => {
    for (const f of ["setup.exe", "TOOL.EXE", "x.msi", "a.jar", "lib.dll", "app.AppImage", "pkg.deb"]) {
      expect(isProbablyBinary(f)).toBe(true);
    }
    expect(isProbablyBinary("notes.txt")).toBe(false);
  });
});

describe("previews never run the content", () => {
  it("the page preview frame is sandboxed without scripts, under a strict policy", () => {
    const src = read("src/ui/views/html-preview.ts");
    expect(src).toMatch(/setAttribute\("sandbox", "allow-same-origin"\)/);
    expect(src).toMatch(/FRAME_CSP = "default-src 'none';/);
    // (The code only: the comments explain what is not allowed.)
    const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const f of ["src/ui/views/html-preview.ts", "src/ui/views/preview.ts", "src/ui/views/tree-view.ts", "src/ui/views/markdown-render.ts"]) {
      expect(code(f), f).not.toMatch(/allow-scripts|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
    }
  });
});

describe("hardening of the Windows build and of the release", () => {
  it("links: only web pages and e-mail addresses, at both ends", async () => {
    for (const f of CAPABILITIES) {
      const caps = read(f);
      expect(caps, f).not.toContain("opener:default");
      const opener = (JSON.parse(caps) as { permissions: unknown[] }).permissions.find(
        (p) => typeof p === "object" && (p as { identifier: string }).identifier === "opener:allow-open-url",
      ) as { allow: { url: string }[] };
      expect(opener.allow.map((a) => a.url).sort(), f).toEqual(["http://*", "https://*", "mailto:*"]);
    }
    const { isSafeUrl } = await import("../core/backend");
    for (const ok of ["https://example.com/a?b=1", "http://x.y", "mailto:a@b.c"]) expect(isSafeUrl(ok), ok).toBe(true);
    for (const bad of ["file:///C:/Windows/System32/calc.exe", "C:\\\\x.exe", "ms-settings:", "search-ms:query=x", "ms-msdt:/id", "javascript:alert(1)", "tel:123", "https://a b", "\\\\\\\\server\\\\share"])
      expect(isSafeUrl(bad), bad).toBe(false);
  });

  it("the installer downloads nothing and writes no file association", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { bundle: { windows: { webviewInstallMode: { type: string } } }; app: { withGlobalTauri: boolean; security: { csp: string } } };
    expect(conf.bundle.windows.webviewInstallMode.type).toBe("skip");
    expect(conf.app.withGlobalTauri).toBe(false);
    // No address outside the app: only its own IPC and its video protocol (local, read only).
    expect(conf.app.security.csp).not.toMatch(/https?:\/\/(?!(?:ipc|knmedia)\.localhost\b)|\*/);
    const hooks = read("src-tauri/windows/installer-hooks.nsh").split("\n").filter((l) => !l.trim().startsWith(";")).join("\n");
    expect(hooks).not.toMatch(/WriteReg|System::|Exec|NSISdl|inetc|nsExec/i);
  });

  it("no developer tools in the distributed build", () => {
    expect(read("src-tauri/Cargo.toml")).not.toMatch(/devtools/);
  });

  it("every GitHub Action is pinned to a commit (or is a workflow of this repository)", () => {
    for (const f of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      for (const line of read(f).split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) {
        expect(line, `${f}: ${line.trim()}`).toMatch(/@[0-9a-f]{40}(\s|$)|uses: \.\/\.github\/workflows\/[\w-]+\.yml$/);
      }
    }
  });
});

describe("diagrams and previews build no markup from the content", () => {
  it("diagrams are shown as images, page edits are written as text", () => {
    const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const f of ["src/ui/views/mermaid.ts", "src/ui/views/markdown-view.ts", "src/ui/views/diagram-view.ts", "src/ui/views/sql-view.ts", "src/ui/views/preview.ts", "src/ui/views/tree-view.ts", "src/text/sql-parse.ts"]) {
      expect(code(f), f).not.toMatch(/\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write|new Function|\beval\(/);
    }
    expect(read("src/ui/views/mermaid.ts")).toMatch(/securityLevel: "strict"/);
    expect(read("src/ui/views/preview.ts")).toMatch(/const insert = this\.html!\.escapeHtmlText\(text\)/);
  });
});

describe("licenses and bundle", () => {
  it("Mermaid's GPL/EPL layout engine (elkjs) is replaced at build time, and the dagre layout is used", () => {
    expect(read("vite.config.ts")).toMatch(/find: \/\^elkjs\\\/lib\\\/elk\\\.bundled\\\.js\$\//);
    expect(read("src/ui/views/mermaid.ts")).toMatch(/layout: "dagre"/);
    expect(read("src/vendor/elk-stub.ts")).not.toMatch(/import/);
  });

  it("no production dependency is under a GPL-family license, except elkjs (left out of the build)", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { license?: string; dev?: boolean }> };
    const gpl = Object.entries(lock.packages)
      .filter(([k, v]) => k && !v.dev && /GPL/i.test(v.license ?? ""))
      .map(([k]) => k.replace(/^.*node_modules\//, ""));
    expect(gpl).toEqual(["elkjs"]);
  });
});
