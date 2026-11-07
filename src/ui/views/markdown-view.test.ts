// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../app/app";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { makeTaskConfig } from "../../text/tasks";

// Diagrams are drawn by hand in these tests: each drawing waits until it is released.
const pending: { code: string; done: (svg: string) => void }[] = [];
vi.mock("./mermaid", () => ({
  renderMermaid: (code: string) => new Promise<string>((done) => pending.push({ code, done })),
  fixSvgSize: (svg: string) => svg,
  svgDataUrl: (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`,
  diagramError: (e: unknown) => String(e),
}));
const { MarkdownView } = await import("./markdown-view");

const taskCfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done", archiveDate: true,
});
const app = { taskCfg, backend: { openUrl: () => Promise.resolve() } } as unknown as App;
const flush = () => new Promise((r) => setTimeout(r, 0));
const releaseAll = async () => {
  while (pending.length) pending.shift()!.done(`<svg><text>drawn</text></svg>`);
  await flush();
};
const blocks = (v: InstanceType<typeof MarkdownView>) => [...v.el.querySelector(".md")!.children].map((e) => `${e.tagName.toLowerCase()}:${e.textContent?.trim()}`);

afterEach(() => void (pending.length = 0));

describe("Markdown view, rendered as you type", () => {
  it("keeps the blocks in order when the note ends with a link definition", () => {
    const v = new MarkdownView(app);
    v.render("First\n\n[ref]: https://example.com\n\nLast\n", false, { fresh: true });
    v.render("First, edited\n\n[ref]: https://example.com\n\nLast\n", false);
    expect(blocks(v)).toEqual(["p:First, edited", "p:Last"]);
    v.render("First, edited\n\n[ref]: https://example.com\n", false);
    v.render("First, edited again\n\n[ref]: https://example.com\n", false);
    expect(blocks(v)).toEqual(["p:First, edited again"]);
  });

  it("only replaces the block that changed", () => {
    const v = new MarkdownView(app);
    v.render("# Title\n\nOne\n\nTwo\n", false, { fresh: true });
    const title = v.el.querySelector("h1");
    v.render("# Title\n\nOne!\n\nTwo\n", false);
    expect(v.el.querySelector("h1")).toBe(title);
    expect(blocks(v)).toEqual(["h1:Title", "p:One!", "p:Two"]);
  });

  it("finishes drawing the diagrams when the note is edited elsewhere meanwhile", async () => {
    const v = new MarkdownView(app);
    const note = (intro: string) => `${intro}\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; C-->D\n\`\`\`\n`;
    v.render(note("Intro"), false, { fresh: true });
    await flush();
    // Typing in the first paragraph while the first diagram is still being drawn.
    v.render(note("Intro, edited"), false);
    await releaseAll();
    await releaseAll();
    expect(v.el.querySelectorAll("img.md-diagram-img")).toHaveLength(2);
    expect(v.el.querySelector("pre")).toBeNull();
  });

  it("does not draw a diagram whose block was changed before it was drawn", async () => {
    const v = new MarkdownView(app);
    v.render("```mermaid\ngraph TD; A-->B\n```\n", false, { fresh: true });
    await flush();
    v.render("```mermaid\ngraph TD; A-->C\n```\n", false);
    await releaseAll();
    await releaseAll();
    expect(v.el.querySelectorAll("img.md-diagram-img")).toHaveLength(1);
    expect(v.el.querySelectorAll(".md > *")).toHaveLength(1);
  });
});
