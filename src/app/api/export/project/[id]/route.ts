import { formatInstant } from "@/domain/dates";
import { toActionError } from "@/server/actions/run";
import { userOrNull } from "@/server/auth/session";
import { buildProjectXlsx, exportFileName, type ProjectExportInput } from "@/server/export/projectXlsx";
import { getDay, getProjectHistory, getProjectPageData, type HistoryItemDTO } from "@/server/queries";
import { getRepo } from "@/server/repo";
import { eventLabel, SOURCE_LABELS } from "@/components/project/event-types";
import { contentDisposition, json } from "../../../files/http";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9-]{1,200}$/;
const MAX_HISTORY_ROWS = 2000;
const PAGE = 100;

function size(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The project as an .xlsx file: Summary, Milestones (flow order, state colours), History (newest first), Files & links. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await userOrNull())) return json({ ok: false, error: "Session expired. Sign in again", code: "SESSION" }, 401);
  const { id } = await params;
  if (!ID.test(id)) return json({ ok: false, error: "This project was not found." }, 404);

  try {
    const [data, day] = await Promise.all([getProjectPageData(id), getDay()]);
    if (!data) return json({ ok: false, error: "This project was not found. It may have been archived." }, 404);
    const tz = day.timeZone;

    const history: HistoryItemDTO[] = [];
    let cursor: string | null = null;
    while (history.length < MAX_HISTORY_ROWS) {
      const page = await getProjectHistory(id, {}, cursor, PAGE);
      history.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const attachments = await getRepo().attachments.listByProject(id, { includeArchived: true });

    const stepName = new Map<string, string>();
    for (const s of data.archivedSteps) stepName.set(s.id, `${s.name} (archived)`);
    for (const s of data.steps) stepName.set(s.id, s.name);
    const filesByStep = new Map<string, string[]>();
    for (const a of data.attachments) {
      if (!a.stepId) continue;
      filesByStep.set(a.stepId, [...(filesByStep.get(a.stepId) ?? []), a.name]);
    }
    const at = (iso: string | null) => (iso ? formatInstant(iso, tz) : "");

    const input: ProjectExportInput = {
      project: {
        code: data.project.code,
        name: data.project.name,
        status: data.project.statusLabel,
        details: data.details.filter((d) => !d.archived || !d.empty).map((d) => ({ label: d.label, value: d.empty ? "" : d.display })),
        progress: { done: data.progress.done, applicable: data.progress.applicable, pct: data.progress.pct },
        counts: data.progress.counts,
        exportedAt: `${formatInstant(new Date().toISOString(), tz)} (${tz})`,
      },
      steps: data.steps.map((s) => ({
        seq: s.seq,
        name: s.name,
        fieldType: s.fieldTypeLabel,
        value: s.display === "—" ? "" : s.display,
        state: s.state,
        flag: s.flag === "BLOCKED" ? "Blocked" : s.flag === "WAITING" ? "Waiting" : "",
        current: s.isCurrent,
        comesAfter: s.predecessors.map((p) => stepName.get(p) ?? "").filter(Boolean).join(", "),
        lastChanged: at(s.lastChangedAt),
        latestNote: s.latestNote?.body ?? "",
        files: (filesByStep.get(s.id) ?? []).join(", "),
        projectOnly: s.projectOnly,
      })),
      history: history.slice(0, MAX_HISTORY_ROWS).map((h) => ({
        at: at(h.occurredAt),
        step: h.stepIds.length > 1 ? `${h.stepIds.length} milestones` : h.stepId ? (stepName.get(h.stepId) ?? "") : "",
        type: eventLabel(h.type),
        source: SOURCE_LABELS[h.source] ?? h.source,
        actor: h.actor,
        summary: h.summary,
        oldValue: h.oldDisplay ?? "",
        newValue: h.newDisplay ?? "",
      })),
      files: attachments
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((a) => ({
          step: a.stepId ? (stepName.get(a.stepId) ?? "") : "Project",
          kind: a.kind === "LINK" ? "Link" : "File",
          name: a.name,
          url: a.kind === "LINK" ? (a.url ?? "") : "",
          size: a.kind === "FILE" ? size(a.size) : "",
          archived: a.archived,
        })),
    };
    const buffer = await buildProjectXlsx(input);
    const name = exportFileName(data.project.code, data.project.name, day.today);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": contentDisposition(name, "attachment"),
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    const r = toActionError(err);
    const status = !r.ok && r.code === "BUSY" ? 503 : 500;
    return json({ ok: false, error: r.ok ? "Something went wrong." : r.error }, status);
  }
}
