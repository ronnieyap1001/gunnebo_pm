import "server-only";
import { getRepo } from "@/server/repo";
import type { ArchiveProjectItems } from "@/components/admin/archive-types";

/**
 * Names of the steps the archived notes and files of one project belong to (stepId → name), so the Archive can say
 * "FAT date" instead of a generic "Milestone". One extra read of the project's steps; best effort.
 */
export async function stepNamesFor(project: ArchiveProjectItems | null): Promise<Record<string, string>> {
  if (!project) return {};
  const wanted = new Set<string>();
  for (const x of [...project.notes, ...project.attachments]) if (x.stepId) wanted.add(x.stepId);
  if (!wanted.size) return {};
  try {
    const steps = await getRepo().steps.listByProject(project.id, { includeArchived: true });
    const out: Record<string, string> = {};
    for (const s of steps) if (wanted.has(s.id)) out[s.id] = s.name;
    return out;
  } catch {
    return {};
  }
}
