import { toActionError } from "@/server/actions/run";
import { userOrNull } from "@/server/auth/session";
import { attachmentDTO } from "@/server/queries/common";
import { getActionCtx } from "@/server/queries";
import { addFile, MAX_FILE_BYTES } from "@/server/services";
import { isSameOrigin, json } from "./http";

export const dynamic = "force-dynamic";

/** Multipart overhead allowed on top of the file itself (boundaries and the small text fields). */
const FORM_OVERHEAD = 64 * 1024;
const OP_ID = /^[A-Za-z0-9-]{8,64}$/;
const ID = /^[A-Za-z0-9-]{1,200}$/;
/** Types Notion refuses; answered before uploading anything. */
const UNSUPPORTED = new Set([".msg", ".eml", ".exe", ".bat", ".cmd", ".com", ".scr"]);

function fail(error: string, status: number, code?: string): Response {
  return json({ ok: false, error, code }, status);
}

/**
 * Upload one file (≤ 4 MB) to a project or a step: multipart `file`, `projectId`, `stepId?`, `opId`.
 * Answers `{ ok: true, attachment, project }` or `{ ok: false, error }` with a plain-English message.
 */
export async function POST(req: Request) {
  if (!(await userOrNull())) return fail("Session expired. Sign in again", 401, "SESSION");
  if (!isSameOrigin(req)) return fail("This upload did not come from the app.", 403, "FORBIDDEN");

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_FILE_BYTES + FORM_OVERHEAD) {
    return fail("Files can be at most 4 MB. For bigger files, add a SharePoint or OneDrive link.", 413, "TOO_LARGE");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("The upload was cut off. Try again.", 400, "VALIDATION");
  }
  const file = form.get("file");
  const projectId = String(form.get("projectId") ?? "");
  const stepRaw = form.get("stepId");
  const stepId = typeof stepRaw === "string" && stepRaw ? stepRaw : undefined;
  const opId = String(form.get("opId") ?? "");

  if (!OP_ID.test(opId)) return fail("This upload is missing its id. Reload the page and try again.", 400, "VALIDATION");
  if (!ID.test(projectId) || (stepId && !ID.test(stepId))) return fail("This project was not found. Reload the page.", 400, "VALIDATION");
  if (!(file instanceof File)) return fail("Choose a file to upload.", 400, "VALIDATION");
  if (file.size <= 0) return fail("The file is empty.", 400, "VALIDATION");
  if (file.size > MAX_FILE_BYTES) {
    return fail("Files can be at most 4 MB. For bigger files, add a SharePoint or OneDrive link.", 413, "TOO_LARGE");
  }
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (UNSUPPORTED.has(ext)) {
    return fail(
      `Notion does not accept ${ext} files. Put it in a .zip file, or save it in SharePoint or OneDrive and paste the link instead.`,
      415,
      "UNSUPPORTED_TYPE",
    );
  }

  try {
    const ctx = await getActionCtx({ opId });
    const r = await addFile(ctx, {
      projectId,
      stepId,
      name: file.name || "file",
      contentType: file.type || "application/octet-stream",
      size: file.size,
      data: file,
    });
    return json({ ok: true, attachment: attachmentDTO(r.attachment), project: r.project });
  } catch (err) {
    const r = toActionError(err);
    if (r.ok) return fail("Something went wrong. Try again.", 500);
    const status =
      r.code === "BUSY" ? 503 : r.code === "NOT_FOUND" ? 404 : r.code === "TOO_LARGE" ? 413 : r.code === "UNKNOWN" ? 500 : 400;
    return fail(r.error, status, r.code);
  }
}
