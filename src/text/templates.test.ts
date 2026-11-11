import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, fillTemplate, mergeTemplates, type Template } from "./templates";

describe("note templates", () => {
  const at = new Date(2026, 10, 11, 9, 5);

  it("fill in the date, the time, the weekday and the title, and say where the cursor goes", () => {
    const r = fillTemplate("# {{ title }} · {{weekday}} {{date}} {{time}}\n- {{cursor}} - todo\n{{cursor}}{{unknown}}", at, "Notes");
    expect(r.text).toBe("# Notes · Wednesday 2026-11-11 09:05\n- " + " - todo\n{{unknown}}");
    expect(r.text.slice(0, r.cursor)).toBe("# Notes · Wednesday 2026-11-11 09:05\n- ");
    expect(fillTemplate("no cursor", at).cursor).toBe("no cursor".length);
  });

  it("of the user replace the built-in ones with the same name, and come after them", () => {
    const mine = (name: string): Template => ({ name, text: "mine", ext: "md", path: `/t/${name}.md` });
    const all = mergeTemplates([mine("Weekly"), mine("daily NOTE"), mine("Agenda")]);
    expect(all.map((t) => t.name)).toEqual(["daily NOTE", ...BUILTIN_TEMPLATES.slice(1).map((t) => t.name), "Agenda", "Weekly"]);
    expect(all[0].text).toBe("mine");
  });
});
