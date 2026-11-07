// "Format document" for SQL: one clause per line, the columns of a SELECT and
// the definitions of a CREATE TABLE one per line, subqueries indented, AND / OR
// of a WHERE on their own lines, keywords in capitals.
// Only spaces, line breaks and the case of keywords change: strings, quoted
// names, comments and every other token are written back exactly as they were.

export type SqlTok = {
  t: "word" | "kw" | "str" | "qid" | "num" | "op" | "," | ";" | "(" | ")" | "." | "line" | "block";
  v: string;
  /** Whitespace before it in the source. */
  space: boolean;
  /** A line break before it in the source. */
  nl: boolean;
};

const KEYWORDS = new Set(
  ("select from where and or not in is null like ilike between exists as on join inner left right full outer cross natural using " +
    "group by order having limit offset union all intersect except distinct insert into values update set delete returning with " +
    "recursive case when then else end create table view index unique primary key foreign references constraint default check " +
    "alter add drop column rename to if asc desc nulls first last true false cascade restrict begin commit rollback transaction " +
    "grant revoke truncate explain analyze over partition window rows range filter conflict do nothing replace temporary temp " +
    "materialized sequence schema database trigger function procedure returns language auto_increment identity collate interval " +
    "cast lateral fetch next only top escape some any exclude generated always stored virtual unlogged owner of for each row " +
    "execute declare return merge matched upsert ignore lock share nowait skip locked").split(" "),
);

/** Clauses that start a new line. */
const CLAUSES = new Set(["select", "from", "where", "having", "limit", "offset", "values", "set", "returning", "window", "union", "intersect", "except", "fetch"]);
const JOIN_WORDS = new Set(["left", "right", "full", "inner", "cross", "natural", "join", "outer"]);

export function sqlTokens(sql: string): SqlTok[] {
  const out: SqlTok[] = [];
  let i = 0;
  const n = sql.length;
  let space = false;
  let nl = false;
  const push = (t: SqlTok["t"], from: number, to: number) => {
    const v = sql.slice(from, to);
    out.push({ t: t === "word" && KEYWORDS.has(v.toLowerCase()) ? "kw" : t, v, space, nl });
    space = nl = false;
    i = to;
  };
  while (i < n) {
    const c = sql[i];
    const atLineStart = /^[ \t]*$/.test(sql.slice(sql.lastIndexOf("\n", i - 1) + 1, i));
    if (/\s/.test(c)) {
      space = true;
      if (c === "\n") nl = true;
      i++;
    } else if ((c === "-" && sql[i + 1] === "-") || (c === "#" && atLineStart)) {
      const e = sql.indexOf("\n", i);
      push("line", i, e < 0 ? n : e);
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      push("block", i, e < 0 ? n : e + 2);
    } else if (c === "'" || (/[NnEeXxBb]/.test(c) && sql[i + 1] === "'")) {
      let j = c === "'" ? i + 1 : i + 2;
      while (j < n) {
        if (sql[j] === "\\") j += 2;
        else if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      push("str", i, Math.min(n, j + 1));
    } else if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      push("qid", i, Math.min(n, j + 1));
    } else if (c === "[" && !/[\w\])]/.test(sql[i - 1] ?? "")) {
      const e = sql.indexOf("]", i);
      push("qid", i, e < 0 ? n : e + 1);
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))![0];
      const e = sql.indexOf(tag, i + tag.length);
      push("str", i, e < 0 ? n : e + tag.length);
    } else if (/\d/.test(c) || (c === "." && /\d/.test(sql[i + 1] ?? ""))) {
      const m = /^(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(sql.slice(i, i + 100))!;
      push("num", i, i + Math.max(1, m[0].length));
    } else if (/[\p{L}_@$:?]/u.test(c)) {
      // Names, keywords, variables (@x), parameters (:name, $1, ?)
      const m = /^(?:[@:$?][\p{L}\p{N}_$]*|[\p{L}_][\p{L}\p{N}_$]*)/u.exec(sql.slice(i, i + 256))!;
      push(m[0].startsWith(":") && m[0].length === 1 ? "op" : "word", i, i + Math.max(1, m[0].length));
    } else if (c === "," || c === ";" || c === "(" || c === ")" || c === ".") {
      push(c, i, i + 1);
    } else {
      // Operators: one or more symbols together, as written (never split or joined).
      const m = /^[<>=!~+\-*/%&|^:#]+/.exec(sql.slice(i, i + 8));
      push("op", i, i + (m ? m[0].length : 1));
    }
  }
  return out;
}

const isKw = (t: SqlTok | undefined, ...words: string[]) => !!t && t.t === "kw" && words.includes(t.v.toLowerCase());

export function formatSql(sql: string, indent = "  "): string {
  const toks = sqlTokens(sql);
  let out = "";
  /** Indentation of the current block (a statement or a subquery). */
  let base = 0;
  let line = true; // at the start of a line
  type Paren = { kind: "sub" | "list" | "inline"; base: number; clause: string; line: number };
  const parens: Paren[] = [];
  let clause = ""; // the clause the tokens belong to (select, where, values…)
  let between = false; // "BETWEEN a AND b": that AND stays on the line
  let createTable = false;

  const newline = (level: number) => {
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
    out += indent.repeat(Math.max(0, level));
    line = true;
  };
  const emit = (tok: SqlTok, glue: "space" | "none" | "auto" = "auto") => {
    const text = tok.t === "kw" ? tok.v.toUpperCase() : tok.v;
    if (!line && out && (glue === "space" || (glue === "auto" && tok.space))) out += " ";
    out += text;
    line = false;
  };
  const top = () => parens[parens.length - 1];
  /** Indentation level of the line being written. */
  const lineLevel = () => {
    const last = out.slice(out.lastIndexOf("\n") + 1);
    return Math.floor(/^[ \t]*/.exec(last)![0].length / Math.max(1, indent.length));
  };
  /** Tokens directly in the block (not inside an inline parenthesis). */
  const atBlock = () => !parens.length || top().kind !== "inline";
  const next = (k: number) => toks[k + 1];
  /** Where the next line of the current place starts. */
  const level = () => (!atBlock() ? base + 1 : ["select", "set", "values"].includes(clause) ? base + 1 : base);

  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const word = tok.t === "kw" ? tok.v.toLowerCase() : "";
    const prev = toks[k - 1];

    if (tok.t === "line") {
      // A comment on its own line stays on its own line; a line comment always ends its line.
      if (tok.nl && !line) newline(level());
      emit(tok, "space");
      newline(level());
      continue;
    }
    if (tok.t === "block") {
      if (tok.nl && out) newline(base);
      emit(tok);
      continue;
    }
    if (tok.t === ";") {
      emit(tok, "none");
      out += "\n";
      if (next(k)) out += "\n";
      line = true;
      base = 0;
      parens.length = 0;
      clause = "";
      createTable = false;
      between = false;
      continue;
    }

    if (atBlock() && tok.t === "kw") {
      // A new statement or clause.
      if (["insert", "update", "delete", "create", "alter", "drop", "with", "merge", "truncate", "grant", "revoke"].includes(word) && !clause && line) {
        clause = word;
        if (word === "create") createTable = isKw(next(k), "table") || isKw(next(k), "temporary", "temp", "unlogged");
        emit(tok);
        continue;
      }
      const group = isKw(tok, "group", "order", "partition") && isKw(next(k), "by");
      const join = JOIN_WORDS.has(word) && !isKw(prev, ...JOIN_WORDS) && toks.slice(k, k + 4).some((t) => isKw(t, "join"));
      // DELETE FROM stays on one line.
      const deleteFrom = word === "from" && isKw(prev, "delete");
      if (!deleteFrom && (CLAUSES.has(word) || group || join || (word === "on" && isKw(next(k), "conflict")))) {
        newline(base);
        emit(tok);
        if (group) {
          k++;
          emit(toks[k]);
        }
        clause = join ? "join" : word;
        between = false;
        if (word === "select") {
          // DISTINCT / TOP stay with SELECT; the columns go below.
          while (isKw(next(k), "distinct", "all", "top")) emit(toks[++k]);
          if (next(k)?.t !== "line") newline(base + 1);
        } else if (word === "set") {
          if (next(k)?.t !== "line") newline(base + 1);
        } else if (word === "values") {
          if (next(k)?.t !== "line") newline(base + 1);
        }
        continue;
      }
      if ((word === "and" || word === "or") && ["where", "having", "join", "on"].includes(clause)) {
        if (word === "and" && between) {
          between = false;
          emit(tok);
          continue;
        }
        newline(base + 1);
        emit(tok);
        continue;
      }
      if (word === "between") between = true;
      if (word === "on" && clause === "join") clause = "on";
    }

    if (tok.t === "(") {
      const after = toks.slice(k + 1).find((t) => t.t !== "line" && t.t !== "block");
      let kind: Paren["kind"] = "inline";
      if (isKw(after, "select", "with")) kind = "sub";
      else if (createTable && !parens.length && clause === "create") kind = "list";
      parens.push({ kind, base, clause, line: lineLevel() });
      // Function calls keep their "(": count(x), not count (x).
      emit(tok, prev && (prev.t === "word" || prev.t === "kw" || prev.t === "qid") && !tok.space ? "none" : "auto");
      if (kind !== "inline") {
        // The block is indented from the line it opens on.
        base = top().line + 1;
        clause = "";
        newline(base);
      }
      continue;
    }
    if (tok.t === ")") {
      const p = parens.pop();
      if (p && p.kind !== "inline") {
        base = p.base;
        newline(p.line);
        clause = p.clause;
        emit(tok);
      } else {
        emit(tok, "none");
        if (p) clause = p.clause;
      }
      continue;
    }
    if (tok.t === ",") {
      emit(tok, "none");
      const p = top();
      if (p?.kind === "list") newline(base);
      else if (atBlock() && (clause === "select" || clause === "set" || clause === "values")) newline(base + 1);
      continue;
    }
    if (tok.t === ".") {
      emit(tok, "none");
      continue;
    }
    if (prev?.t === "." || prev?.t === "(") {
      emit(tok, "none");
      continue;
    }
    emit(tok);
  }
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
