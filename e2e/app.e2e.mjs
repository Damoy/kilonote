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
writeFileSync(join(notes, "data.json"), '{"name":"kilo","tags":["a","b"]}');
writeFileSync(join(notes, "page.html"), '<h1>Page</h1><script>window.parent.PWNED = 1</script><img src="https://example.com/x.png" onerror="window.parent.PWNED = 2">');
writeFileSync(join(notes, "flow.mmd"), "flowchart LR\n  A[Note] --> B{Task?}\n  B -- yes --> C[Done]\n");
writeFileSync(join(notes, "shop.sql"), "CREATE TABLE customers (id INT PRIMARY KEY, name TEXT);\nCREATE TABLE orders (id INT PRIMARY KEY, customer_id INT REFERENCES customers(id));\nINSERT INTO customers VALUES (1, 'Acme');\n");
writeFileSync(join(notes, "conf.xml"), '<?xml version="1.0"?>\n<config env="prod"><title>Kilo</title><item id="1">a</item></config>\n');
writeFileSync(join(notes, "build.py"), "import os\n\ndef main():\n    return 1  # done\n");
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
const KEYS = { Control: "", Shift: "", Alt: "", Enter: "", Escape: "", F3: "" };
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

  await test("the shortcuts cheat sheet shows at the first start and closes with Escape", async () => {
    expect(await run("return !!document.querySelector('.kn-cheatsheet');"), true, "cheat sheet");
    await press("Escape");
    expect(await run("return document.querySelector('.kn-cheatsheet') === null;"), true, "closed");
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

  await test("the window has no permission to open or run files, nor to open other addresses than web and mail links", async () => {
    const r = await run(`
      try { await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_path", { path: args[0] }); return "allowed"; }
      catch (e) { return "denied: " + e; }`, join(notes, "evil.sh"));
    if (!String(r).startsWith("denied")) throw new Error(`open_path was ${r}`);
    // Links: web pages and e-mail addresses only, never a file or another protocol.
    for (const url of ["file:///etc/hostname", "tel:123", "x-unknown-scheme:test"]) {
      const u = await run(`
        try { await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: args[0] }); return "allowed"; }
        catch (e) { return "denied: " + e; }`, url);
      if (!String(u).startsWith("denied")) throw new Error(`open_url(${url}) was ${u}`);
    }
    await sleep(1000);
    expect(existsSync(marker), false, "a program ran");
  });

  await test("code files are colored, and Shift+Alt+F formats JSON", async () => {
    await run("await app.openFile(args[0]);", join(notes, "build.py"));
    expect(await run("return app.active.lang;"), "python", "language");
    await until(() => run("return document.querySelectorAll('.cm-content span').length > 2;"), "the Python coloring");
    await run("await app.openFile(args[0]); app.focusEditor();", join(notes, "data.json"));
    await press("Shift", "Alt", "f");
    expect(await run("return app.view.state.doc.toString();"), '{\n    "name": "kilo",\n    "tags": ["a", "b"]\n}\n', "formatted");
  });

  await test("an HTML page is previewed without running its scripts; JSON gets an editable tree", async () => {
    await run("await app.openFile(args[0]); app.preview.open.clear(); app.preview.toggle();", join(notes, "page.html"));
    await until(() => run("return document.querySelector('.pv-frame')?.contentDocument?.querySelector('h1')?.textContent === 'Page';"), "the page preview");
    await sleep(500);
    expect(await run("return window.PWNED ?? null;"), null, "a script of the page ran");
    await run("await app.openFile(args[0]); app.preview.toggle();", join(notes, "data.json"));
    await until(() => run("return document.querySelectorAll('.tv-row').length > 2;"), "the tree");
    await run(`const row = [...document.querySelectorAll('.tv-row')].find((r) => r.textContent.startsWith('name'));
      row.querySelector('.tv-val').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = document.querySelector('.tv-edit');
      input.value = 'note';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
    expect(await run("return app.view.state.doc.toString().includes('\"name\": \"note\"');"), true, "value edited from the tree");
    await run("app.preview.toggle();");
  });

  await test("Mermaid diagrams, the SQL schema and the XML tree are drawn in the real app", async () => {
    await run("await app.openFile(args[0]); app.preview.open = new Set(['diagram', 'sql', 'tree']); app.preview.update(true);", join(notes, "flow.mmd"));
    await until(() => run("const i = document.querySelector('#preview .dv-img'); return !!i && i.naturalWidth > 20;"), "the Mermaid diagram");
    await run("await app.openFile(args[0]);", join(notes, "shop.sql"));
    await until(() => run("const i = document.querySelector('.sv .dv-img'); return !!i && i.naturalWidth > 20 && document.querySelectorAll('.sv-table').length === 2;"), "the SQL schema");
    await run("await app.openFile(args[0]);", join(notes, "conf.xml"));
    await until(() => run("return [...document.querySelectorAll('.tv-row')].some((r) => r.textContent === '@env:\"prod\"');"), "the XML tree");
    await run("app.preview.open.clear(); app.preview.update(true);");
  });

  await test("a pasted image is saved next to the note and shown under its line", async () => {
    // A real 2×2 PNG, pasted as the clipboard would hand it over.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAPgAJ/iXlGXwAAAABJRU5ErkJggg==";
    writeFileSync(join(notes, "shots é.md"), "# Shots\n");
    await run(`await app.openFile(args[0]); app.focusEditor(); app.view.dispatch({ selection: { anchor: app.view.state.doc.length } });
      const bytes = Uint8Array.from(atob(args[1]), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      app.view.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));`, join(notes, "shots é.md"), png);
    const name = await until(async () => existsSync(join(notes, "images")) && readdirSync(join(notes, "images")).find((f) => f.endsWith(".png")), "the image file");
    expect(readFileSync(join(notes, "images", name)).equals(Buffer.from(png, "base64")), true, "the bytes of the saved image");
    await until(() => run("const i = document.querySelector('#editor-host .cm-note-image'); return !!i && i.naturalWidth === 2;"), "the image under its line");
    expect(await run("return app.view.state.doc.toString();"), `# Shots\n![image](images/${name})`, "the note");
    // The native side refuses other files, and never writes over a file.
    const refused = await run(`const out = [];
      for (const p of [args[0], args[1], args[2]]) { try { await app.backend.writeImage(p, new Uint8Array([1, 2])); out.push("written"); } catch (e) { out.push(String(e)); } }
      try { await app.backend.readImage(args[3]); out.push("read"); } catch (e) { out.push(String(e)); }
      return out;`, join(notes, "images", name), join(notes, "run.sh"), join(notes, "work.txt"), join(notes, "work.txt"));
    expect(refused, ["exists", "not an image", "not an image", "not an image"], "what the image commands refuse");
    expect(readFileSync(join(notes, "images", name)).equals(Buffer.from(png, "base64")), true, "the image after a second write");
    expect(existsSync(join(notes, "run.sh")), false, "a script written by the image command");
  });

  await test("the selected text and the search are counted in the whole note", async () => {
    writeFileSync(join(notes, "count.txt"), `-- Stockviz\n${"filler\n".repeat(300)}-- Stockviz\n`);
    await run(`await app.openFile(args[0]); app.focusEditor();
      const l = app.view.state.doc.line(1); app.view.dispatch({ selection: { anchor: l.from, head: l.to } });`, join(notes, "count.txt"));
    await until(() => run("return document.querySelector('.st-occ')?.textContent === '2 occurrences';"), "the count in the status bar");
    await until(() => run("return document.querySelectorAll('#editor-host .cm-match-ruler i.occ').length === 2;"), "the marks along the scrollbar");
    await press("Control", "F3");
    expect(await run("return app.view.state.doc.lineAt(app.view.state.selection.main.from).number;"), 302, "the line of the next occurrence");
    await press("Control", "f");
    await until(() => run("return document.querySelector('#editor-host .cm-search-count')?.textContent === '2 of 2';"), "the count next to the search field");
    await press("Escape");
  });

  await test("the text of a page can be edited in its preview, and lands escaped in the HTML", async () => {
    await run("await app.openFile(args[0]); app.preview.open = new Set(['html']); app.preview.setHtmlEdit(true);", join(notes, "page.html"));
    await until(() => run("return !!document.querySelector('.pv-frame').contentDocument.querySelector('kn-t[contenteditable]');"), "the editable page");
    await run(`const run = document.querySelector('.pv-frame').contentDocument.querySelector('h1 kn-t');
      run.textContent = 'Page <b>2';`);
    await until(() => run("return app.view.state.doc.toString().startsWith('<h1>Page &lt;b&gt;2</h1>');"), "the HTML to follow");
    expect(await run("return window.PWNED ?? null;"), null, "a script of the page ran");
    await run("app.preview.setHtmlEdit(false); app.preview.open.clear(); app.preview.update(true);");
  });

  await test("Ctrl+Shift+O opens the folder picker, even with the cheat sheet open", async () => {
    await run("window.__picked = 0; app.backend.pickFolder = async () => { window.__picked++; return null; };");
    await run("document.querySelector('.st-item[title^=\"Keyboard shortcuts\"]').click();");
    expect(await run("return !!document.querySelector('.kn-cheatsheet');"), true, "cheat sheet open");
    await press("Control", "Shift", "o");
    await until(() => run("return window.__picked === 1;"), "the folder picker");
    expect(await run("return document.querySelector('.kn-cheatsheet') === null;"), true, "cheat sheet closed");
  });

  await test("Ctrl+Shift+N opens a second window", async () => {
    await run("app.focusEditor();");
    await press("Control", "Shift", "n");
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
