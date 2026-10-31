import { templateFileToJson } from "@/domain/templateFile";
import { toActionError } from "@/server/actions/run";
import { userOrNull } from "@/server/auth/session";
import { getDay } from "@/server/queries";
import { getRepo } from "@/server/repo";
import { exportTemplate } from "@/server/services/templateIo";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Downloads the current template (milestones, choices, arrows, positions, project fields) as a JSON file. */
export async function GET() {
  if (!(await userOrNull())) {
    return Response.json({ error: "Session expired. Sign in again." }, { status: 401, headers: NO_STORE });
  }
  try {
    const [{ today }, file] = await Promise.all([getDay(), exportTemplate(getRepo())]);
    const name = `gunnebo-pm-template-${today}.json`;
    return new Response(templateFileToJson(file), {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (err) {
    const r = toActionError(err);
    const status = !r.ok && r.code === "BUSY" ? 503 : 500;
    return Response.json({ error: r.ok ? "Something went wrong." : r.error }, { status, headers: NO_STORE });
  }
}
