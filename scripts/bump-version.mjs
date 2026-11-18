#!/usr/bin/env node
// Bumps the version of KiloNote in the five places that hold it (see versions.mjs),
// then prints the new version. No git work: commit "Version X.Y.Z" yourself (or use
// scripts/release.sh on a PC, which does everything).
//
//   node scripts/bump-version.mjs patch|minor|major|X.Y.Z
//   node scripts/bump-version.mjs minor --print     → prints the next version, changes nothing
//   npm run version:bump -- patch
//
// The version is read from package.json. KILONOTE_ROOT points to another copy of the
// repository (tests).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextVersion, readVersions, writeVersion } from "./versions.mjs";

const root = process.env.KILONOTE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const print = args.includes("--print");
const bump = args.find((a) => !a.startsWith("--"));

try {
  if (!bump) throw new Error("Give patch, minor, major or a version X.Y.Z");
  const current = readVersions(root)["package.json"];
  if (!current) throw new Error("No version in package.json");
  const next = nextVersion(current, bump);
  if (!print && next !== current) writeVersion(root, next);
  console.log(next);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
