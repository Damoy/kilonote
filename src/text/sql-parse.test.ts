import { describe, expect, it } from "vitest";
import { erDiagram, parseSql, splitStatements, unquoteName } from "./sql-parse";

const SCHEMA = `-- Shop schema
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  "name" VARCHAR(120) NOT NULL,
  email TEXT UNIQUE, -- contact
  country CHAR(2)
);

CREATE TABLE IF NOT EXISTS \`orders\` (
  id INT NOT NULL AUTO_INCREMENT,
  customer_id INT NOT NULL REFERENCES customers(id),
  total NUMERIC(10, 2) DEFAULT 0,
  note TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE order_items (
  order_id INT,
  sku VARCHAR(20),
  qty INT CHECK (qty > 0),
  CONSTRAINT pk_items PRIMARY KEY (order_id, sku),
  CONSTRAINT fk_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);

ALTER TABLE order_items ADD CONSTRAINT fk_sku FOREIGN KEY (sku) REFERENCES products(sku);

INSERT INTO customers (id, name, email) VALUES (1, 'Acme; Corp', 'a@acme.test'), (2, 'O''Brien', NULL);
SELECT * FROM customers WHERE name = 'x;y';
`;

describe("SQL", () => {
  it("splits statements outside strings and comments", () => {
    const parts = splitStatements(SCHEMA).map((s) => SCHEMA.slice(s.from, s.to).split(/\s+/).slice(0, 2).join(" "));
    expect(parts).toEqual(["CREATE TABLE", "CREATE TABLE", "CREATE TABLE", "ALTER TABLE", "INSERT INTO", "SELECT *"]);
    expect(splitStatements("SELECT $$a;b$$; SELECT 2").length).toBe(2);
    expect(unquoteName('"public"."Order"')).toBe("public.Order");
  });

  it("reads tables, keys and references", () => {
    const m = parseSql(SCHEMA);
    expect(m.statements.map((s) => s.kind)).toEqual(["CREATE TABLE", "CREATE TABLE", "CREATE TABLE", "ALTER TABLE", "INSERT", "SELECT"]);
    expect(m.tables.map((t) => t.name)).toEqual(["customers", "orders", "order_items"]);
    const customers = m.tables[0];
    expect(customers.columns.map((c) => [c.name, c.type, c.pk, c.unique])).toEqual([
      ["id", "SERIAL", true, false], ["name", "VARCHAR(120)", false, false], ["email", "TEXT", false, true], ["country", "CHAR(2)", false, false],
    ]);
    expect(m.tables[1].columns.find((c) => c.name === "id")?.pk).toBe(true);
    expect(m.tables[1].columns.find((c) => c.name === "total")?.type).toBe("NUMERIC(10, 2)");
    expect(m.tables[2].columns.filter((c) => c.pk).map((c) => c.name)).toEqual(["order_id", "sku"]);
    expect(m.relations.map((r) => `${r.table}.${r.columns} -> ${r.refTable}.${r.refColumns}`)).toEqual([
      "orders.customer_id -> customers.id", "order_items.order_id -> orders.id", "order_items.sku -> products.sku",
    ]);
  });

  it("reads the rows of INSERT statements", () => {
    const m = parseSql(SCHEMA);
    expect(m.data).toEqual([{ table: "customers", columns: ["id", "name", "email"], rows: [["1", "Acme; Corp", "a@acme.test"], ["2", "O'Brien", "NULL"]], from: SCHEMA.indexOf("INSERT") }]);
  });

  it("draws an entity-relationship diagram", () => {
    const er = erDiagram(parseSql(SCHEMA))!;
    expect(er.split("\n").slice(0, 2)).toEqual(["erDiagram", "  direction LR"]);
    expect(er).toContain('t1["customers"] {');
    expect(er).toContain("    SERIAL id PK");
    expect(er).toContain("    NUMERIC(10_2) total");
    expect(er).toContain('t2 }o--|| t1 : "customer_id"');
    expect(er).toContain('t3 }o--|| t2 : "order_id"'); // part of a composite key: many-to-one
    expect(er).toContain('t4["products"]');
    expect(erDiagram(parseSql("SELECT 1;"))).toBeNull();
  });
});
