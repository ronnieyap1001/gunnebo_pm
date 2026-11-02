import "server-only";
import writeXlsxFile, { type Cell, type Row, type SheetData } from "write-excel-file/node";
import type { State } from "@/domain/types";
import { STATE_META } from "@/domain/state";

/** Everything the Excel export needs, already formatted for display. Built by the export route from the project query. */
export interface ProjectExportInput {
  project: {
    code: string;
    name: string;
    status: string;
    /** Detail fields in order, e.g. [{ label: "Customer", value: "SITA" }]. */
    details: { label: string; value: string }[];
    progress: { done: number; applicable: number; pct: number };
    counts: Record<State, number>;
    /** e.g. "25 Oct 2026, 10:30 (Asia/Singapore)". */
    exportedAt: string;
  };
  steps: {
    seq: number;
    name: string;
    fieldType: string;
    value: string;
    state: State;
    flag: string;
    current: boolean;
    comesAfter: string;
    lastChanged: string;
    latestNote: string;
    files: string;
    projectOnly: boolean;
  }[];
  history: {
    at: string;
    step: string;
    type: string;
    source: string;
    actor: string;
    summary: string;
    oldValue: string;
    newValue: string;
  }[];
  files: { step: string; kind: string; name: string; url: string; size: string; archived: boolean }[];
}

/** Light fills and dark text matching the app's state colours. */
export const STATE_HEX: Record<State, { fill: string; text: string }> = {
  NOT_STARTED: { fill: "#F1F3F5", text: "#4A5361" },
  IN_PROGRESS: { fill: "#E3EEFF", text: "#1D4ED8" },
  WAITING: { fill: "#FEF3C7", text: "#92400E" },
  BLOCKED: { fill: "#FEE2E2", text: "#B91C1C" },
  DONE: { fill: "#DCFCE7", text: "#166534" },
  NOT_APPLICABLE: { fill: "#FFFFFF", text: "#9CA3AF" },
};

const header = (labels: string[]): Row => labels.map((l) => ({ value: l, fontWeight: "bold", backgroundColor: "#E5E7EB" }) as Cell);
const text = (v: string | number | null | undefined): Cell => (v === null || v === undefined || v === "" ? null : { value: String(v), type: String });

/** Excel sheet names: max 31 chars, no []:*?/\ */
export function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);
}

/** Download filename, e.g. "C0822 Heathrow T5 2026-10-25.xlsx" (characters Windows rejects removed). */
export function exportFileName(code: string, name: string, ymd: string): string {
  const base = `${code} ${name}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base} ${ymd}.xlsx`;
}

export async function buildProjectXlsx(input: ProjectExportInput): Promise<Buffer> {
  const p = input.project;

  const summary: SheetData = [
    [{ value: `${p.code} · ${p.name}`, fontWeight: "bold", fontSize: 14 }],
    [text("Status"), text(p.status)],
    ...p.details.map((d) => [text(d.label), text(d.value)] as Row),
    [null],
    [text("Progress"), text(`${p.progress.done} of ${p.progress.applicable} applicable milestones done (${p.progress.pct} %)`)],
    ...(Object.keys(STATE_META) as State[]).map(
      (s) =>
        [
          { value: STATE_META[s].label, backgroundColor: STATE_HEX[s].fill, textColor: STATE_HEX[s].text },
          { value: p.counts[s] ?? 0, type: Number },
        ] as Row,
    ),
    [null],
    [text("Exported"), text(p.exportedAt)],
  ];

  const milestones: SheetData = [
    header(["#", "Milestone", "Type", "Value", "State", "Flag", "Current", "Comes after", "Last changed", "Latest note", "Links & files"]),
    ...input.steps.map(
      (s) =>
        [
          { value: s.seq, type: Number },
          text(s.projectOnly ? `${s.name} (project only)` : s.name),
          text(s.fieldType),
          text(s.value),
          {
            value: STATE_META[s.state].label,
            backgroundColor: STATE_HEX[s.state].fill,
            textColor: STATE_HEX[s.state].text,
            fontWeight: s.state === "BLOCKED" ? "bold" : undefined,
          },
          text(s.flag),
          text(s.current ? "Yes" : ""),
          text(s.comesAfter),
          text(s.lastChanged),
          text(s.latestNote),
          text(s.files),
        ] as Row,
    ),
  ];

  const history: SheetData = [
    header(["When", "Milestone", "What", "Source", "Who", "Summary", "Old value", "New value"]),
    ...input.history.map((h) => [text(h.at), text(h.step), text(h.type), text(h.source), text(h.actor), text(h.summary), text(h.oldValue), text(h.newValue)] as Row),
  ];

  const files: SheetData = [
    header(["Milestone", "Kind", "Name", "Link", "Size", "Archived"]),
    ...input.files.map((f) => [text(f.step), text(f.kind), text(f.name), text(f.url), text(f.size), text(f.archived ? "Yes" : "")] as Row),
  ];

  const result = writeXlsxFile([
    { data: summary, sheet: "Summary", columns: [{ width: 26 }, { width: 60 }] },
    {
      data: milestones,
      sheet: "Milestones",
      stickyRowsCount: 1,
      columns: [{ width: 5 }, { width: 44 }, { width: 12 }, { width: 28 }, { width: 15 }, { width: 9 }, { width: 8 }, { width: 36 }, { width: 20 }, { width: 50 }, { width: 30 }],
    },
    { data: history, sheet: "History", stickyRowsCount: 1, columns: [{ width: 20 }, { width: 36 }, { width: 22 }, { width: 9 }, { width: 10 }, { width: 70 }, { width: 24 }, { width: 24 }] },
    { data: files, sheet: "Files & links", stickyRowsCount: 1, columns: [{ width: 36 }, { width: 8 }, { width: 40 }, { width: 60 }, { width: 10 }, { width: 9 }] },
  ]);
  return result.toBuffer();
}
