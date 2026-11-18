// @vitest-environment node
// The version bump (scripts/bump-version.mjs) and the check that the five places
// agree (scripts/check-versions.mjs), run on a temporary copy of those files.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextVersion, readVersions } from "./versions.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
let root = "";

const run = (script, ...args) => spawnSync(process.execPath, [join(repo, "scripts", script), ...args], { env: { ...process.env, KILONOTE_ROOT: root }, encoding: "utf8" });
const bump = (arg) => execFileSync(process.execPath, [join(repo, "scripts/bump-version.mjs"), arg], { env: { ...process.env, KILONOTE_ROOT: root }, encoding: "utf8" }).trim();
const versions = () => [...new Set(Object.values(readVersions(root)))];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kilonote-bump-"));
  mkdirSync(join(root, "src-tauri"));
  for (const f of FILES) copyFileSync(join(repo, f), join(root, f));
  // A known starting point, whatever the version of the repository.
  execFileSync(process.execPath, [join(repo, "scripts/bump-version.mjs"), "1.4.2"], { env: { ...process.env, KILONOTE_ROOT: root } });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bump-version", () => {
  it("patch, minor and major change the five places together", () => {
    expect(versions()).toEqual(["1.4.2"]);
    expect(bump("patch")).toBe("1.4.3");
    expect(versions()).toEqual(["1.4.3"]);
    expect(bump("minor")).toBe("1.5.0");
    expect(versions()).toEqual(["1.5.0"]);
    expect(bump("major")).toBe("2.0.0");
    expect(versions()).toEqual(["2.0.0"]);
    expect(Object.keys(readVersions(root))).toHaveLength(6);
  });

  it("an explicit version is written as it is", () => {
    expect(bump("3.0.7")).toBe("3.0.7");
    expect(versions()).toEqual(["3.0.7"]);
    const lock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
    expect(lock).toMatch(/name = "kilonote"\nversion = "3\.0\.7"/);
    // Only the kilonote entry of Cargo.lock changes, not the dependencies.
    expect(lock.match(/version = "3\.0\.7"/g)).toHaveLength(1);
  });

  it("an invalid version is refused, and nothing is written", () => {
    for (const bad of ["1.2", "v1.2.3", "next", "1.2.3-beta", "01.2.3"]) {
      const r = run("bump-version.mjs", bad);
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toMatch(/Invalid version/);
    }
    expect(run("bump-version.mjs").status).toBe(1);
    expect(versions()).toEqual(["1.4.2"]);
  });

  it("--print tells the next version without changing anything", () => {
    const r = run("bump-version.mjs", "minor", "--print");
    expect(r.stdout.trim()).toBe("1.5.0");
    expect(versions()).toEqual(["1.4.2"]);
  });

  it("the files keep their layout: two-space JSON with a final newline", () => {
    bump("patch");
    for (const f of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).toBe(JSON.stringify(JSON.parse(text), null, 2) + "\n");
    }
  });

  it("the next version is computed from X.Y.Z", () => {
    expect(nextVersion("0.9.9", "patch")).toBe("0.9.10");
    expect(nextVersion("0.9.9", "minor")).toBe("0.10.0");
    expect(() => nextVersion("0.9", "patch")).toThrow();
  });
});

describe("check-versions", () => {
  it("passes when the five places agree, fails on a half bump", () => {
    const ok = run("check-versions.mjs");
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe("1.4.2");
    const conf = join(root, "src-tauri/tauri.conf.json");
    const j = JSON.parse(readFileSync(conf, "utf8"));
    j.version = "1.4.3";
    writeFileSync(conf, JSON.stringify(j, null, 2) + "\n");
    const bad = run("check-versions.mjs");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/src-tauri\/tauri\.conf\.json: 1\.4\.3/);
    expect(bad.stderr).toMatch(/package\.json: 1\.4\.2/);
  });

  it("fails when a place has no version at all", () => {
    const toml = join(root, "src-tauri/Cargo.toml");
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^version = .*$/m, ""));
    const r = run("check-versions.mjs");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cargo\.toml: \(not found\)/);
  });
});
