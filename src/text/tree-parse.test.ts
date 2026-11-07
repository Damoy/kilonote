import { describe, expect, it } from "vitest";
import { keySource, nodePath, parseJsonTree, parseTree, valueSource, xmlPath, type TreeNode } from "./tree-parse";

const find = (n: TreeNode, ...keys: (string | number)[]): TreeNode => keys.reduce((cur, k) => cur.children!.find((c) => c.key === k)!, n);
const edit = (src: string, n: TreeNode, text: string, key = false) => src.slice(0, key ? n.keyFrom! : n.from) + text + src.slice(key ? n.keyTo! : n.to);

describe("JSON tree", () => {
  const src = `{
  // comment
  "name": "kilo", 'single': 'x', bare: 1,
  "list": [1, {"a": null}, true],
}`;
  it("keeps the position of every key and value", () => {
    const root = parseJsonTree(src);
    expect(root.type).toBe("object");
    expect(root.children!.map((c) => [c.key, c.type])).toEqual([["name", "string"], ["single", "string"], ["bare", "number"], ["list", "array"]]);
    const name = find(root, "name");
    expect(src.slice(name.from, name.to)).toBe('"kilo"');
    expect(src.slice(name.keyFrom, name.keyTo)).toBe('"name"');
    expect(find(root, "list", 1, "a").type).toBe("null");
    expect(nodePath([root, find(root, "list"), find(root, "list", 1), find(root, "list", 1, "a")])).toBe("list[1].a");
  });

  it("edits a value or a key without touching the rest", () => {
    const root = parseJsonTree(src);
    let out = edit(src, find(root, "name"), valueSource(find(root, "name"), 'Ki"lo', "json"));
    expect(out).toContain('"name": "Ki\\"lo", \'single\'');
    expect(out).toContain("// comment");
    out = edit(src, find(root, "single"), valueSource(find(root, "single"), "it's", "json"));
    expect(out).toContain("'single': 'it\\'s'");
    // A number can become true, null, or a string.
    expect(valueSource(find(root, "bare"), "42", "json")).toBe("42");
    expect(valueSource(find(root, "bare"), "true", "json")).toBe("true");
    expect(valueSource(find(root, "bare"), "hello", "json")).toBe('"hello"');
    // A string stays a string.
    expect(valueSource(find(root, "name"), "42", "json")).toBe('"42"');
    expect(keySource(find(root, "bare"), "renamed", "json")).toBe("renamed");
    expect(keySource(find(root, "bare"), "with space", "json")).toBe('"with space"');
    expect(keySource(find(root, "name"), "title", "json")).toBe('"title"');
  });

  it("reports errors with their position", async () => {
    const t = await parseTree('{"a": 1,, }', "json");
    expect(t.roots).toEqual([]);
    expect(t.error?.message).toContain("line 1, column 9");
  });
});

describe("YAML tree", () => {
  const src = "# config\nname: kilo\nport: 8080\nempty:\nlist:\n  - a\n  - 'b c'\ntext: |\n  multi\n  line\n---\nsecond: true\n";
  it("reads every document with positions; block scalars are not edited in place", async () => {
    const t = await parseTree(src, "yaml");
    expect(t.error).toBeNull();
    expect(t.roots.map((r) => r.key)).toEqual(["Document 1", "Document 2"]);
    const d1 = t.roots[0];
    expect(find(d1, "port").type).toBe("number");
    expect(src.slice(find(d1, "name").from, find(d1, "name").to)).toBe("kilo");
    expect(find(d1, "list", 1).text).toBe("b c");
    expect(find(d1, "text").editable).toBe(false);
    expect(nodePath([d1, find(d1, "list"), find(d1, "list", 0)])).toBe("list[0]");
  });

  it("writes values that keep their type and quoting", async () => {
    const t = await parseTree(src, "yaml");
    const d1 = t.roots[0];
    expect(valueSource(find(d1, "name"), "kilo note", "yaml")).toBe("kilo note");
    expect(valueSource(find(d1, "name"), "123", "yaml")).toBe('"123"'); // stays a string
    expect(valueSource(find(d1, "name"), "a: b", "yaml")).toBe('"a: b"');
    expect(valueSource(find(d1, "list", 1), "it's", "yaml")).toBe("'it''s'");
    expect(valueSource(find(d1, "port"), "9090", "yaml")).toBe("9090");
    const empty = find(d1, "empty");
    expect(edit(src, empty, valueSource(empty, "now set", "yaml"))).toContain("empty: now set\n");
    expect(keySource(find(d1, "port"), "listen port", "yaml")).toBe("listen port");
  });

  it("reports syntax errors", async () => {
    const t = await parseTree("a: [1, 2\nb: 3\n", "yaml");
    expect(t.error).not.toBeNull();
  });
});

describe("robustness", () => {
  it("never throws: deep or broken documents become an error", async () => {
    for (const [src, fmt] of [
      ["[".repeat(100000) + "]".repeat(100000), "json"],
      ["[".repeat(100000), "yaml"],
      ["a:" + "\n" + " ".repeat(5000) + "b: 1", "yaml"],
      ['{"a": ', "json"],
      ["a: [1,", "yaml"],
    ] as const) {
      const t = await parseTree(src, fmt);
      expect(t.error, `${fmt} ${src.slice(0, 10)}`).not.toBeNull();
    }
  });

  it("the depth check of YAML ignores quotes and comments", async () => {
    const { yamlTooDeep } = await import("./tree-parse");
    expect(yamlTooDeep(`a: "${"[".repeat(2000)}"\nb: '${"{".repeat(2000)}'\n# ${"[".repeat(2000)}\nc: [1, [2]]\n`)).toBe(-1);
    expect(yamlTooDeep("x: " + "[".repeat(600))).toBe(503);
  });

  it("YAML aliases are shown, never expanded", async () => {
    const bomb = "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n";
    const t = await parseTree(bomb, "yaml");
    expect(find(t.roots[0], "c", 0).type).toBe("alias");
    expect(find(t.roots[0], "c", 0).text).toBe("*b");
  });

  it("YAML strings with flow characters are quoted (safe inside [ ] and { })", async () => {
    const t = await parseTree("tags: [a, b]\n", "yaml");
    expect(valueSource(find(t.roots[0], "tags", 0), "x, y", "yaml")).toBe('"x, y"');
    expect(valueSource(find(t.roots[0], "tags", 0), "[x]", "yaml")).toBe('"[x]"');
  });
});

describe("XML tree", () => {
  const src = `<?xml version="1.0"?>
<!-- comment -->
<config env="prod" name='a &amp; b'>
  <title>Kilo &lt;Note&gt;</title>
  <item id="1">first</item>
  <item id="2"><![CDATA[x < y]]></item>
  <empty></empty>
  <flag/>
  mixed text
</config>`;
  it("shows elements, attributes and text, with their positions", async () => {
    const t = await parseTree(src, "xml");
    expect(t.error).toBeNull();
    const root = t.roots[0];
    expect(root.key).toBe("config");
    expect(root.children!.map((c) => c.key)).toEqual(["@env", "@name", "title", "item", "item", "empty", "flag", "#text"]);
    expect(find(root, "@name").text).toBe("a & b");
    const title = find(root, "title");
    expect([title.type, title.text]).toEqual(["string", "Kilo <Note>"]);
    expect(src.slice(title.from, title.to)).toBe("Kilo &lt;Note&gt;");
    const item2 = root.children![4];
    expect(item2.children!.map((c) => [c.key, c.text])).toEqual([["@id", "2"], ["#cdata", "x < y"]]);
    expect(find(root, "flag").type).toBe("null");
    expect(xmlPath([root, item2, item2.children![0]])).toBe("/config/item[2]/@id");
  });

  it("writes values escaped for their place", async () => {
    const t = await parseTree(src, "xml");
    const root = t.roots[0];
    expect(valueSource(find(root, "title"), "a < b & c", "xml")).toBe("a &lt; b &amp; c");
    expect(valueSource(find(root, "@env"), 'say "hi"', "xml")).toBe("say &quot;hi&quot;");
    expect(valueSource(find(root, "@name"), "it's", "xml")).toBe("it&apos;s");
    expect(valueSource(root.children![4].children![1], "a ]]> b", "xml")).toBe("a ]]]]><![CDATA[> b");
    const empty = find(root, "empty");
    expect(src.slice(0, empty.from) + "now" + src.slice(empty.to)).toContain("<empty>now</empty>");
  });

  it("reports mismatched tags", async () => {
    expect((await parseTree("<a><b></a>", "xml")).error?.message).toMatch(/<b> opened at line 1, column 4 is closed by <\/a>/);
    expect((await parseTree("<a>", "xml")).error?.message).toMatch(/never closed/);
  });
});
