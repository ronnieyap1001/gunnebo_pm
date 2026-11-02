import { Suspense } from "react";
import { requireReadyStorage } from "@/server/guards";
import { getCachedProjectFields, getCachedTemplate, getDay, getProjectsList } from "@/server/queries";
import { ProjectsScreen } from "@/components/projects/projects-screen";
import type { TakenCode } from "@/components/projects/new-project-dialog";
import type { SummaryColumn } from "@/components/projects/projects-table";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  await requireReadyStorage();
  const [all, fields, template, day] = await Promise.all([
    getProjectsList({ includeArchived: true }),
    getCachedProjectFields(),
    getCachedTemplate(),
    getDay(),
  ]);

  // Codes are unique across archived projects too, so the form can say so while typing.
  const takenCodes: Record<string, TakenCode> = {};
  for (const p of all) takenCodes[p.code.toUpperCase()] = { name: p.name, archived: p.archived };

  const active = fields.filter((f) => !f.archived).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const columns: SummaryColumn[] = active
    .filter((f) => f.showInSummary && f.fieldType !== "LONG_TEXT" && f.fieldType !== "FILE")
    .map((f) => ({
      fieldId: f.id,
      label: f.label === "Quantity" ? "Qty" : f.label,
      numeric: f.fieldType === "NUMBER" || f.fieldType === "PERCENT",
      wide: !["DROPDOWN", "MULTIPLE", "NUMBER", "PERCENT", "CHECKBOX", "DATE"].includes(f.fieldType),
      medium: f.systemKey === "projectType",
    }));

  return (
    <Suspense>
      <ProjectsScreen
        rows={all.filter((p) => !p.archived)}
        takenCodes={takenCodes}
        columns={columns}
        formFields={active.filter((f) => f.fieldType !== "FILE")}
        milestoneCount={template.milestones.filter((m) => !m.archived).length}
        today={day.today}
        timeZone={day.timeZone}
        serverNow={new Date().toISOString()}
      />
    </Suspense>
  );
}
