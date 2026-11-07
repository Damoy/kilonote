// The view of a SQL file: the schema as an entity-relationship diagram, the
// tables and their columns, the rows of INSERT statements as grids, and the
// list of statements. A click goes to the statement in the editor.
// Nothing is ever run: the file is only read.

import type { App } from "../app";
import { erDiagram, parseSql, type SqlModel } from "../editor/sql-parse";
import { DiagramView } from "./diagram-view";
import { h, icon } from "./dom";

/** Above this size, no SQL view (it is read again at every pause in typing). */
const MAX_SQL_SIZE = 5 * 1024 * 1024;
const ROWS_SHOWN = 200;

type Section = "schema" | "tables" | "data" | "statements";

const KIND_COLORS: [RegExp, string][] = [
  [/^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|RENAME)\b/, "var(--kn-purple)"],
  [/^(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|COPY)\b/, "var(--kn-orange)"],
  [/^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|VALUES)\b/, "var(--kn-blue)"],
  [/^(GRANT|REVOKE)\b/, "var(--kn-red)"],
  [/^(BEGIN|COMMIT|ROLLBACK|START|SET|USE|SAVEPOINT)\b/, "var(--kn-fg-faint)"],
];

export class SqlView {
  readonly el: HTMLElement;
  private body = h("div", { class: "sv-body" });
  private summary = h("span", { class: "sv-summary" });
  private diagram: DiagramView;
  private closed = new Set<Section>(["data"]);
  private lastSchema: string | null = null;

  constructor(private app: App) {
    this.diagram = new DiagramView(app);
    this.diagram.el.classList.add("sv-diagram");
    this.el = h("div", { class: "sv" },
      h("div", { class: "tv-tools" }, h("span", { class: "tv-title" }, "SQL"), this.summary, h("span", { class: "kn-spacer" })),
      this.body);
  }

  render(text: string, opts: { dark: boolean; name: string }) {
    if (text.length > MAX_SQL_SIZE) {
      this.summary.textContent = "";
      this.body.replaceChildren(h("div", { class: "tv-empty" }, `This file is too large for the SQL view (${Math.round(text.length / 1024 / 1024)} MB).`));
      return;
    }
    const model = parseSql(text);
    const top = this.body.scrollTop;
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
    this.summary.textContent = `${n(model.tables.length, "table")} · ${n(model.statements.length, "statement")}`;
    this.body.replaceChildren(
      this.section("schema", "Schema", "diagram", model.tables.length, () => this.schema(model, opts)),
      this.section("tables", "Tables", "database", model.tables.length, () => this.tables(model)),
      this.section("data", "Data", "list", model.data.length, () => this.data(model)),
      this.section("statements", "Statements", "command", model.statements.length, () => this.statements(model)),
    );
    this.body.scrollTop = top;
  }

  private section(id: Section, title: string, ic: string, count: number, content: () => HTMLElement) {
    const open = !this.closed.has(id) && count > 0;
    const head = h("button", { class: `sv-head${open ? " open" : ""}`, disabled: count === 0 },
      icon("chevron", "sv-chevron"), icon(ic), h("span", {}, title), h("span", { class: "sb-count" }, String(count)));
    head.addEventListener("click", () => {
      if (this.closed.has(id)) this.closed.delete(id);
      else this.closed.add(id);
      this.app.preview.update(true);
    });
    return h("section", { class: "sv-section" }, head, open ? content() : null);
  }

  private reveal(from: number, to: number) {
    const len = this.app.view.state.doc.length;
    this.app.view.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) }, scrollIntoView: true });
    this.app.focusEditor();
  }

  private schema(model: SqlModel, opts: { dark: boolean; name: string }): HTMLElement {
    const code = erDiagram(model);
    // The diagram is drawn again only when the schema (or the theme) changed.
    const key = code && `${opts.dark ? "dark" : "light"}\n${code}`;
    if (key && key !== this.lastSchema) {
      this.lastSchema = key;
      void this.diagram.render(code, { dark: opts.dark, title: "ENTITY-RELATIONSHIP", name: `${opts.name}-schema` });
    }
    return this.diagram.el;
  }

  private tables(model: SqlModel): HTMLElement {
    const fkOf = (table: string, column: string) =>
      model.relations.find((r) => r.table === table && r.columns.includes(column));
    return h("div", { class: "sv-tables" },
      ...model.tables.map((t) => {
        const statement = model.statements.find((s) => s.from === t.from);
        return h("div", { class: "sv-table" },
          h("button", { class: "sv-table-name", title: "Go to its CREATE TABLE", onclick: () => this.reveal(t.from, statement?.to ?? t.from) },
            icon("database"), h("span", {}, t.name), h("small", {}, `${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`)),
          ...t.columns.map((c) => {
            const fk = fkOf(t.name, c.name);
            return h("div", { class: "sv-col" },
              h("span", { class: "sv-col-name" }, c.name),
              h("span", { class: "sv-col-type" }, c.type),
              h("span", { class: "sv-badges" },
                c.pk ? h("b", { class: "pk", title: "Primary key" }, "PK") : null,
                fk ? h("b", { class: "fk", title: `References ${fk.refTable}${fk.refColumns.length ? `(${fk.refColumns.join(", ")})` : ""}` }, "FK") : null,
                c.unique && !c.pk ? h("b", { class: "uk", title: "Unique" }, "UK") : null,
                c.notNull && !c.pk ? h("b", { class: "nn", title: "Not null" }, "NN") : null),
              fk ? h("span", { class: "sv-ref" }, `→ ${fk.refTable}`) : null);
          }));
      }));
  }

  private data(model: SqlModel): HTMLElement {
    return h("div", { class: "sv-data" },
      ...model.data.map((d) =>
        h("div", { class: "sv-grid-wrap" },
          h("button", { class: "sv-table-name", title: "Go to the first INSERT", onclick: () => this.reveal(d.from, d.from) },
            icon("database"), h("span", {}, d.table), h("small", {}, `${d.rows.length}${d.rows.length >= 500 ? "+" : ""} row${d.rows.length === 1 ? "" : "s"}`)),
          h("div", { class: "sv-grid-scroll" },
            h("table", { class: "sv-grid" },
              h("thead", {}, h("tr", {}, ...d.columns.map((c) => h("th", {}, c)))),
              h("tbody", {}, ...d.rows.slice(0, ROWS_SHOWN).map((r) =>
                h("tr", {}, ...d.columns.map((_, i) => {
                  const v = r[i] ?? "";
                  return h("td", { class: v.toUpperCase() === "NULL" ? "null" : "", title: v.length > 60 ? v : null }, v.length > 60 ? v.slice(0, 60) + "…" : v);
                })))))),
          d.rows.length > ROWS_SHOWN ? h("small", { class: "sv-more" }, `${d.rows.length - ROWS_SHOWN} more rows in the file`) : null)));
  }

  private statements(model: SqlModel): HTMLElement {
    const lineOf = (pos: number) => this.app.view.state.doc.lineAt(Math.min(pos, this.app.view.state.doc.length)).number;
    return h("div", { class: "sv-statements" },
      ...model.statements.slice(0, 2000).map((s) => {
        const color = KIND_COLORS.find(([re]) => re.test(s.kind))?.[1] ?? "var(--kn-fg-muted)";
        return h("button", { class: "sv-stmt", title: `Line ${lineOf(s.from)}`, onclick: () => this.reveal(s.from, s.to) },
          h("span", { class: "sv-kind", style: { "--c": color } }, s.kind),
          h("span", { class: "sv-stmt-text" }, s.summary),
          h("small", {}, String(lineOf(s.from))));
      }));
  }
}
