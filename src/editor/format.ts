// "Format document": JSON (comments kept), XML / HTML, CSS and Markdown tables.
// Pure functions, no dependency: each one returns the formatted text or
// throws a FormatError that points at the problem.

export class FormatError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

/** Deeper documents are refused (instead of running out of stack). */
export const MAX_DEPTH = 500;

export function tooDeep(text: string, pos: number): FormatError {
  return new FormatError(`Nested more than ${MAX_DEPTH} levels deep at ${where(text, pos)}: too deep to format or show as a tree.`, pos);
}

/** "line 3, column 7" for an offset of `text`. */
export function where(text: string, pos: number): string {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  return `line ${line}, column ${col}`;
}

// ---------------------------------------------------------------------------
// JSON (and JSONC / JSON5-ish: comments, trailing commas, single quotes)

export type JTok = {
  t: "{" | "}" | "[" | "]" | ":" | "," | "str" | "num" | "lit" | "comment";
  v: string;
  pos: number;
  /** Line breaks just before the token. */
  nl: number;
  /** Comments before the token (on their own lines). */
  lead: JTok[];
  /** Comments right after the token, on the same line. */
  trail: JTok[];
};

export function jsonTokens(text: string): { toks: JTok[]; end: JTok[] } {
  const raw: JTok[] = [];
  let i = 0;
  let nl = 0;
  const push = (t: JTok["t"], v: string, pos: number) => {
    raw.push({ t, v, pos, nl, lead: [], trail: [] });
    nl = 0;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      nl++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r" || c === "﻿") i++;
    else if (c === "/" && text[i + 1] === "/") {
      let j = text.indexOf("\n", i);
      if (j < 0) j = text.length;
      push("comment", text.slice(i, j).trimEnd(), i);
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) throw new FormatError(`Unterminated comment at ${where(text, i)}`, i);
      push("comment", text.slice(i, j + 2), i);
      i = j + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\n") break;
        j += text[j] === "\\" ? 2 : 1;
      }
      if (text[j] !== c) throw new FormatError(`Unterminated string at ${where(text, i)}`, i);
      push("str", text.slice(i, j + 1), i);
      i = j + 1;
    } else if ("{}[]:,".includes(c)) {
      push(c as JTok["t"], c, i);
      i++;
    } else {
      const m = /^(?:[+-]?(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|Infinity|NaN))|^[A-Za-z_$][\w$]*/i.exec(text.slice(i, i + 400));
      if (!m) throw new FormatError(`Unexpected character "${c}" at ${where(text, i)}`, i);
      push(/^[A-Za-z_$]/.test(m[0]) && !/^(?:Infinity|NaN)$/.test(m[0]) ? "lit" : "num", m[0], i);
      i += m[0].length;
    }
  }
  // Comments become leading (own line) or trailing (same line as a token).
  const toks: JTok[] = [];
  let pending: JTok[] = [];
  for (const t of raw) {
    if (t.t === "comment") {
      const prev = toks[toks.length - 1];
      if (prev && t.nl === 0 && !pending.length) prev.trail.push(t);
      else pending.push(t);
    } else {
      t.lead = pending;
      // The blank line before a comment block belongs to the token after it.
      if (pending.length) t.nl = pending[0].nl;
      pending = [];
      toks.push(t);
    }
  }
  return { toks, end: pending };
}

/** Pretty-prints JSON with `indent`, keeping comments and blank lines between entries. */
export function formatJson(text: string, indent = "  "): string {
  const { toks, end } = jsonTokens(text);
  if (!toks.length) throw new FormatError("The document contains no JSON value.", 0);
  let k = 0;
  let out = "";
  const peek = () => toks[k];
  const next = (): JTok => {
    const t = toks[k++];
    if (!t) throw new FormatError("Unexpected end of the document: a bracket is not closed.", text.length);
    return t;
  };
  const expect = (t: JTok["t"], what: string) => {
    const tok = next();
    if (tok.t !== t) throw new FormatError(`Expected ${what} at ${where(text, tok.pos)}, found "${tok.v}"`, tok.pos);
    return tok;
  };
  const column = () => out.length - out.lastIndexOf("\n") - 1;
  const newline = (depth: number) => (out += "\n" + indent.repeat(depth));
  const trails = (tok: JTok) => {
    for (const c of tok.trail) out += " " + c.v;
  };
  /** Leading comments of a token that starts a line. */
  const leads = (tok: JTok, depth: number) => {
    for (const c of tok.lead) {
      out += c.v;
      newline(depth);
    }
  };
  /** Comments are kept on their own lines; a line comment always ends its line. */
  const inlineLeads = (tok: JTok, depth: number) => {
    for (const c of tok.lead) {
      if (c.v.startsWith("//")) {
        out += c.v;
        newline(depth);
      } else out += c.v + " ";
    }
  };

  /** An array of plain values that fits on one line stays on one line. */
  const inlineArray = (): string | null => {
    const parts: string[] = [];
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (t.lead.length || t.trail.length) return null;
      if (t.t === "]") return `[${parts.join(", ")}]`;
      if (t.t === "{" || t.t === "[" || t.t === ":") return null;
      if (t.t !== ",") parts.push(t.v);
    }
    return null;
  };

  const value = (depth: number) => {
    const tok = next();
    if (tok.t === "{" || tok.t === "[") return container(tok, depth);
    if (tok.t === "str" || tok.t === "num" || tok.t === "lit") {
      out += tok.v;
      return tok;
    }
    throw new FormatError(`Expected a value at ${where(text, tok.pos)}, found "${tok.v}"`, tok.pos);
  };

  const container = (open: JTok, depth: number): JTok => {
    if (depth >= MAX_DEPTH) throw tooDeep(text, open.pos);
    const close = open.t === "{" ? "}" : "]";
    out += open.v;
    if (open.t === "[") {
      const flat = inlineArray();
      if (flat && column() + flat.length <= 100) {
        out = out.slice(0, -1) + flat;
        while (toks[k].t !== "]") k++;
        return next();
      }
    }
    trails(open);
    let first = true;
    for (;;) {
      const tok = peek();
      if (!tok) throw new FormatError(`"${open.v}" opened at ${where(text, open.pos)} is never closed.`, open.pos);
      if (tok.t === close) {
        next();
        if (!first || tok.lead.length) {
          newline(depth + 1);
          if (tok.lead.length) {
            leads(tok, depth + 1);
            out = out.trimEnd();
          }
          out = out.replace(/[ \t]+$/, "");
          newline(depth);
          // No empty line before the closing bracket.
          out = out.replace(/\n[ \t]*\n([ \t]*)$/, "\n$1");
        }
        out += close;
        return tok;
      }
      if (tok.t === "]" || tok.t === "}") throw new FormatError(`Unexpected "${tok.v}" at ${where(text, tok.pos)}: "${open.v}" is closed with "${close}".`, tok.pos);
      if (!first && tok.nl >= 2) out += "\n";
      newline(depth + 1);
      leads(tok, depth + 1);
      let last: JTok;
      if (open.t === "{") {
        const key = next();
        if (key.t !== "str" && key.t !== "lit" && key.t !== "num") throw new FormatError(`Expected a key at ${where(text, key.pos)}, found "${key.v}"`, key.pos);
        out += key.v;
        trails(key);
        const colon = expect(":", '":" after the key');
        out += ": ";
        trails(colon);
        const v = peek();
        if (v) inlineLeads(v, depth + 1);
        if (v) v.lead = [];
        last = value(depth + 1);
      } else last = value(depth + 1);
      first = false;
      const after = peek();
      if (after?.t === ",") {
        const comma = next();
        out += ",";
        trails(last);
        trails(comma);
      } else {
        trails(last);
        if (after && after.t !== close) {
          throw new FormatError(`Expected "," or "${close}" at ${where(text, after.pos)}, found "${after.v}"`, after.pos);
        }
      }
    }
  };

  leads(toks[0], 0);
  value(0);
  if (k < toks.length) throw new FormatError(`Unexpected "${toks[k].v}" after the end of the JSON value, at ${where(text, toks[k].pos)}`, toks[k].pos);
  trails(toks[k - 1]);
  for (const c of end) {
    out += c.nl ? "\n" + c.v : " " + c.v;
  }
  return out + "\n";
}

/** JSON on one line (comments dropped). */
export function minifyJson(text: string): string {
  formatJson(text); // validates
  return jsonTokens(text).toks.map((t) => t.v).join("");
}

// ---------------------------------------------------------------------------
// XML / HTML

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const RAW = new Set(["script", "style", "pre", "textarea"]);

type XNode =
  | { k: "el"; name: string; open: string; close: string | null; children: XNode[]; start: number; innerFrom: number; innerTo: number }
  | { k: "text"; v: string }
  | { k: "other"; v: string };

/** Whitespace in a tag collapsed to single spaces (outside the attribute values). */
function tidyTag(tag: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of tag) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (/\s/.test(ch)) {
      if (!out.endsWith(" ")) out += " ";
    } else out += ch;
  }
  // "<a  href='x' >" → "<a href='x'>" ("<br />" and "<br/>" stay as written).
  return out.replace(/ >$/, ">").trim();
}

export function formatXml(text: string, indent = "  ", html = false): string {
  const root: XNode & { k: "el" } = { k: "el", name: "", open: "", close: null, children: [], start: 0, innerFrom: 0, innerTo: text.length };
  const stack: (XNode & { k: "el" })[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const lower = (s: string) => (html ? s.toLowerCase() : s);
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? text.length : lt;
      top().children.push({ k: "text", v: text.slice(i, end) });
      i = end;
      continue;
    }
    const special = (open: string, close: string) => {
      if (!text.startsWith(open, i)) return false;
      const j = text.indexOf(close, i + open.length);
      if (j < 0) throw new FormatError(`"${open}" at ${where(text, i)} is never closed.`, i);
      top().children.push({ k: "other", v: text.slice(i, j + close.length) });
      i = j + close.length;
      return true;
    };
    if (special("<!--", "-->") || special("<![CDATA[", "]]>") || special("<?", "?>")) continue;
    // The end of the tag, skipping ">" inside attribute values.
    let j = i + 1;
    let quote: string | null = null;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (j >= text.length) throw new FormatError(`Unclosed tag at ${where(text, i)}`, i);
    const tag = text.slice(i, j + 1);
    if (tag.startsWith("<!")) {
      top().children.push({ k: "other", v: tidyTag(tag) });
      i = j + 1;
      continue;
    }
    const close = /^<\/\s*([^\s>]+)\s*>$/.exec(tag);
    if (close) {
      const name = lower(close[1]);
      let at = stack.length - 1;
      while (at > 0 && stack[at].name !== name) at--;
      if (at === 0) {
        if (!html) throw new FormatError(`Closing tag </${close[1]}> at ${where(text, i)} matches no open tag.`, i);
        top().children.push({ k: "text", v: tag }); // stray closing tag: kept as is
      } else {
        if (!html && at !== stack.length - 1) {
          const open = top();
          throw new FormatError(`<${open.name}> opened at ${where(text, open.start)} is closed by </${close[1]}> at ${where(text, i)}.`, i);
        }
        // Elements left open (HTML: <li>, <p>…) end where their parent closes.
        while (stack.length - 1 > at) stack.pop()!.innerTo = i;
        const el = stack.pop()!;
        el.close = tag;
        el.innerTo = i;
      }
      i = j + 1;
      continue;
    }
    const m = /^<([^\s/>]+)/.exec(tag);
    if (!m) throw new FormatError(`Invalid tag at ${where(text, i)}`, i);
    const name = lower(m[1]);
    const el: XNode & { k: "el" } = { k: "el", name, open: tidyTag(tag), close: null, children: [], start: i, innerFrom: j + 1, innerTo: j + 1 };
    top().children.push(el);
    i = j + 1;
    if (/\/\s*>$/.test(tag) || (html && VOID.has(name))) continue;
    if (html && RAW.has(name)) {
      // Kept exactly as written.
      const re = new RegExp(`</\\s*${name}\\s*>`, "i");
      const rest = re.exec(text.slice(i));
      const end = rest ? i + rest.index : text.length;
      el.children.push({ k: "other", v: text.slice(i, end) });
      el.innerTo = end;
      el.close = rest ? rest[0] : null;
      i = rest ? end + rest[0].length : end;
      continue;
    }
    if (stack.length > MAX_DEPTH) throw tooDeep(text, i);
    stack.push(el);
  }
  if (!html && stack.length > 1) {
    const open = top();
    throw new FormatError(`<${open.name}> opened at ${where(text, open.start)} is never closed.`, open.start);
  }
  for (const el of stack) el.innerTo = text.length;

  const lines: string[] = [];
  const pad = (d: number) => indent.repeat(d);
  const hasText = (n: XNode & { k: "el" }) => n.children.some((c) => c.k === "text" && c.v.trim());
  const print = (n: XNode, d: number) => {
    if (n.k === "text") {
      const v = n.v.trim();
      if (v) for (const l of v.split("\n")) lines.push(pad(d) + l.trim());
      return;
    }
    if (n.k === "other") {
      const v = n.v.replace(/^\n+|\s+$/g, "");
      if (!v) return;
      // Verbatim blocks (comments, CDATA, scripts): first line indented, the rest as written.
      const [first, ...rest] = v.split("\n");
      lines.push(pad(d) + first.trim(), ...rest);
      return;
    }
    if (n.children.length === 0) {
      lines.push(pad(d) + n.open + (n.close ?? ""));
      return;
    }
    const rawOnly = n.children.length === 1 && n.children[0].k === "other" && html && RAW.has(n.name);
    if (rawOnly) {
      // <script>, <style>, <pre>, <textarea>: the content stays exactly as written.
      lines.push(pad(d) + n.open + (n.children[0] as { v: string }).v + (n.close ?? ""));
      return;
    }
    if (hasText(n)) {
      // Mixed content (text and inline tags) stays as written.
      const inner = text.slice(n.innerFrom, n.innerTo).trim();
      if (!inner.includes("\n")) lines.push(pad(d) + n.open + inner + (n.close ?? ""));
      else {
        lines.push(pad(d) + n.open);
        for (const l of inner.split("\n")) if (l.trim()) lines.push(pad(d + 1) + l.trim());
        if (n.close) lines.push(pad(d) + n.close);
      }
      return;
    }
    lines.push(pad(d) + n.open);
    for (const c of n.children) print(c, d + 1);
    if (n.close) lines.push(pad(d) + n.close);
  };
  for (const c of root.children) print(c, 0);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CSS (also SCSS / Less: nested rules)

export function formatCss(text: string, indent = "  "): string {
  const out: string[] = [];
  let depth = 0;
  let seg = "";
  let parens = 0;
  const pad = () => indent.repeat(depth);
  const flush = (kind: "{" | "}" | ";" | "end", at = text.length) => {
    let s = seg.replace(/\s+/g, " ").trim();
    seg = "";
    if (kind === "{") {
      s = s.replace(/\s*,\s*/g, ", ");
      if (depth === 0 && out.length && out[out.length - 1] !== "") out.push("");
      out.push(`${pad()}${s} {`);
      depth++;
      return;
    }
    if (s) {
      // "color:red" → "color: red" (not in selectors such as a:hover).
      s = s.replace(/^([-\w$@]+)\s*:\s*/, "$1: ");
      out.push(`${pad()}${s}${kind === "end" && depth === 0 ? "" : ";"}`);
    }
    if (kind === "}") {
      if (depth === 0) throw new FormatError(`Unexpected "}" at ${where(text, at)}`, at);
      depth--;
      out.push(`${pad()}}`);
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) throw new FormatError(`Unterminated comment at ${where(text, i)}`, i);
      const comment = text.slice(i, j + 2);
      if (seg.trim()) seg += comment;
      else {
        if (depth === 0 && out.length && out[out.length - 1] !== "" && /\n\s*\n\s*$/.test(text.slice(0, i))) out.push("");
        out.push(pad() + comment.split("\n").map((l, n) => (n ? l.trimEnd() : l)).join("\n"));
      }
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/" && parens === 0 && !/:$/.test(seg)) {
      // SCSS / Less line comment (not "http://" inside url()).
      let j = text.indexOf("\n", i);
      if (j < 0) j = text.length;
      out.push(pad() + text.slice(i, j).trim());
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      seg += text.slice(i, j + 1);
      i = j;
    } else if (c === "(") {
      parens++;
      seg += c;
    } else if (c === ")") {
      parens = Math.max(0, parens - 1);
      seg += c;
    } else if (parens === 0 && (c === "{" || c === "}" || c === ";")) flush(c, i);
    else seg += c;
  }
  flush("end");
  if (depth > 0) throw new FormatError("A \"{\" is never closed.", text.length);
  return out.join("\n").replace(/\{\n(\s*)\}/g, "{}") + "\n";
}

// ---------------------------------------------------------------------------
// Markdown tables: columns aligned

const DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Display width (a wide character such as 漢 or an emoji counts double). */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}

/** Aligns every Markdown table of the text; the rest is left untouched. */
export function alignMarkdownTables(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|") || !DELIM.test(lines[i + 1]) || !lines[i + 1].includes("-")) continue;
    let end = i + 2;
    while (end < lines.length && lines[end].includes("|") && lines[end].trim()) end++;
    const lead = /^\s*/.exec(lines[i])![0];
    const rows = lines.slice(i, end).map(splitRow);
    const cols = Math.max(...rows.map((r) => r.length));
    const align = rows[1].map((c) => (c.startsWith(":") && c.endsWith(":") ? "c" : c.endsWith(":") ? "r" : c.startsWith(":") ? "l" : ""));
    const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.filter((_, r) => r !== 1).map((r) => width(r[c] ?? ""))));
    const fmt = (cells: string[], r: number) =>
      lead + "| " + widths.map((w, c) => {
        if (r === 1) {
          const a = align[c] ?? "";
          return (a === "l" || a === "c" ? ":" : "-") + "-".repeat(w - 2) + (a === "r" || a === "c" ? ":" : "-");
        }
        const v = cells[c] ?? "";
        const gap = w - width(v);
        if (align[c] === "r") return " ".repeat(gap) + v;
        if (align[c] === "c") return " ".repeat(Math.floor(gap / 2)) + v + " ".repeat(Math.ceil(gap / 2));
        return v + " ".repeat(gap);
      }).join(" | ") + " |";
    rows.forEach((cells, r) => (lines[i + r] = fmt(cells, r)));
    i = end - 1;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

export type FormatKind = "json" | "xml" | "html" | "css" | "tables";

const BY_LANG: Record<string, FormatKind> = {
  jsonc: "json", xml: "xml", html: "html", css: "css", scss: "css", less: "css", markdown: "tables",
};

/** What "Format document" does with a text, from its document type (or its content for plain text). */
export function formatKindFor(lang: string, text: string): FormatKind | null {
  if (BY_LANG[lang]) return BY_LANG[lang];
  if (lang !== "text") return null;
  // The whole text must look like JSON or XML ("[ ] buy milk" is a note, not JSON).
  const s = text.trim();
  if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(s)) return "json";
  if (/^<!doctype html|^<html/i.test(s) && s.endsWith(">")) return "html";
  if (s.startsWith("<") && s.endsWith(">")) return "xml";
  if (/\n\s*\|?\s*:?-{3,}/.test(text) && text.includes("|")) return "tables";
  return null;
}

export function formatText(kind: FormatKind, text: string, indent: string): string {
  switch (kind) {
    case "json":
      return formatJson(text, indent);
    case "xml":
      return formatXml(text, indent, false);
    case "html":
      return formatXml(text, indent, true);
    case "css":
      return formatCss(text, indent);
    case "tables":
      return alignMarkdownTables(text);
  }
}
