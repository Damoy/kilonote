import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatSql, sqlTokens } from "./format-sql";

/** Every token, as written (keywords in any case): what formatting must never change. */
const tokens = (sql: string) => sqlTokens(sql).map((t) => (t.t === "kw" ? t.v.toLowerCase() : t.v));

const SAMPLES = [
  "select a, b as bee, count(*) from t join u on u.id = t.uid left outer join v on v.x=t.x where a = 1 and b between 2 and 3 or c in (select id from w where z > 0) group by a, b having count(*) > 1 order by a desc limit 10;",
  "-- top comment\ninsert into customers (id, name) values (1, 'Acme; Corp'), (2, 'O''Brien'); update t set a = 1, b = 'x' where id = 3 -- trailing\n; delete from t where id in (1,2,3);",
  "with recent as (select * from orders where created_at > now() - interval '7 days') select c.name, sum(r.total) from recent r join customers c on c.id = r.customer_id group by c.name;",
  "SELECT $$a;b$$, E'x\\'y', \"Quoted Name\", [bracket name], arr[1], a - -1, 1.5e3 FROM t /* block */ WHERE x::int = 2 #> '{a}' AND y = @v AND z = :p AND w = ? AND n = $1",
  "select case when a > 1 then 'big' else 'small' end as size from t where not exists (select 1 from u where u.t_id = t.id)",
  "CREATE TABLE x (a INT -- the id\n, b TEXT /* note */, PRIMARY KEY (a));",
];

describe("formatSql", () => {
  it("lays out clauses, lists and subqueries", () => {
    expect(formatSql(SAMPLES[0])).toBe(`SELECT
  a,
  b AS bee,
  count(*)
FROM t
JOIN u ON u.id = t.uid
LEFT OUTER JOIN v ON v.x=t.x
WHERE a = 1
  AND b BETWEEN 2 AND 3
  OR c IN (
    SELECT
      id
    FROM w
    WHERE z > 0
  )
GROUP BY a, b
HAVING count(*) > 1
ORDER BY a DESC
LIMIT 10;
`);
  });

  it("puts each row of VALUES and each assignment of SET on its line", () => {
    expect(formatSql(SAMPLES[1])).toBe(`-- top comment
INSERT INTO customers (id, name)
VALUES
  (1, 'Acme; Corp'),
  (2, 'O''Brien');

UPDATE t
SET
  a = 1,
  b = 'x'
WHERE id = 3 -- trailing
;

DELETE FROM t
WHERE id IN (1,2,3);
`);
  });

  it("puts each definition of a CREATE TABLE on its line", () => {
    expect(formatSql("create table t (id int primary key, name varchar(20) not null, unique (name));")).toBe(
      "CREATE TABLE t (\n  id int PRIMARY KEY,\n  name varchar(20) NOT NULL,\n  UNIQUE (name)\n);\n",
    );
  });

  it("never changes a token, only spaces, line breaks and keyword case", () => {
    const corpus = [...SAMPLES, readFileSync("examples/schema.sql", "utf8"), readFileSync("examples/query.sql", "utf8")];
    for (const sql of corpus) {
      const once = formatSql(sql);
      expect(tokens(once), sql.slice(0, 40)).toEqual(tokens(sql));
      expect(formatSql(once), "stable").toBe(once);
    }
  });

  it("never glues symbols into a comment or another operator", () => {
    expect(formatSql("select a - -1, b / *c from t")).toContain("a - -1");
    expect(formatSql("select a - -1, b / *c from t")).not.toContain("/*");
  });
});
