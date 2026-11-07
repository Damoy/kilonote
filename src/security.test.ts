/// <reference types="node" />
// Security regression tests: KiloNote must never be able to run programs.
// A note folder can contain anything (including executables): opening,
// clicking, dropping or passing a file on the command line must never
// launch it, whatever its extension.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isProbablyBinary } from "./core/path";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("no program execution", () => {
  it("the window capabilities grant no way to open or run files", () => {
    const caps = JSON.parse(read("src-tauri/capabilities/default.json")) as { permissions: unknown[] };
    const ids = caps.permissions.map((p) => (typeof p === "string" ? p : (p as { identifier: string }).identifier));
    for (const id of ids) {
      expect(id).not.toMatch(/open-path|^shell:|^process:|execute|spawn/);
    }
  });

  it("no shell or process plugin is compiled in", () => {
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).not.toMatch(/tauri-plugin-shell|tauri-plugin-process/);
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain("@tauri-apps/plugin-shell");
  });

  it("the native backend never starts a process", () => {
    const rust = read("src-tauri/src/main.rs");
    expect(rust).not.toMatch(/std::process::Command|Command::new|ShellExecute|CreateProcess/);
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
    const src = read("src/ui/html-preview.ts");
    expect(src).toMatch(/setAttribute\("sandbox", "allow-same-origin"\)/);
    expect(src).toMatch(/FRAME_CSP = "default-src 'none';/);
    // (The code only: the comments explain what is not allowed.)
    const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const f of ["src/ui/html-preview.ts", "src/ui/preview.ts", "src/ui/tree-view.ts", "src/editor/markdown-render.ts"]) {
      expect(code(f), f).not.toMatch(/allow-scripts|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
    }
  });
});
