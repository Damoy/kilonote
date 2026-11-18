// The version of KiloNote, kept in five places that must agree:
//   package.json, package-lock.json (two fields), src-tauri/tauri.conf.json,
//   src-tauri/Cargo.toml, and the kilonote entry of src-tauri/Cargo.lock.
// Used by bump-version.mjs, check-versions.mjs and their tests (no git work here).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CARGO_TOML_RE = /^version = "([^"]*)"$/m;
const CARGO_LOCK_RE = /(name = "kilonote"\r?\nversion = ")([^"]+)/;

const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));

/** Each place that holds the version, with the version it holds (null when it cannot be read). */
export function readVersions(root) {
  const safe = (fn) => {
    try {
      return fn() ?? null;
    } catch {
      return null;
    }
  };
  return {
    "package.json": safe(() => readJson(root, "package.json").version),
    "package-lock.json": safe(() => readJson(root, "package-lock.json").version),
    'package-lock.json packages[""]': safe(() => readJson(root, "package-lock.json").packages[""].version),
    "src-tauri/tauri.conf.json": safe(() => readJson(root, "src-tauri/tauri.conf.json").version),
    "src-tauri/Cargo.toml": safe(() => CARGO_TOML_RE.exec(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"))[1]),
    "src-tauri/Cargo.lock": safe(() => CARGO_LOCK_RE.exec(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"))[2]),
  };
}

/** The version after `bump` (patch, minor, major, or an explicit X.Y.Z); throws on anything else. */
export function nextVersion(current, bump) {
  if (VERSION_RE.test(bump)) return bump;
  const m = VERSION_RE.exec(current);
  if (!m) throw new Error(`The current version "${current}" is not X.Y.Z`);
  const [a, b, c] = m.slice(1).map(Number);
  if (bump === "major") return `${a + 1}.0.0`;
  if (bump === "minor") return `${a}.${b + 1}.0`;
  if (bump === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error(`Invalid version: "${bump}" (patch, minor, major or X.Y.Z)`);
}

/**
 * Writes `version` in the five places, as scripts/release.sh always did. Every file is
 * read and changed in memory first: nothing is written unless all five can be updated.
 */
export function writeVersion(root, version) {
  if (!VERSION_RE.test(version)) throw new Error(`Invalid version: "${version}"`);
  const out = new Map();
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = readJson(root, file);
    j.version = version;
    out.set(file, JSON.stringify(j, null, 2) + "\n");
  }
  const lock = readJson(root, "package-lock.json");
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  out.set("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  const replace = (file, re, fn) => {
    const text = readFileSync(join(root, file), "utf8");
    if (!re.test(text)) throw new Error(`No version found in ${file}`);
    out.set(file, text.replace(re, fn));
  };
  replace("src-tauri/Cargo.toml", CARGO_TOML_RE, () => `version = "${version}"`);
  replace("src-tauri/Cargo.lock", CARGO_LOCK_RE, (_, head) => `${head}${version}`);
  for (const [file, text] of out) writeFileSync(join(root, file), text);
}
