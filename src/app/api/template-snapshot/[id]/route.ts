import { userOrNull } from "@/server/auth/session";
import { getDay, getTemplateSnapshots } from "@/server/queries";
import { ymdFromInstant } from "@/domain/dates";

export const dynamic = "force-dynamic";

const MAX_PAGES = 50;

/** Downloads one template snapshot (saved before an import or reset) as a template JSON file for Import. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await userOrNull())) return Response.json({ error: "session" }, { status: 401 });
  const { id } = await params;
  if (!id || id.length > 100) return Response.json({ error: "Not found" }, { status: 404 });

  try {
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await getTemplateSnapshots(cursor);
      const hit = page.items.find((s) => s.id === id);
      if (hit) {
        if (!hit.file) return Response.json({ error: "This snapshot has no template file." }, { status: 404 });
        const { timeZone } = await getDay();
        let day: string;
        try {
          day = ymdFromInstant(hit.occurredAt, timeZone);
        } catch {
          day = "snapshot";
        }
        const reason = String(hit.reason ?? "import").replace(/[^a-z0-9-]/gi, "") || "import";
        const name = `gunnebo-pm-template-before-${reason}-${day}.json`;
        return new Response(JSON.stringify(hit.file, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return Response.json({ error: "This snapshot was not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "Notion is busy right now. Wait a moment and try again." }, { status: 503 });
  }
}
