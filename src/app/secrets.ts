// Secrets in notes, on the app side: "Edit: Encrypt selection" replaces the
// selected text with an encrypted block (text/secrets.ts); a click on the block
// asks for the password and shows the text in a dialog, where it can be copied,
// changed (encrypted again with the same password) or put back in clear.
// The password is never written anywhere; it is kept in memory for 10 minutes
// only when asked to.

import type { Doc, App } from "./app";
import { setSecretHost } from "../editor/secrets";
import { decryptSecret, encryptSecret, SECRET_BEGIN, type SecretBlock } from "../text/secrets";
import { h, icon } from "../ui/dom";
import { confirm, modal, toast } from "../ui/overlay";
import { copyText } from "./files";

const MIN_PASSWORD = 8;
const REMEMBER_MS = 10 * 60 * 1000;

/** The password remembered on request (memory only), until it expires. */
let remembered: { password: string; until: number } | null = null;

function rememberedPassword(): string | null {
  if (remembered && remembered.until > Date.now()) return remembered.password;
  remembered = null;
  return null;
}

function remember(password: string, yes: boolean) {
  remembered = yes ? { password, until: Date.now() + REMEMBER_MS } : null;
}

/** Forgets the remembered password (Edit: Forget the secrets password). */
export function forgetPassword() {
  remembered = null;
  toast("The password is forgotten.");
}

interface PasswordOptions {
  title: string;
  message: string;
  okLabel: string;
  /** Typed twice (a new password). */
  twice?: boolean;
  /** Checks the password while the dialog stays open: an error message, or null when it is right. */
  check?: (password: string) => Promise<string | null>;
}

/** Asks for a password (in a dialog of the page, never stored). */
function askPassword(opts: PasswordOptions): Promise<{ password: string; remember: boolean } | null> {
  return new Promise((resolve) => {
    const field = (placeholder: string) =>
      h("input", { class: "kn-input", type: "password", placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const first = field("Password");
    const second = opts.twice ? field("The same password again") : null;
    const keep = h("input", { type: "checkbox" }) as HTMLInputElement;
    const error = h("div", { class: "kn-modal-error" });
    const ok = h("button", { class: "kn-btn primary" }, opts.okLabel) as HTMLButtonElement;
    let busy = false;
    const finish = (value: { password: string; remember: boolean } | null) => {
      document.removeEventListener("keydown", onKey, true);
      m.close();
      resolve(value);
    };
    const submit = async () => {
      if (busy) return;
      const password = first.value;
      if (opts.twice && password.length < MIN_PASSWORD) return void (error.textContent = `At least ${MIN_PASSWORD} characters.`);
      if (second && second.value !== password) return void (error.textContent = "The two passwords differ.");
      if (!password) return;
      if (opts.check) {
        busy = true;
        ok.disabled = true;
        ok.textContent = "Checking…";
        const message = await opts.check(password);
        busy = false;
        ok.disabled = false;
        ok.textContent = opts.okLabel;
        if (message) {
          error.textContent = message;
          first.select();
          return;
        }
      }
      finish({ password, remember: keep.checked });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) finish(null);
      else if (e.key === "Enter") void submit();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    ok.addEventListener("click", () => void submit());
    const content = h(
      "div",
      { class: "kn-secret-ask" },
      h("div", { class: "kn-modal-title" }, opts.title),
      h("div", { class: "kn-modal-message" }, opts.message),
      first,
      second,
      h("label", { class: "kn-check" }, keep, "Remember it for 10 minutes (in memory only)"),
      error,
      h("div", { class: "kn-modal-actions" }, h("button", { class: "kn-btn", onclick: () => !busy && finish(null) }, "Cancel"), ok),
    );
    const m = modal(content, () => !busy && finish(null));
    document.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => first.focus());
  });
}

/** Edit: Encrypt selection… */
export async function encryptSelection(app: App) {
  const doc = app.active;
  if (!doc) return;
  const { from, to } = app.view.state.selection.main;
  const text = app.view.state.sliceDoc(from, to);
  if (!text.trim()) {
    toast("Select the text to encrypt first (a password, an access, a private line…).");
    return;
  }
  if (text.includes(SECRET_BEGIN)) {
    toast("The selection already holds a secret.", { kind: "error" });
    return;
  }
  const known = rememberedPassword();
  const r = known
    ? { password: known, remember: true }
    : await askPassword({
        title: "Encrypt the selection",
        message:
          "The selected text is replaced in the note by an encrypted block that only this password opens. " +
          "KiloNote cannot recover a forgotten password. If the text was already saved in clear, older copies of the note may remain.",
        okLabel: "Encrypt",
        twice: true,
      });
  if (!r) return;
  remember(r.password, r.remember);
  const block = await encryptSecret(text, r.password);
  // On lines of its own.
  const state = doc === app.active ? app.view.state : doc.state;
  const before = from > state.doc.lineAt(from).from ? "\n" : "";
  const after = to < state.doc.lineAt(to).to ? "\n" : "";
  app.applyToDoc(doc, {
    changes: { from, to, insert: before + block + after },
    selection: { anchor: from + before.length + block.length },
    userEvent: "input.encrypt",
  });
  toast(known ? "Encrypted with the remembered password." : "Encrypted. Click the secret to see it again.");
}

/** Where the secret is now in the note (it may have moved): its range, or null when it was changed. */
function locate(doc: Doc, app: App, armored: string, near: number): SecretBlock | null {
  const text = (doc === app.active ? app.view.state : doc.state).doc.toString();
  let best = -1;
  for (let i = text.indexOf(armored); i >= 0; i = text.indexOf(armored, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best < 0 ? null : { from: best, to: best + armored.length };
}

/** A click on a secret: the password, then the text in a dialog. */
export async function revealSecret(app: App, block: SecretBlock) {
  const doc = app.active;
  if (!doc) return;
  const armored = app.view.state.sliceDoc(block.from, block.to);
  let plain: string | null = null;
  let password = rememberedPassword();
  if (password) plain = await decryptSecret(armored, password).catch(() => null);
  if (plain == null) {
    const r = await askPassword({
      title: "Reveal the secret",
      message: "The password this secret was encrypted with.",
      okLabel: "Reveal",
      check: async (p) => {
        try {
          plain = await decryptSecret(armored, p);
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    });
    if (!r || plain == null) return;
    password = r.password;
    remember(r.password, r.remember);
  }
  showSecret(app, doc, armored, block.from, plain, password!);
}

/** The text of a secret: copy it, change it, or put it back in clear. */
function showSecret(app: App, doc: Doc, armored: string, near: number, plain: string, password: string) {
  const area = h("textarea", { class: "kn-input kn-secret-text", spellcheck: "false", autocomplete: "off", rows: String(Math.min(14, plain.split("\n").length + 1)) }) as HTMLTextAreaElement;
  area.value = plain;
  const save = h("button", { class: "kn-btn primary", disabled: true }, "Save") as HTMLButtonElement;
  area.addEventListener("input", () => (save.disabled = area.value === plain || !area.value.trim()));
  const close = async () => {
    if (area.value !== plain) {
      const r = await confirm({ title: "Discard your changes to the secret?", okLabel: "Discard", danger: true });
      if (r !== "ok") return;
    }
    done();
  };
  const done = () => {
    area.value = "";
    document.removeEventListener("keydown", onKey, true);
    m.close();
  };
  const replace = (insert: string, userEvent: string): boolean => {
    const at = locate(doc, app, armored, near);
    if (!at) {
      toast("The secret was changed in the note meanwhile: nothing was replaced.", { kind: "error" });
      return false;
    }
    app.applyToDoc(doc, { changes: { from: at.from, to: at.to, insert }, userEvent });
    return true;
  };
  save.addEventListener("click", async () => {
    save.disabled = true;
    if (replace(await encryptSecret(area.value, password), "input.encrypt")) done();
  });
  const clear = async () => {
    const r = await confirm({
      title: "Put the text back in clear?",
      message: "The secret is replaced by its text, readable by anyone who opens the note, and saved so.",
      okLabel: "Decrypt into the note",
      danger: true,
    });
    if (r === "ok" && replace(area.value, "input.decrypt")) done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || document.querySelectorAll(".kn-modal").length > 1) return;
    e.preventDefault();
    e.stopPropagation();
    void close();
  };
  const content = h(
    "div",
    { class: "kn-secret-show" },
    h("div", { class: "kn-modal-title kn-secret-title" }, icon("lock"), "Secret"),
    area,
    h("div", { class: "kn-modal-actions" },
      h("button", { class: "kn-btn subtle", onclick: () => void copyText(area.value, "Secret copied") }, "Copy"),
      h("button", { class: "kn-btn subtle", onclick: () => void clear() }, "Decrypt into the note…"),
      h("span", { class: "kn-spacer" }),
      h("button", { class: "kn-btn", onclick: () => void close() }, "Close"),
      save),
  );
  const m = modal(content, () => void close());
  document.addEventListener("keydown", onKey, true);
  requestAnimationFrame(() => area.focus());
}

export function installSecrets(app: App) {
  let lastRefusal = 0;
  setSecretHost({
    reveal: (view, block) => view === app.view && void revealSecret(app, block),
    refused: () => {
      if (Date.now() - lastRefusal < 3000) return;
      lastRefusal = Date.now();
      setTimeout(() => toast("A secret only changes as a whole: click it to change its text."));
    },
  });
}
