// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { makeTaskConfig } from "../../text/tasks";
import { SECRET_BEGIN, SECRET_END } from "../../text/secrets";
import { paperColor, paperDocument, renderPaper } from "./paper";

const taskCfg = makeTaskConfig({
  statuses: { ...DEFAULT_SETTINGS.task_statuses, waiting: "#ffe066" },
  cycle: DEFAULT_SETTINGS.task_cycle,
  done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done",
  archiveDate: true,
});
const style = (el: Element | null | undefined) => (el?.getAttribute("style") ?? "").replace(/\s+/g, "");
const paper = (src: string, lang = "text", extra = {}) => renderPaper(src, { lang, taskCfg, today: "2026-11-11", ...extra });

/** Every element has its style inline, and nothing of the app is left on it. */
function expectClean(root: HTMLElement) {
  for (const el of root.querySelectorAll("*")) {
    expect(el.getAttribute("class")).toBeNull();
    expect(el.getAttributeNames().filter((n) => n.startsWith("data-"))).toEqual([]);
  }
  expect(root.querySelector("input, script, button")).toBeNull();
}

describe("a plain note on paper", () => {
  it("keeps its lines, headings, lists and tasks", async () => {
    const root = await paper("# Week\nfirst line\n\n- call the bank - todo\n  - ask for the form\n- old thing - done [2026-11-02]\n1. one\n2. two\n---\nsee https://example.com/a.\n`code` and **bold**");
    expect(root.querySelector("h1")?.textContent).toBe("Week");
    expect(style(root.querySelector("h1"))).toContain("font-size");
    const items = [...root.querySelectorAll("ul > li")];
    expect(items[0].firstElementChild?.textContent).toBe("call the bank");
    expect(items[0].children[1]?.textContent).toBe("todo");
    // A deeper bullet is a list inside the item above it.
    expect(items[0].querySelector("ul > li")?.textContent).toBe("ask for the form");
    const done = items.find((li) => li.textContent?.startsWith("old thing"))!;
    expect(style(done.querySelector("span"))).toContain("line-through");
    expect(done.textContent).toContain("[2026-11-02]");
    expect([...root.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(root.querySelector("hr")).not.toBeNull();
    const a = root.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/a");
    expect(root.querySelector("code")?.textContent).toBe("code");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expectClean(root);
  });

  it("shows a status as a colored badge, readable on its color", async () => {
    const root = await paper("send it - ongoing\nwait for them - waiting");
    const badges = [...root.querySelectorAll("span")].filter((s) => style(s).includes("border-radius:9px"));
    expect(badges.map((b) => b.textContent)).toEqual(["ongoing", "waiting"]);
    expect(style(badges[0])).toContain(`background-color:${paperColor(DEFAULT_SETTINGS.task_statuses.ongoing)}`);
    // A light color of the user's: dark text on it.
    expect(style(badges[1])).toContain(";color:#1f1e24");
  });

  it("never shows a secret, and keeps the indentation of plain lines", async () => {
    const root = await paper(`server notes\n${SECRET_BEGIN}\nQUJDREVGR0g=\n${SECRET_END}\n    indented`);
    expect(root.textContent).not.toContain("QUJDREVGR0g");
    expect(root.textContent).toContain("Encrypted secret");
    expect(root.textContent).toContain("    indented");
  });

  it("only links web pages: other schemes stay text", async () => {
    const root = await paper("javascript:alert(1) file:///c:/x [[other note|the other]]");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("the other");
  });

  it("keeps a code block as written, blank lines included", async () => {
    const root = await paper("before\n```\n\n  x = 1\n\n```\nafter");
    expect(root.querySelector("pre")?.textContent).toBe("\n  x = 1\n");
    expect(root.textContent).toContain("after");
  });

  it("puts images in when they can be read, their description otherwise", async () => {
    const two = await paper("![first](a.png) ![second](<b c.png>)", "text", { image: async () => null });
    expect(two.textContent).toBe("[first][second]");
    const withImage = await paper("![shot](images/a.png)", "text", { image: async () => "data:image/png;base64,AAAA" });
    expect(withImage.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const without = await paper("![shot](images/a.png)", "text", { image: async () => null });
    expect(without.querySelector("img")).toBeNull();
    expect(without.textContent).toBe("[shot]");
  });
});

describe("a Markdown note on paper", () => {
  it("keeps links to web pages only, turns check boxes into symbols", async () => {
    const root = await paper("# Plan\n\n- [x] shipped\n- [ ] later\n\n[site](https://example.com) and [local](notes/a.md)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n", "markdown");
    expect(root.textContent).toContain("☑ shipped");
    expect(root.textContent).toContain("☐ later");
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(root.textContent).toContain("local");
    expect(style(root.querySelector("td"))).toContain("border:1pxsolid");
    expectClean(root);
  });

  it("draws diagrams when it can, keeps their code otherwise", async () => {
    const md = "```mermaid\ngraph TD; A-->B\n```\n";
    const drawn = await paper(md, "markdown", { diagram: async () => "data:image/svg+xml;base64,PHN2Zy8+" });
    expect(drawn.querySelector("img")?.getAttribute("src")).toContain("data:image/svg+xml");
    const failed = await paper(md, "markdown", { diagram: async () => Promise.reject(new Error("bad")) });
    expect(failed.querySelector("pre")?.textContent).toContain("A-->B");
  });

  it("makes a whole page with an escaped title", async () => {
    const page = paperDocument(await paper("hello"), "<Notes> & co");
    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(page).toContain("<title>&lt;Notes&gt; &amp; co</title>");
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).not.toContain("<script");
  });
});

describe("a code file on paper", () => {
  it("is one block of code, as written", async () => {
    const root = await paper('{\n  "a": "<b>"\n}', "json");
    expect(root.querySelector("pre")?.textContent).toBe('{\n  "a": "<b>"\n}');
    expect(root.querySelector("b")).toBeNull();
  });
});

describe("nothing on paper can run or load anything", () => {
  it("text that looks like HTML stays text, in every kind of note", async () => {
    for (const lang of ["text", "markdown", "json"]) {
      const root = await paper('<script>alert(1)</script> <img src=x onerror=alert(2)> <a href="javascript:alert(3)">x</a>', lang);
      expect(root.querySelector("script, img, iframe")).toBeNull();
      expect(root.querySelector("a[href^='javascript']")).toBeNull();
      expect(root.outerHTML).toContain("&lt;script&gt;");
    }
  });

  it("a link keeps only a web address, quotes and all escaped", async () => {
    const root = await paper('[x](https://example.com/a"onmouseover="alert(1))', "markdown");
    for (const a of root.querySelectorAll("a")) {
      expect(a.getAttributeNames().sort()).toEqual(["href", "style"]);
      expect(a.getAttribute("href")!.startsWith("https://")).toBe(true);
    }
  });

  it("a status color of the settings is a color, nothing more", () => {
    expect(paperColor("#e91e63")).toBe("#e91e63");
    expect(paperColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(paperColor("tomato")).toBe("tomato");
    expect(paperColor("blue")).not.toBe("blue"); // a palette name: its color on paper
    for (const bad of ["rgb(0,0,0);background:url(http://x)", "red;background-image:url(x)", "#fff url(x)", "expression(alert(1))"]) {
      expect(paperColor(bad)).toBe(paperColor(undefined));
    }
  });
});
