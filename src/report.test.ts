import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./core/settings";
import { makeTaskConfig } from "./editor/tasks";
import { buildReport, periodFor } from "./report";

const cfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses,
  cycle: DEFAULT_SETTINGS.task_cycle,
  done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done",
  archiveDate: true,
});
const today = new Date(2026, 10, 2);

describe("bilan", () => {
  const sources = [
    {
      project: "mc",
      doneText: [
        "- appeler collègue X - done [2026-01-15]",
        "- migrer la base - ok [2026-01-20]",
        "- vieux truc - done [2025-06-01]",
        "- tâche sans date - ok",
        "",
        "# titre ignoré",
      ].join("\n"),
      activeText: "- spec API - ongoing\n- démo - todo\n- bug - blocked\n- fini - done",
    },
    { project: "perso", doneText: "- lire un livre - done [2026-03-03]", activeText: null },
  ];

  it("filtre sur l'année et groupe par projet et par mois", () => {
    const md = buildReport(sources, cfg, periodFor("year", today), today);
    expect(md).toContain("# Bilan d'activité — Année 2026");
    expect(md).toContain("**4 tâches terminées** sur **2 projets**");
    expect(md).toContain("| mc | 3 | 1 | 1 | 1 |");
    expect(md).toContain("### Janvier 2026\n- appeler collègue X\n- migrer la base");
    expect(md).toContain("### Sans date\n- tâche sans date");
    expect(md).not.toContain("vieux truc");
    expect(md).toContain("Mois le plus productif : **janvier 2026** (2 tâches)");
    expect(md).toContain("- **mc** : spec API");
  });

  it("l'année précédente", () => {
    const md = buildReport(sources, cfg, periodFor("lastYear", today), today);
    expect(md).toContain("- vieux truc");
    expect(md).not.toContain("appeler collègue X");
  });

  it("message d'aide si rien à montrer", () => {
    expect(buildReport([], cfg, periodFor("all", today), today)).toContain("Aucune tâche archivée");
  });
});
