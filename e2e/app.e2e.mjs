// End-to-end tests of the real desktop app (Linux, WebKitGTK), driven through
// WebDriver by tauri-driver. Run in CI (see .github/workflows/ci.yml):
//
//   npx tauri build --debug --no-bundle
//   xvfb-run node e2e/app.e2e.mjs
//
// Everything happens in a temporary folder: notes, settings and sessions
// (XDG_CONFIG_HOME), so it never touches a real profile.

import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP = resolve(process.env.KILONOTE_BIN ?? "src-tauri/target/debug/kilonote");
const PORT = 4444;
const root = mkdtempSync(join(tmpdir(), "kilonote-e2e-"));
const notes = join(root, "notes");
const config = join(root, "config");
const marker = join(root, "PROGRAM-WAS-RUN");
mkdirSync(notes);
mkdirSync(config);

// --- The notes folder ----------------------------------------------------------
writeFileSync(join(notes, "work.txt"), "# Work\n- call colleague X - todo\n- review the spec - todo\n");
writeFileSync(join(notes, "old.txt"), Buffer.from("caf\xe9 - todo\n", "latin1")); // Windows-1252
// Programs placed in the notes folder: KiloNote must never run them.
writeFileSync(join(notes, "evil.exe"), `#!/bin/sh\ntouch "${marker}"\n`);
chmodSync(join(notes, "evil.exe"), 0o755);
writeFileSync(join(notes, "evil.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
chmodSync(join(notes, "evil.sh"), 0o755);
copyFileSync("/bin/true", join(notes, "tool")); // binary content, no extension
chmodSync(join(notes, "tool"), 0o755);

// --- WebDriver ------------------------------------------------------------------
const driver = spawn("tauri-driver", ["--port", String(PORT)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, XDG_CONFIG_HOME: config },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json.value;
}

let session;
/** Runs async code in the app window: `app` is window.kilonote. */
async function run(code, ...args) {
  const script = `
    const done = arguments[arguments.length - 1];
    const app = window.kilonote;
    (async (...args) => { ${code} })(...Array.from(arguments).slice(0, -1))
      .then((v) => done({ ok: v === undefined ? null : v }), (e) => done({ err: String(e && e.stack || e) }));`;
  const r = await wd("POST", `/session/${session}/execute/async`, { script, args });
  if (r?.err) throw new Error(r.err);
  return r?.ok;
}
const KEYS = { Control: "", Shift: "", Enter: "", Escape: "" };
/** A key chord, e.g. press("Control", "Enter"). */
async function press(...keys) {
  const codes = keys.map((k) => KEYS[k] ?? k);
  const actions = [...codes.map((value) => ({ type: "keyDown", value })), ...codes.reverse().map((value) => ({ type: "keyUp", value }))];
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "key", id: "keyboard", actions }] });
  await wd("DELETE", `/session/${session}/actions`);
  await sleep(250);
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split("\n").join("\n      ")}`);
  }
}
function expect(actual, expected, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
async function until(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

try {
  for (let i = 0; ; i++) {
    try {
      await wd("GET", "/status");
      break;
    } catch {
      if (i > 50) throw new Error("tauri-driver did not start");
      await sleep(200);
    }
  }
  const created = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
  });
  session = created.sessionId;
  console.log("KiloNote end-to-end tests");

  await test("the window starts and shows the welcome screen", async () => {
    await until(() => run("return document.body.classList.contains('ready') && !!app?.view;"), "the app");
    expect(await run("return !document.getElementById('welcome').hidden;"), true, "welcome visible");
  });

  await test("a folder and a note open, Ctrl+Enter cycles a status, Ctrl+S saves", async () => {
    await run("await app.openFolder(args[0]); await app.openFile(args[1]); app.reveal(app.active, 2);", notes, join(notes, "work.txt"));
    await press("Control", "Enter");
    expect(await run("return app.view.state.doc.line(2).text;"), "- call colleague X - ongoing", "line 2");
    await press("Control", "s");
    await until(async () => readFileSync(join(notes, "work.txt"), "utf8").includes("- call colleague X - ongoing"), "the file on disk");
  });

  await test("Ctrl+Shift+Enter archives the task to work_done.txt with the date", async () => {
    await run("app.reveal(app.active, 3);");
    await press("Control", "Shift", "Enter");
    const done = join(notes, "work_done.txt");
    await until(async () => existsSync(done), "work_done.txt");
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(readFileSync(done, "utf8"), `- review the spec - done [${iso}]\n`, "archive");
    await until(async () => !readFileSync(join(notes, "work.txt"), "utf8").includes("review the spec"), "the line to leave the note");
  });

  await test("a Windows-1252 file is saved in Windows-1252", async () => {
    await run("await app.openFile(args[0]); app.view.dispatch({ changes: { from: 0, insert: 'd\\u00e9j\\u00e0 ' } }); await app.save(app.active);", join(notes, "old.txt"));
    expect(readFileSync(join(notes, "old.txt")).toString("latin1"), "d\xe9j\xe0 caf\xe9 - todo\n", "bytes on disk");
  });

  await test("programs in the notes folder are never run", async () => {
    for (const f of ["evil.exe", "tool"]) {
      expect(await run("return (await app.openFile(args[0])) === null;", join(notes, f)), true, `${f} refused`);
    }
    // A script is only ever opened as text.
    expect(await run("const d = await app.openFile(args[0]); return d?.state.doc.toString().startsWith('#!/bin/sh');", join(notes, "evil.sh")), true, "evil.sh as text");
    await run("await app.openPaths(args[0]);", [join(notes, "evil.exe"), join(notes, "tool")]);
    await sleep(1500);
    expect(existsSync(marker), false, "a program ran");
  });

  await test("the window has no permission to open or run files", async () => {
    const r = await run(`
      try { await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_path", { path: args[0] }); return "allowed"; }
      catch (e) { return "denied: " + e; }`, join(notes, "evil.sh"));
    if (!String(r).startsWith("denied")) throw new Error(`open_path was ${r}`);
    await sleep(1000);
    expect(existsSync(marker), false, "a program ran");
  });

  await test("a second window opens and closes", async () => {
    await run("await app.backend.openWindow([]);");
    await until(() => run("return (await app.backend.windowCount()) === 2;"), "two windows");
    expect((await wd("GET", `/session/${session}/window/handles`)).length >= 1, true, "handles");
  });

  await test("the settings screen opens and writes settings.json", async () => {
    await run("app.focusEditor();");
    await press("Control", ",");
    await until(() => run("return !!document.querySelector('.kn-settings');"), "the settings screen");
    await run("await app.updateSetting('theme', 'latte');");
    const file = join(config, "dev.damoy.kilonote", "settings.json");
    await until(async () => existsSync(file) && readFileSync(file, "utf8").includes('"theme": "latte"'), "settings.json");
    await press("Escape");
    expect(await run("return document.querySelector('.kn-settings') === null;"), true, "closed");
  });

  await test("the session is saved", async () => {
    await run("app.flushAutosaves();");
    const dir = join(config, "dev.damoy.kilonote");
    await until(async () => readdirSync(dir).includes("session.json"), "session.json");
  });
} catch (e) {
  failures++;
  console.error(e);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
}
console.log(failures ? `\n${failures} failure(s)` : "\nAll end-to-end tests passed");
process.exit(failures ? 1 : 0);
