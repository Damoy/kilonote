// Bilan d'activité : lit les fichiers d'archive (*_done.txt) et produit un
// résumé Markdown par projet et par mois, prêt à copier pour un entretien annuel.

import { findDateInLine, isDoneStatus, parseTask, type TaskConfig } from "./editor/tasks";

export interface ReportSource {
  project: string;
  doneText: string | null;
  activeText: string | null;
}

export interface Period {
  label: string;
  from: string | null; // AAAA-MM-JJ inclus
  to: string | null; // AAAA-MM-JJ inclus
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const name = MONTHS[m - 1] ?? "?";
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

export function periodFor(kind: "year" | "lastYear" | "12months" | "all", today = new Date()): Period {
  const y = today.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (kind) {
    case "year":
      return { label: `Année ${y}`, from: `${y}-01-01`, to: `${y}-12-31` };
    case "lastYear":
      return { label: `Année ${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "12months": {
      const from = new Date(today);
      from.setFullYear(y - 1);
      from.setDate(from.getDate() + 1);
      const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return { label: "12 derniers mois", from: iso(from), to: iso(today) };
    }
    default:
      return { label: "Tout l'historique", from: null, to: null };
  }
}

interface DoneItem {
  text: string;
  date: string | null;
}

function parseDoneLines(text: string, cfg: TaskConfig): DoneItem[] {
  const out: DoneItem[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || /^#/.test(line) || /^(?:-{3,}|={3,})$/.test(line)) continue;
    const task = parseTask(line, cfg);
    let body = task ? task.text : line.replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, "");
    const date = task?.date ?? findDateInLine(line);
    if (!task) body = body.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, "");
    out.push({ text: body, date });
  }
  return out;
}

const inPeriod = (date: string, p: Period) => (!p.from || date >= p.from) && (!p.to || date <= p.to);

export function buildReport(sources: ReportSource[], cfg: TaskConfig, period: Period, today = new Date()): string {
  interface Proj {
    name: string;
    byMonth: Map<string, string[]>;
    undated: string[];
    done: number;
    ongoing: string[];
    todo: number;
    blocked: number;
  }
  const projects: Proj[] = [];
  const monthTotals = new Map<string, number>();

  for (const src of sources) {
    const p: Proj = { name: src.project, byMonth: new Map(), undated: [], done: 0, ongoing: [], todo: 0, blocked: 0 };
    for (const item of src.doneText ? parseDoneLines(src.doneText, cfg) : []) {
      if (item.date) {
        if (!inPeriod(item.date, period)) continue;
        const month = item.date.slice(0, 7);
        if (!p.byMonth.has(month)) p.byMonth.set(month, []);
        p.byMonth.get(month)!.push(item.text);
        monthTotals.set(month, (monthTotals.get(month) ?? 0) + 1);
      } else p.undated.push(item.text);
      p.done++;
    }
    for (const raw of src.activeText?.split(/\r\n|\r|\n/) ?? []) {
      const task = parseTask(raw, cfg);
      if (!task || isDoneStatus(task.key, cfg)) continue;
      if (task.key === "ongoing") p.ongoing.push(task.text);
      else if (task.key === "blocked") p.blocked++;
      else p.todo++;
    }
    if (p.done || p.ongoing.length || p.todo || p.blocked) projects.push(p);
  }
  projects.sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));

  const total = projects.reduce((n, p) => n + p.done, 0);
  const fmtDate = today.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const lines: string[] = [];
  lines.push(`# Bilan d'activité — ${period.label}`, "");
  lines.push(`_Généré par KiloNote le ${fmtDate}._`, "");

  if (!projects.length) {
    lines.push("Aucune tâche archivée trouvée pour cette période.", "");
    lines.push("Astuce : archivez une tâche terminée avec **Ctrl+Maj+Entrée** ; elle part dans le fichier `<projet>_done.txt` avec sa date.");
    return lines.join("\n") + "\n";
  }

  const withDone = projects.filter((p) => p.done).length;
  lines.push(`**${total} tâche${total > 1 ? "s" : ""} terminée${total > 1 ? "s" : ""}** sur **${withDone} projet${withDone > 1 ? "s" : ""}**.`);
  const [best, second] = [...monthTotals].sort((a, b) => b[1] - a[1]);
  if (best && best[1] > 1 && (!second || best[1] > second[1])) lines.push(`Mois le plus productif : **${monthLabel(best[0]).toLowerCase()}** (${best[1]} tâche${best[1] > 1 ? "s" : ""}).`);
  lines.push("");

  lines.push("| Projet | Terminées | En cours | À faire | Bloquées |", "|---|---:|---:|---:|---:|");
  for (const p of projects) lines.push(`| ${p.name} | ${p.done} | ${p.ongoing.length} | ${p.todo} | ${p.blocked} |`);
  lines.push("");

  for (const p of projects.filter((x) => x.done)) {
    lines.push(`## ${p.name} — ${p.done} tâche${p.done > 1 ? "s" : ""}`, "");
    for (const month of [...p.byMonth.keys()].sort()) {
      lines.push(`### ${monthLabel(month)}`);
      for (const t of p.byMonth.get(month)!) lines.push(`- ${t}`);
      lines.push("");
    }
    if (p.undated.length) {
      lines.push("### Sans date");
      for (const t of p.undated) lines.push(`- ${t}`);
      lines.push("");
    }
  }

  const ongoing = projects.flatMap((p) => p.ongoing.map((t) => `- **${p.name}** : ${t}`));
  if (ongoing.length) lines.push("## Actuellement en cours", "", ...ongoing, "");
  return lines.join("\n");
}
