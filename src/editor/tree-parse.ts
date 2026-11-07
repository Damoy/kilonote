// JSON and YAML as a tree for the tree view, each node keeping where it is in
// the text: an edit in the tree replaces only that span, so the rest of the file
// (comments, layout, quotes) stays exactly as written.
// YAML uses the "yaml" package, loaded the first time a YAML tree is shown.

import { FormatError, jsonTokens, MAX_DEPTH, tooDeep, type JTok, where } from "./format";

export type NodeType = "object" | "array" | "string" | "number" | "boolean" | "null" | "alias" | "other";
export type TreeFormat = "json" | "yaml";

export interface TreeNode {
  /** Property name, array index, or document label (null for the root). */
  key: string | number | null;
  type: NodeType;
  /** Where the value is in the text. */
  from: number;
  to: number;
  /** Where the property name is (object members only). */
  keyFrom?: number;
  keyTo?: number;
  /** Shown text of a scalar (strings unquoted). */
  text?: string;
  children?: TreeNode[];
  /** A one-line scalar: editable in place. */
  editable: boolean;
  keyEditable: boolean;
  /** How the scalar is written: '"', "'", "plain", "block" (YAML) or "bare" (JSON5 identifier keys). */
  style?: string;
  keyStyle?: string;
  /** One of several YAML documents of the file (not part of the paths). */
  isDocument?: boolean;
}

export interface ParsedTree {
  format: TreeFormat;
  roots: TreeNode[];
  error: { message: string; pos: number } | null;
}

// ---------------------------------------------------------------------------
// JSON (comments, trailing commas, single quotes accepted)

function unquote(v: string): string {
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'")) return v.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  return v;
}

export function parseJsonTree(text: string): TreeNode {
  const { toks } = jsonTokens(text);
  if (!toks.length) throw new FormatError("The document contains no JSON value.", 0);
  let k = 0;
  const next = (): JTok => {
    const t = toks[k++];
    if (!t) throw new FormatError("Unexpected end of the document: a bracket is not closed.", text.length);
    return t;
  };
  let depth = 0;
  const value = (key: string | number | null): TreeNode => {
    const t = next();
    if (t.t === "{" || t.t === "[") {
      if (++depth > MAX_DEPTH) throw tooDeep(text, t.pos);
      const close = t.t === "{" ? "}" : "]";
      const node: TreeNode = { key, type: t.t === "{" ? "object" : "array", from: t.pos, to: t.pos + 1, children: [], editable: false, keyEditable: false };
      for (;;) {
        const p = toks[k];
        if (!p) throw new FormatError(`"${t.v}" opened at ${where(text, t.pos)} is never closed.`, t.pos);
        if (p.t === close) {
          k++;
          node.to = p.pos + 1;
          depth--;
          return node;
        }
        if (p.t === "]" || p.t === "}") throw new FormatError(`Unexpected "${p.v}" at ${where(text, p.pos)}: "${t.v}" is closed with "${close}".`, p.pos);
        if (t.t === "{") {
          const kt = next();
          if (kt.t !== "str" && kt.t !== "lit" && kt.t !== "num") throw new FormatError(`Expected a key at ${where(text, kt.pos)}, found "${kt.v}"`, kt.pos);
          const colon = next();
          if (colon.t !== ":") throw new FormatError(`Expected ":" after the key at ${where(text, colon.pos)}, found "${colon.v}"`, colon.pos);
          const child = value(unquote(kt.v));
          child.keyFrom = kt.pos;
          child.keyTo = kt.pos + kt.v.length;
          child.keyEditable = kt.t !== "num";
          child.keyStyle = kt.t === "str" ? kt.v[0] : "bare";
          node.children!.push(child);
        } else node.children!.push(value(node.children!.length));
        const after = toks[k];
        if (after?.t === ",") k++;
        else if (after && after.t !== close) throw new FormatError(`Expected "," or "${close}" at ${where(text, after.pos)}, found "${after.v}"`, after.pos);
      }
    }
    const node: TreeNode = { key, type: "other", from: t.pos, to: t.pos + t.v.length, text: t.v, editable: true, keyEditable: false };
    if (t.t === "str") {
      node.type = "string";
      node.text = unquote(t.v);
      node.style = t.v[0];
    } else if (t.t === "num") node.type = "number";
    else if (t.v === "true" || t.v === "false") node.type = "boolean";
    else if (t.v === "null") node.type = "null";
    else if (t.t !== "lit") throw new FormatError(`Expected a value at ${where(text, t.pos)}, found "${t.v}"`, t.pos);
    return node;
  };
  const root = value(null);
  if (k < toks.length) throw new FormatError(`Unexpected "${toks[k].v}" after the end of the JSON value, at ${where(text, toks[k].pos)}`, toks[k].pos);
  return root;
}

// ---------------------------------------------------------------------------
// YAML

type YamlLib = typeof import("yaml");
let yamlLib: YamlLib | null = null;

export async function loadYaml(): Promise<YamlLib> {
  yamlLib ??= await import("yaml");
  return yamlLib;
}

/**
 * Where a YAML text nests deeper than MAX_DEPTH ([ and { outside quotes and
 * comments, or a very deep indentation), checked before parsing: the YAML
 * parser could run out of memory on such a file.
 */
export function yamlTooDeep(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      lineStart = i + 1; // (quoted scalars may span lines: the quote stays open)
      continue;
    }
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (i === lineStart) {
      let j = i;
      while (text[j] === " ") j++;
      if (j - i > MAX_DEPTH * 4) return i;
    }
    if (c === "#" && (i === lineStart || /\s/.test(text[i - 1]))) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") {
      if (++depth > MAX_DEPTH) return i;
    } else if ((c === "]" || c === "}") && depth > 0) depth--;
  }
  return -1;
}

export async function parseYamlTree(text: string): Promise<ParsedTree> {
  const deep = yamlTooDeep(text);
  if (deep >= 0) {
    const e = tooDeep(text, deep);
    return { format: "yaml", roots: [], error: { message: e.message, pos: e.pos } };
  }
  const Y = await loadYaml();
  const docs = Y.parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [];
  const roots: TreeNode[] = [];
  let error: ParsedTree["error"] = null;
  const STYLE: Record<string, string> = { PLAIN: "plain", QUOTE_DOUBLE: '"', QUOTE_SINGLE: "'", BLOCK_LITERAL: "block", BLOCK_FOLDED: "block" };

  let depth = 0;
  const convert = (n: unknown, key: string | number | null): TreeNode => {
    if (++depth > MAX_DEPTH) throw tooDeep(text, (n as { range?: number[] }).range?.[0] ?? 0);
    try {
      return convertNode(n, key);
    } finally {
      depth--;
    }
  };
  const convertNode = (n: unknown, key: string | number | null): TreeNode => {
    const range = (n as { range?: [number, number, number] }).range ?? [0, 0, 0];
    const base = { key, from: range[0], to: range[1], editable: false, keyEditable: false };
    if (Y.isMap(n)) {
      return {
        ...base,
        type: "object",
        children: n.items.map((pair) => {
          const k = pair.key;
          const name = Y.isScalar(k) ? String(k.value) : k ? text.slice((k as { range: number[] }).range[0], (k as { range: number[] }).range[1]) : "";
          const child = pair.value == null
            ? { key: name, type: "null" as NodeType, from: 0, to: 0, text: "", editable: false, keyEditable: false }
            : convert(pair.value, name);
          if (Y.isScalar(k) && k.range) {
            child.keyFrom = k.range[0];
            child.keyTo = k.range[1];
            child.keyStyle = STYLE[k.type ?? "PLAIN"] ?? "plain";
            child.keyEditable = child.keyStyle !== "block" && !text.slice(k.range[0], k.range[1]).includes("\n");
          }
          return child;
        }),
      };
    }
    if (Y.isSeq(n)) return { ...base, type: "array", children: n.items.map((item, i) => convert(item, i)) };
    if (Y.isAlias(n)) return { ...base, type: "alias", text: `*${n.source}` };
    if (Y.isScalar(n)) {
      const v = n.value;
      const style = STYLE[n.type ?? "PLAIN"] ?? "plain";
      const type: NodeType = v === null ? "null" : typeof v === "string" ? "string" : typeof v === "number" || typeof v === "bigint" ? "number" : typeof v === "boolean" ? "boolean" : "other";
      const src = text.slice(range[0], range[1]);
      return { ...base, type, style, text: type === "string" ? (v as string) : src || "null", editable: style !== "block" && !src.includes("\n") };
    }
    return { ...base, type: "other", text: text.slice(range[0], range[1]) };
  };

  list.forEach((d, i) => {
    if (!error && d.errors.length) {
      const e = d.errors[0];
      error = { message: e.message.split("\n")[0], pos: e.pos[0] };
    }
    if (d.contents == null) return;
    try {
      const node = convert(d.contents, list.length > 1 ? `Document ${i + 1}` : null);
      node.isDocument = list.length > 1;
      roots.push(node);
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      error ??= { message: e.message, pos: e.pos };
    }
  });
  return { format: "yaml", roots, error };
}

/** Never throws: a problem becomes the tree's error. */
export async function parseTree(text: string, format: TreeFormat): Promise<ParsedTree> {
  try {
    if (format === "yaml") return await parseYamlTree(text);
    return { format, roots: [parseJsonTree(text)], error: null };
  } catch (e) {
    const err = e instanceof FormatError ? e : new FormatError(`The ${format === "json" ? "JSON" : "YAML"} could not be read: ${(e as Error).message}`, 0);
    return { format, roots: [], error: { message: err.message, pos: err.pos } };
  }
}

// ---------------------------------------------------------------------------
// Edits: the text that replaces a value or a key

/** YAML text that can stay unquoted (and stays a string). */
function plainYamlString(s: string): boolean {
  if (!s || s !== s.trim() || /\n/.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) || /: |\s#|:$|[,[\]{}]/.test(s)) return false;
  // "12", "true", "null"… would no longer be strings.
  try {
    return typeof yamlLib?.parse(s) === "string";
  } catch {
    return false;
  }
}

function yamlString(s: string, style: string | undefined): string {
  if (style === "'") return `'${s.replace(/'/g, "''")}'`;
  if (style !== '"' && plainYamlString(s)) return s;
  return JSON.stringify(s);
}

/** The source text for a new value typed in the tree (strings stay strings). */
export function valueSource(node: TreeNode, input: string, format: TreeFormat): string {
  // "key:" with no value yet: the value needs a space after the colon.
  if (format === "yaml" && node.from === node.to) return " " + valueSource({ ...node, from: -1 }, input, format);
  if (format === "json") {
    if (node.type === "string") return node.style === "'" ? `'${input.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : JSON.stringify(input);
    try {
      const v = JSON.parse(input) as unknown;
      if (v === null || typeof v !== "object") return input.trim();
    } catch {
      /* not a JSON value: a string */
    }
    return JSON.stringify(input);
  }
  if (node.type === "string") return yamlString(input, node.style);
  try {
    const v = yamlLib?.parse(input) as unknown;
    if (v === null || typeof v !== "object") return input.trim() || "null";
  } catch {
    /* quoted below */
  }
  return JSON.stringify(input);
}

/** The source text for a renamed key. */
export function keySource(node: TreeNode, input: string, format: TreeFormat): string {
  if (format === "json") {
    if (node.keyStyle === "bare" && /^[A-Za-z_$][\w$]*$/.test(input)) return input;
    if (node.keyStyle === "'") return `'${input.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    return JSON.stringify(input);
  }
  return yamlString(input, node.keyStyle);
}

/** `servers[0].name`, `["my key"]`: the path of a node, from its chain of ancestors. */
export function nodePath(chain: TreeNode[]): string {
  let out = "";
  for (const n of chain) {
    if (n.key === null || n.isDocument) continue;
    if (typeof n.key === "number") out += `[${n.key}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(n.key)) out += out ? `.${n.key}` : n.key;
    else out += `[${JSON.stringify(n.key)}]`;
  }
  return out;
}
