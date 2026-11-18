#!/usr/bin/env node
// Fails when the five places that hold the version of KiloNote disagree (a half
// bump), and prints them. Run by CI and by the release workflow.
//
//   node scripts/check-versions.mjs      → prints the version when all agree

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVersions } from "./versions.mjs";

const root = process.env.KILONOTE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const versions = readVersions(root);
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(null)) {
  console.error("The version is not the same everywhere (run: npm run version:bump -- X.Y.Z):");
  for (const [file, v] of Object.entries(versions)) console.error(`  ${file}: ${v ?? "(not found)"}`);
  process.exit(1);
}
console.log([...distinct][0]);
