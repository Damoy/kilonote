import { describe, expect, it } from "vitest";
import { alignMarkdownTables, formatCss, formatJson, formatKindFor, formatXml, FormatError, minifyJson } from "./format";

describe("formatJson", () => {
  it("indents objects and arrays", () => {
    expect(formatJson('{"a":1,"b":{"c":[1,2],"d":[{"e":null}]},"f":"x"}')).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": [1, 2],\n    "d": [\n      {\n        "e": null\n      }\n    ]\n  },\n  "f": "x"\n}\n',
    );
  });

  it("uses the given indentation and keeps empty containers", () => {
    expect(formatJson('{"a":{},"b":[]}', "\t")).toBe('{\n\t"a": {},\n\t"b": []\n}\n');
  });

  it("keeps comments, trailing commas and blank lines between entries", () => {
    const src = `// KiloNote settings
{
  // Theme
  "theme": "midnight", // dark


  /* sizes */
  "font_size": 14,
  "list": ["a",
     "b",],
}`;
    expect(formatJson(src)).toBe(`// KiloNote settings
{
  // Theme
  "theme": "midnight", // dark

  /* sizes */
  "font_size": 14,
  "list": ["a", "b"],
}
`);
  });

  it("puts the comma before a trailing line comment", () => {
    expect(formatJson('{"a": 1 // one\n, "b": 2}')).toBe('{\n  "a": 1, // one\n  "b": 2\n}\n');
  });

  it("is stable", () => {
    const once = formatJson('{"a":[1,{"b":2}],// c\n"d":"e"}');
    expect(formatJson(once)).toBe(once);
  });

  it("reports the position of an error", () => {
    const err = (s: string) => {
      try {
        formatJson(s);
      } catch (e) {
        return e as FormatError;
      }
      throw new Error("no error");
    };
    expect(err('{"a": 1 "b": 2}').message).toBe('Expected "," or "}" at line 1, column 9, found ""b""');
    expect(err('{\n  "a": [1, 2}\n').message).toBe('Expected "," or "]" at line 2, column 13, found "}"');
    expect(err('{"a": 1').message).toContain("never closed");
    expect(err('{"a": "x\n"}').message).toContain("Unterminated string");
    expect(err("hello world").message).toContain('after the end');
    expect(err('{"a": 1').pos).toBe(0);
  });

  it("minifies", () => {
    expect(minifyJson('{\n  "a": [1, 2], // c\n  "b": "x y"\n}')).toBe('{"a":[1,2],"b":"x y"}');
  });
});

describe("formatXml", () => {
  it("indents nested elements and keeps text inline", () => {
    expect(formatXml('<?xml version="1.0"?><root><item id="1"><name>A &amp; B</name></item><item  id="2"/><!-- end --></root>')).toBe(
      '<?xml version="1.0"?>\n<root>\n  <item id="1">\n    <name>A &amp; B</name>\n  </item>\n  <item id="2"/>\n  <!-- end -->\n</root>\n',
    );
  });

  it("reports mismatched tags in XML", () => {
    expect(() => formatXml("<a><b></a>")).toThrow(/<b> opened at line 1, column 4 is closed by <\/a>/);
    expect(() => formatXml("<a><b></b>")).toThrow(/never closed/);
  });

  it("knows HTML void elements and keeps scripts as written", () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><script>if (a < b) { go(); }</script></head><body><p>Hello <b>you</b></p><br></body></html>';
    expect(formatXml(html, "  ", true)).toBe(
      '<!DOCTYPE html>\n<html>\n  <head>\n    <meta charset="utf-8">\n    <script>if (a < b) { go(); }</script>\n  </head>\n  <body>\n    <p>Hello <b>you</b></p>\n    <br>\n  </body>\n</html>\n',
    );
  });
});

describe("formatters never lose text", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");
  it("HTML with tags left open, stray closing tags and comments", () => {
    for (const src of [
      "<ul><li>One<li>Two <b>bold</ul><p>Para<p>Other",
      "<div><span>a</span></b>text<!-- c --><img src=x></div>",
      "<html><body><pre>  keep\n   this  </pre><textarea> x </textarea></body></html>",
    ]) expect(squash(formatXml(src, "  ", true))).toBe(squash(src));
  });
  it("JSON and CSS", () => {
    const json = '{"a":[1,{"b":"x y"}],/* c */"d":null}';
    expect(squash(formatJson(json))).toBe(squash(json));
    const css = "a{b:c}@media x{d e{f:g;h:url(x;y)}}";
    // (The formatter may only add the optional ";" before a "}".)
    expect(squash(formatCss(css)).replace(/;/g, "")).toBe(squash(css).replace(/;/g, ""));
  });
});

describe("formatCss", () => {
  it("puts one declaration per line", () => {
    expect(formatCss("a:hover,b{color:red;background:url(data:image/png;base64,xx)}/* c */\n@media (max-width:600px){a{margin:0}}")).toBe(
      "a:hover, b {\n  color: red;\n  background: url(data:image/png;base64,xx);\n}\n/* c */\n\n@media (max-width:600px) {\n  a {\n    margin: 0;\n  }\n}\n",
    );
  });
});

describe("alignMarkdownTables", () => {
  it("aligns the columns and keeps the alignment markers", () => {
    expect(alignMarkdownTables("Intro\n\n|Name|Qty|Note|\n|:--|--:|:-:|\n|apple|3|ok|\n|kiwi `a|b`|12|\n\nEnd")).toBe(
      "Intro\n\n| Name       | Qty | Note |\n| :--------- | --: | :--: |\n| apple      |   3 |  ok  |\n| kiwi `a|b` |  12 |      |\n\nEnd",
    );
  });
});

describe("formatKindFor", () => {
  it("follows the document type, or the content of plain text", () => {
    expect(formatKindFor("jsonc", "")).toBe("json");
    expect(formatKindFor("scss", "")).toBe("css");
    expect(formatKindFor("text", '  {"a": 1}')).toBe("json");
    expect(formatKindFor("text", "<!DOCTYPE html><html>")).toBe("html");
    expect(formatKindFor("text", "<a/>")).toBe("xml");
    expect(formatKindFor("text", "a | b\n--- | ---\n1 | 2")).toBe("tables");
    expect(formatKindFor("text", "just a note")).toBe(null);
    expect(formatKindFor("python", "{}")).toBe(null);
  });
});
