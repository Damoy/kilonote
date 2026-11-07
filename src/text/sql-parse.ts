// Reads a SQL file (DDL and data dumps) for the SQL view: its statements, the
// tables declared by CREATE TABLE (columns, keys, references), the foreign
// keys added by ALTER TABLE, and the rows of INSERT … VALUES.
// It never runs anything: it only reads the text. Dialects: the common
// syntax of PostgreSQL, MySQL/MariaDB, SQLite and SQL Server.

export interface SqlStatement {
  /** "SELECT", "CREATE TABLE", "INSERT"… */
  kind: string;
  from: number;
  to: number;
  /** The first line, shortened. */
  summary: string;
}

export interface SqlColumn {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  /** "table.column" this column references. */
  ref: { table: string; column: string } | null;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  /** Where its CREATE TABLE is. */
  from: number;
}

export interface SqlRelation {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface SqlData {
  table: string;
  columns: string[];
  rows: string[][];
  from: number;
}

export interface SqlModel {
  statements: SqlStatement[];
  tables: SqlTable[];
  relations: SqlRelation[];
  data: SqlData[];
}

/** Rows kept per table for the data view. */
const MAX_ROWS = 500;

/** Statements, split on ";" outside strings, identifiers and comments. */
export function splitStatements(sql: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
    } else if (c === "#" && /^\s*$/.test(sql.slice(sql.lastIndexOf("\n", i - 1) + 1, i))) {
      // MySQL line comment at the start of a line.
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === "\\" && c === "'") i += 2;
        else if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "[") {
      const e = sql.indexOf("]", i);
      i = e < 0 ? n : e + 1;
    } else if (c === "$") {
      // PostgreSQL dollar quoting: $$ … $$ or $tag$ … $tag$
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
      } else i++;
    } else if (c === ";") {
      out.push({ from: start, to: i });
      start = ++i;
    } else i++;
  }
  if (sql.slice(start).trim()) out.push({ from: start, to: n });
  // Leading blanks and comments are not part of a statement.
  return out
    .map((s) => {
      let from = s.from;
      for (;;) {
        while (from < s.to && /\s/.test(sql[from])) from++;
        if (sql.startsWith("--", from)) {
          const e = sql.indexOf("\n", from);
          from = e < 0 || e > s.to ? s.to : e + 1;
        } else if (sql.startsWith("/*", from)) {
          const e = sql.indexOf("*/", from + 2);
          from = e < 0 || e > s.to ? s.to : e + 2;
        } else break;
      }
      return { from, to: s.to };
    })
    .filter((s) => s.to > s.from);
}

/** A name without its quotes: "Order", `order`, [order] → Order; keeps schema prefixes. */
export function unquoteName(raw: string): string {
  return raw
    .split(".")
    .map((p) => p.trim().replace(/^["`[](.*)["`\]]$/, "$1"))
    .join(".");
}

const NAME = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[\w$]+))*`;

/** The inside of the first (…) group after `from`, and where it ends. */
function parenGroup(s: string, from: number): { inner: string; end: number } | null {
  const open = s.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

/** Splits on commas outside parentheses and strings. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) {
        if (s[i + 1] === q) cur += s[++i];
        else q = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") q = c;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const nameList = (s: string) => splitTop(s).map(unquoteName);

/** Line and block comments removed (strings kept). */
function stripComments(s: string): string {
  return s.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? m : " "));
}

function parseCreateTable(stmt: string, from: number, tables: SqlTable[], relations: SqlRelation[]) {
  const head = new RegExp(String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`, "i").exec(stmt);
  if (!head) return;
  const body = parenGroup(stmt, head[0].length);
  if (!body) return;
  const table: SqlTable = { name: unquoteName(head[1]), columns: [], from };
  for (const def of splitTop(body.inner)) {
    const fk = new RegExp(String.raw`^(?:CONSTRAINT\s+${NAME}\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${NAME})\s*(?:\(([^)]*)\))?`, "i").exec(def);
    if (fk) {
      relations.push({ table: table.name, columns: nameList(fk[1]), refTable: unquoteName(fk[2]), refColumns: fk[3] ? nameList(fk[3]) : [] });
      continue;
    }
    const pk = new RegExp(String.raw`^(?:CONSTRAINT\s+${NAME}\s+)?PRIMARY\s+KEY\s*(?:CLUSTERED\s*|NONCLUSTERED\s*)?\(([^)]*)\)`, "i").exec(def);
    if (pk) {
      for (const c of nameList(pk[1].replace(/\s+(?:ASC|DESC)\b/gi, ""))) {
        const col = table.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
        if (col) col.pk = true;
      }
      continue;
    }
    const uq = new RegExp(String.raw`^(?:CONSTRAINT\s+${NAME}\s+)?UNIQUE\s*(?:KEY\s+${NAME}\s*|INDEX\s+${NAME}\s*)?\(([^)]*)\)`, "i").exec(def);
    if (uq) {
      const cols = nameList(uq[1]);
      if (cols.length === 1) {
        const col = table.columns.find((x) => x.name.toLowerCase() === cols[0].toLowerCase());
        if (col) col.unique = true;
      }
      continue;
    }
    if (/^(?:CONSTRAINT|CHECK|INDEX|KEY|FULLTEXT|SPATIAL|EXCLUDE|PERIOD)\b/i.test(def)) continue;
    const col = new RegExp(String.raw`^(${NAME})\s+([\s\S]*)$`).exec(def);
    if (!col) continue;
    const rest = col[2];
    // The type: words and their (…) arguments, up to the first constraint keyword.
    const typeMatch = /^((?:(?!(?:NOT|NULL|PRIMARY|REFERENCES|DEFAULT|UNIQUE|CHECK|CONSTRAINT|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|IDENTITY|COLLATE|COMMENT|ON|AS)\b)[\w$]+(?:\s*\([^)]*\))?(?:\s*\[\])?\s*)+)/i.exec(rest);
    const type = (typeMatch?.[1] ?? "").trim().replace(/\s+/g, " ");
    const ref = new RegExp(String.raw`REFERENCES\s+(${NAME})\s*(?:\(([^)]*)\))?`, "i").exec(rest);
    const column: SqlColumn = {
      name: unquoteName(col[1]),
      type: type || "?",
      pk: /\bPRIMARY\s+KEY\b/i.test(rest),
      notNull: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest),
      unique: /\bUNIQUE\b/i.test(rest),
      ref: ref ? { table: unquoteName(ref[1]), column: ref[2] ? nameList(ref[2])[0] : "" } : null,
    };
    table.columns.push(column);
    if (column.ref) relations.push({ table: table.name, columns: [column.name], refTable: column.ref.table, refColumns: column.ref.column ? [column.ref.column] : [] });
  }
  tables.push(table);
}

function parseAlterTable(stmt: string, relations: SqlRelation[]) {
  const m = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(${NAME})\s+ADD\s+(?:CONSTRAINT\s+${NAME}\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${NAME})\s*(?:\(([^)]*)\))?`, "i").exec(stmt);
  if (m) relations.push({ table: unquoteName(m[1]), columns: nameList(m[2]), refTable: unquoteName(m[3]), refColumns: m[4] ? nameList(m[4]) : [] });
}

/** A literal as it reads: strings unquoted, NULL kept. */
function literal(v: string): string {
  const s = v.trim();
  const q = /^(?:N|E|X)?'([\s\S]*)'$/i.exec(s);
  if (q) return q[1].replace(/''/g, "'").replace(/\\'/g, "'");
  return s;
}

function parseInsert(stmt: string, from: number, data: SqlData[]) {
  const m = new RegExp(String.raw`^\s*INSERT\s+(?:IGNORE\s+|OR\s+\w+\s+)?INTO\s+(${NAME})\s*`, "i").exec(stmt);
  if (!m) return;
  let pos = m[0].length;
  let columns: string[] = [];
  if (stmt[pos] === "(") {
    const g = parenGroup(stmt, pos);
    if (!g) return;
    columns = nameList(g.inner);
    pos = g.end;
  }
  const values = /^\s*VALUES\s*/i.exec(stmt.slice(pos));
  if (!values) return;
  pos += values[0].length;
  const table = unquoteName(m[1]);
  let entry = data.find((d) => d.table === table && d.columns.join() === columns.join());
  if (!entry) data.push((entry = { table, columns, rows: [], from }));
  for (;;) {
    const g = parenGroup(stmt, pos);
    if (!g || stmt.slice(pos, g.end).trim()[0] !== "(") break;
    if (entry.rows.length < MAX_ROWS) entry.rows.push(splitTop(g.inner).map(literal));
    pos = g.end;
    const comma = /^\s*,\s*/.exec(stmt.slice(pos));
    if (!comma) break;
    pos += comma[0].length;
  }
  if (!entry.columns.length) entry.columns = (entry.rows[0] ?? []).map((_, i) => `column ${i + 1}`);
}

export function parseSql(sql: string): SqlModel {
  const statements: SqlStatement[] = [];
  const tables: SqlTable[] = [];
  const relations: SqlRelation[] = [];
  const data: SqlData[] = [];
  for (const s of splitStatements(sql)) {
    const text = stripComments(sql.slice(s.from, s.to));
    const words = /^\s*(\w+)(?:\s+(?:OR\s+REPLACE\s+|IF\s+NOT\s+EXISTS\s+|TEMP(?:ORARY)?\s+|UNIQUE\s+|MATERIALIZED\s+)*(\w+))?/i.exec(text);
    const first = (words?.[1] ?? "").toUpperCase();
    const second = (words?.[2] ?? "").toUpperCase();
    const kind = ["CREATE", "DROP", "ALTER"].includes(first) && second ? `${first} ${second}` : first || "?";
    const line = sql.slice(s.from, s.to).trim().split("\n")[0];
    statements.push({ kind, from: s.from, to: s.to, summary: line.length > 90 ? line.slice(0, 90) + "…" : line });
    if (kind === "CREATE TABLE") parseCreateTable(text, s.from, tables, relations);
    else if (kind === "ALTER TABLE") parseAlterTable(text, relations);
    else if (first === "INSERT") parseInsert(text, s.from, data);
  }
  return { statements, tables, relations, data };
}

// ---------------------------------------------------------------------------

/** Mermaid entity-relationship diagram of the tables (null when there is none). */
export function erDiagram(model: SqlModel): string | null {
  if (!model.tables.length) return null;
  const ids = new Map<string, string>();
  const idOf = (name: string) => {
    const key = name.toLowerCase();
    let id = ids.get(key);
    if (!id) {
      id = `t${ids.size + 1}`;
      ids.set(key, id);
    }
    return id;
  };
  const label = (s: string) => s.replace(/["\\]/g, "'");
  const word = (s: string) => s.replace(/[^\w()[\]-]+/g, "_").replace(/^[^A-Za-z]+/, "") || "x";
  // Left to right: the pane is wider than it is tall.
  const lines = ["erDiagram", "  direction LR"];
  const known = new Set(model.tables.map((t) => t.name.toLowerCase()));
  for (const t of model.tables) {
    lines.push(`  ${idOf(t.name)}["${label(t.name)}"] {`);
    for (const c of t.columns.slice(0, 60)) {
      const keys = [c.pk && "PK", (c.ref || model.relations.some((r) => r.table === t.name && r.columns.includes(c.name))) && "FK", c.unique && !c.pk && "UK"].filter(Boolean);
      lines.push(`    ${word(c.type)} ${word(c.name)}${keys.length ? " " + keys.join(", ") : ""}`);
    }
    lines.push("  }");
  }
  const seen = new Set<string>();
  for (const r of model.relations) {
    // Each reference once; a reference to an unknown table still shows that table.
    const key = `${r.table}|${r.columns.join()}|${r.refTable}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!known.has(r.refTable.toLowerCase())) {
      known.add(r.refTable.toLowerCase());
      lines.push(`  ${idOf(r.refTable)}["${label(r.refTable)}"]`);
    }
    const table = model.tables.find((t) => t.name === r.table);
    const col = table?.columns.find((c) => c.name === r.columns[0]);
    // One-to-one only when the column alone is unique (a part of a composite key is not).
    const soleKey = !!col?.pk && table!.columns.filter((c) => c.pk).length === 1;
    const many = r.columns.length > 1 || !(col?.unique || soleKey);
    lines.push(`  ${idOf(r.table)} ${many ? "}o" : "|o"}--|| ${idOf(r.refTable)} : "${label(r.columns.join(", "))}"`);
  }
  return lines.join("\n");
}
