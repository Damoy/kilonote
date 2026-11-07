// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { renderMarkdown } from "./markdown-render";
import { makeTaskConfig } from "../../text/tasks";

const taskCfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done", archiveDate: true,
});
const render = (src: string) => renderMarkdown(src, { taskCfg, today: "2026-11-07" });

describe("Markdown preview", () => {
  it("renders the usual blocks and inline styles", () => {
    const md = render("# Title\n\nSome **bold**, *em*, ~~old~~ and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n---\n");
    expect(md.querySelector("h1")?.textContent).toBe("Title");
    expect(md.querySelector("p strong")?.textContent).toBe("bold");
    expect(md.querySelector("p em")?.textContent).toBe("em");
    expect(md.querySelector("p del")?.textContent).toBe("old");
    expect(md.querySelector("p code")?.textContent).toBe("code");
    expect([...md.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(md.querySelectorAll("ol li")).toHaveLength(2);
    expect(md.querySelector("blockquote")?.textContent?.trim()).toBe("quote");
    expect(md.querySelector("hr")).not.toBeNull();
  });

  it("renders code blocks, tables and checkboxes", () => {
    expect(render("```\na\n  b\n```\n").querySelector("pre code")?.textContent).toBe("a\n  b");
    expect(render("    indented\n    code\n").querySelector("pre code")?.textContent).toBe("indented\ncode");
    const md = render("```js\nconst a = 1 < 2;\n```\n\n| A | B |\n|---|---|\n| 1 | **2** |\n\n- [x] shipped\n- [ ] later\n");
    expect(md.querySelector("pre code")?.textContent).toBe("const a = 1 < 2;");
    expect((md.querySelector("pre code") as HTMLElement).dataset.lang).toBe("js");
    expect([...md.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["A", "B"]);
    expect(md.querySelector("td strong")?.textContent).toBe("2");
    const boxes = [...md.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(md.querySelectorAll("li")[0].textContent?.trim()).toBe("shipped");
  });

  it("shows KiloNote tasks with their status", () => {
    const md = render("- call the client @2026-11-01 - todo\n- shipped - done [2026-11-02]\n");
    const badges = [...md.querySelectorAll<HTMLElement>(".md-status")];
    expect(badges.map((b) => b.textContent)).toEqual(["todo", "done"]);
    expect(badges[0].dataset.due).toBe("overdue");
    expect(md.querySelector(".md-task-text.done")?.textContent).toBe("shipped");
    expect(md.querySelector(".md-stamp")?.textContent?.trim()).toBe("[2026-11-02]");
  });

  it("never interprets HTML, loads images or runs links", () => {
    const md = render('<img src=x onerror="alert(1)">\n\n<b>hi</b> there\n\n[site](https://example.com) [bad](javascript:alert(1)) ![logo](https://example.com/a.png)\n');
    expect(md.querySelector("img, script, b, iframe")).toBeNull();
    expect(md.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(md.textContent).toContain("<b>hi</b>");
    const links = [...md.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => a.dataset.url ?? null)).toEqual(["https://example.com", null]);
    expect(links.every((a) => !a.hasAttribute("href"))).toBe(true);
    expect(md.querySelector(".md-image")?.textContent).toBe("🖼 logo");
  });

  it("decodes entities and escapes", () => {
    const md = render("Tom &amp; Jerry &#x2713; \\*not em\\*\n");
    expect(md.textContent).toBe("Tom & Jerry ✓ *not em*");
  });
});

describe("incremental rendering", async () => {
  const { renderMarkdownBlocks } = await import("./markdown-render");
  const { GFM, parser } = await import("@lezer/markdown");
  const cfg = makeTaskConfig({ statuses: { todo: "blue", done: "green" }, cycle: ["todo", "done"], done: ["done"], archiveStatus: "done", archiveDate: false });
  it("reuses the blocks whose text did not change", () => {
    const a = "# Title\n\nFirst paragraph.\n\n- one\n- two\n\nLast paragraph.\n";
    const first = renderMarkdownBlocks(a, { taskCfg: cfg });
    const kept = [...first.root.childNodes];
    const b = a.replace("First paragraph.", "First paragraph, edited.");
    const second = renderMarkdownBlocks(b, { taskCfg: cfg, reuse: first.blocks });
    const now = [...second.root.childNodes];
    expect(now.length).toBe(kept.length);
    expect(now[0]).toBe(kept[0]); // the heading: same element
    expect(now[1]).not.toBe(kept[1]); // the edited paragraph: built again
    expect(now[1].textContent).toBe("First paragraph, edited.");
    expect(now[2]).toBe(kept[2]);
    expect(now[3]).toBe(kept[3]);
  });

  it("renders the same with the editor's tree as with its own parsing", () => {
    const src = "# A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n- task - todo\n\n```js\nlet a;\n```\n";
    const tree = parser.configure(GFM).parse(src);
    expect(renderMarkdownBlocks(src, { taskCfg: cfg, tree }).root.innerHTML).toBe(renderMarkdownBlocks(src, { taskCfg: cfg }).root.innerHTML);
  });
});
