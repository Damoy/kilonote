import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import {
  applyLineEdit, archivedLine, cycleLine, findDateInLine, findTasks, makeTaskConfig, nextStatus, parseTask,
} from "./tasks";

const cfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses,
  cycle: DEFAULT_SETTINGS.task_cycle,
  done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done",
  archiveDate: true,
});

const cycle = (line: string, target?: string) => {
  const edit = cycleLine(line, cfg, target);
  return edit ? applyLineEdit(line, edit) : null;
};

describe("parseTask", () => {
  it("reconnaît le format de base", () => {
    const t = parseTask("- appeller collegue X - todo", cfg)!;
    expect(t.text).toBe("appeller collegue X");
    expect(t.key).toBe("todo");
    expect(t.bullet).toBe("- ");
  });

  it("gère les tirets dans le texte, la casse, l'indentation et le tampon de date", () => {
    const t = parseTask("    * revue A - B - ONGOING [2026-03-04] ", cfg)!;
    expect(t.text).toBe("revue A - B");
    expect(t.key).toBe("ongoing");
    expect(t.indent).toBe("    ");
    expect(t.date).toBe("2026-03-04");
  });

  it("accepte une ligne sans puce et le tiret long", () => {
    expect(parseTask("Appeler Paul — ok", cfg)?.key).toBe("ok");
  });

  it("ignore les lignes qui ne sont pas des tâches", () => {
    expect(parseTask("- appeler X", cfg)).toBeNull();
    expect(parseTask("- todo", cfg)).toBeNull();
    expect(parseTask("- appeler X - todos", cfg)).toBeNull();
    expect(parseTask("todo", cfg)).toBeNull();
  });
});

describe("cycleLine", () => {
  it("fait tourner les statuts", () => {
    expect(cycle("- appeler X - todo")).toBe("- appeler X - ongoing");
    expect(cycle("- appeler X - ongoing")).toBe("- appeler X - done");
    expect(cycle("- appeler X - done")).toBe("- appeler X - todo");
    expect(cycle("- appeler X - blocked")).toBe("- appeler X - todo");
  });

  it("transforme une ligne en tâche", () => {
    expect(cycle("- appeler X")).toBe("- appeler X - todo");
    expect(cycle("appeler X  ")).toBe("- appeler X - todo");
    expect(cycle("  1. appeler X")).toBe("  1. appeler X - todo");
  });

  it("prépare une tâche vide sur une ligne vide", () => {
    const edit = cycleLine("", cfg)!;
    expect(applyLineEdit("", edit)).toBe("-  - todo");
    expect(edit.cursor).toBe(2);
  });

  it("ne touche pas aux titres", () => {
    expect(cycle("# Projet MC")).toBeNull();
  });

  it("force un statut précis", () => {
    expect(cycle("- appeler X - todo", "done")).toBe("- appeler X - done");
    expect(cycle("- appeler X", "ongoing")).toBe("- appeler X - ongoing");
  });

  it("nextStatus suit le cycle configuré", () => {
    expect(nextStatus(null, cfg)).toBe("todo");
    expect(nextStatus("TODO", cfg)).toBe("ongoing");
  });
});

describe("archivedLine", () => {
  it("passe la tâche en done et ajoute la date", () => {
    expect(archivedLine("  - appeler X - ongoing", cfg, "2026-11-02")).toBe("- appeler X - done [2026-11-02]");
  });

  it("conserve un statut déjà terminé (ok) et un tampon existant", () => {
    expect(archivedLine("- appeler X - ok", cfg, "2026-11-02")).toBe("- appeler X - ok [2026-11-02]");
    expect(archivedLine("- appeler X - done [2025-01-01]", cfg, "2026-11-02")).toBe("- appeler X - done [2025-01-01]");
  });

  it("archive aussi une ligne simple", () => {
    expect(archivedLine("appeler X", cfg, "2026-11-02")).toBe("- appeler X - done [2026-11-02]");
  });

  it("sans date si désactivé", () => {
    const noDate = { ...cfg, archiveDate: false };
    expect(archivedLine("- appeler X - todo", noDate)).toBe("- appeler X - done");
  });
});

describe("findTasks / dates", () => {
  it("liste les tâches d'un texte", () => {
    const found = findTasks("# MC\r\n- a - todo\r\nnote\r\n- b - ongoing\n", cfg);
    expect(found.map((f) => [f.line, f.task.key])).toEqual([[2, "todo"], [4, "ongoing"]]);
  });

  it("trouve les dates ISO et françaises", () => {
    expect(findDateInLine("- x - done [2026-02-03]")).toBe("2026-02-03");
    expect(findDateInLine("réunion du 4/11/2026")).toBe("2026-11-04");
    expect(findDateInLine("rien")).toBeNull();
  });
});
