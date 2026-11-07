// Activity report: reads the archive files (*_done.txt) and produces a
// Markdown summary by project and by month, ready to paste into a yearly review.

import { findDateInLine, hasTag, isBlockedStatus, isDoneStatus, isOngoingStatus, parseTask, todayISO, type TaskConfig } from "./editor/tasks";

export interface ReportSource {
  project: string;
  doneText: string | null;
  activeText: string | null;
}

export interface Period {
  label: string;
  from: string | null; // YYYY-MM-DD, inclusive
  to: string | null; // YYYY-MM-DD, inclusive
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split("-").map(Number);
  const name = MONTHS[m - 1] ?? "?";
  return `${name} ${y}`;
}

export type PeriodKind = "week" | "lastWeek" | "month" | "lastMonth" | "year" | "lastYear" | "12months" | "all";

export function periodFor(kind: PeriodKind, today = new Date()): Period {
  const y = today.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  const shift = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d;
  };
  const short = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const monday = shift(-((today.getDay() + 6) % 7));
  switch (kind) {
    case "week":
      return { label: `Week of ${short(monday)}`, from: todayISO(monday), to: todayISO(shift(6 - ((today.getDay() + 6) % 7))) };
    case "lastWeek": {
      const from = new Date(monday);
      from.setDate(from.getDate() - 7);
      const to = new Date(monday);
      to.setDate(to.getDate() - 1);
      return { label: `Week of ${short(from)}`, from: todayISO(from), to: todayISO(to) };
    }
    case "month":
    case "lastMonth": {
      const first = new Date(y, today.getMonth() - (kind === "lastMonth" ? 1 : 0), 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
      return { label: monthLabel(todayISO(first).slice(0, 7)), from: todayISO(first), to: todayISO(last) };
    }
    case "year":
      return { label: `Year ${y}`, from: `${y}-01-01`, to: `${y}-12-31` };
    case "lastYear":
      return { label: `Year ${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "12months": {
      const from = new Date(today);
      from.setFullYear(y - 1);
      from.setDate(from.getDate() + 1);
      const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return { label: "Last 12 months", from: iso(from), to: iso(today) };
    }
    default:
      return { label: "All time", from: null, to: null };
  }
}

interface DoneItem {
  text: string;
  date: string | null;
  raw: string;
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
    out.push({ text: body, date, raw: line });
  }
  return out;
}

const inPeriod = (date: string, p: Period) => (!p.from || date >= p.from) && (!p.to || date <= p.to);

export interface ReportOptions {
  /** Only the tasks with this tag ("#client"). */
  tag?: string | null;
}

export function buildReport(sources: ReportSource[], cfg: TaskConfig, period: Period, today = new Date(), opts: ReportOptions = {}): string {
  const tag = opts.tag ?? null;
  const bounded = !!(period.from || period.to);
  let undatedSkipped = 0;
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
      if (tag && !hasTag(item.raw, tag)) continue;
      if (!item.date && bounded) {
        // No date: impossible to place in a period, only "All time" counts it.
        undatedSkipped++;
        continue;
      }
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
      if (tag && !hasTag(raw, tag)) continue;
      if (isOngoingStatus(task.key, cfg)) p.ongoing.push(task.text);
      else if (isBlockedStatus(task.key, cfg)) p.blocked++;
      else p.todo++;
    }
    if (p.done || p.ongoing.length || p.todo || p.blocked) projects.push(p);
  }
  projects.sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));

  const total = projects.reduce((n, p) => n + p.done, 0);
  const fmtDate = today.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
  const lines: string[] = [];
  lines.push(`# Activity report — ${period.label}${tag ? ` · ${tag}` : ""}`, "");
  lines.push(`_Generated by KiloNote on ${fmtDate}._`, "");

  const undatedNote = undatedSkipped
    ? `_${undatedSkipped} archived task${undatedSkipped > 1 ? "s have" : " has"} no date: only “All time” counts ${undatedSkipped > 1 ? "them" : "it"}._`
    : null;
  if (!projects.length) {
    lines.push(`No archived task found for this period${tag ? ` with ${tag}` : ""}.`, "");
    if (undatedNote) lines.push(undatedNote, "");
    lines.push("Tip: archive a completed task with **Ctrl+Shift+Enter**; it moves to `<project>_done.txt`, stamped with the date.");
    return lines.join("\n") + "\n";
  }

  const withDone = projects.filter((p) => p.done).length;
  lines.push(`**${total} task${total === 1 ? "" : "s"} completed** across **${withDone} project${withDone === 1 ? "" : "s"}**.`);
  const [best, second] = [...monthTotals].sort((a, b) => b[1] - a[1]);
  if (best && best[1] > 1 && (!second || best[1] > second[1])) lines.push(`Most productive month: **${monthLabel(best[0])}** (${best[1]} tasks).`);
  lines.push("");

  lines.push("| Project | Done | Ongoing | To do | Blocked |", "|---|---:|---:|---:|---:|");
  // A "|" in a folder or file name would break the table.
  for (const p of projects) lines.push(`| ${p.name.replace(/\|/g, "\\|")} | ${p.done} | ${p.ongoing.length} | ${p.todo} | ${p.blocked} |`);
  lines.push("");

  for (const p of projects.filter((x) => x.done)) {
    lines.push(`## ${p.name} — ${p.done} task${p.done > 1 ? "s" : ""}`, "");
    for (const month of [...p.byMonth.keys()].sort()) {
      lines.push(`### ${monthLabel(month)}`);
      for (const t of p.byMonth.get(month)!) lines.push(`- ${t}`);
      lines.push("");
    }
    if (p.undated.length) {
      lines.push("### Undated");
      for (const t of p.undated) lines.push(`- ${t}`);
      lines.push("");
    }
  }

  const ongoing = projects.flatMap((p) => p.ongoing.map((t) => `- **${p.name}**: ${t}`));
  if (ongoing.length) lines.push("## Currently in progress", "", ...ongoing, "");
  if (undatedNote) lines.push(undatedNote, "");
  return lines.join("\n");
}
