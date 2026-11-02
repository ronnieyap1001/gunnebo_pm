import { toActionError } from "@/server/actions/run";
import { userOrNull } from "@/server/auth/session";
import { fakeNotionFile, storageMode } from "@/server/notion/client";
import { createFakeNotion, fakeFileBytes, isFakeFileUrl, type FakeFile } from "@/server/notion/fake";
import { getRepo } from "@/server/repo";
import { openAttachment } from "@/server/services";
import { contentDisposition, DOWNLOAD_HEADERS } from "../http";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9-]{1,200}$/;

/** Shown inline (when not asked to download) only after checking the first bytes: never svg, html or xml. */
type InlineType = "application/pdf" | "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function sniff(head: Uint8Array): InlineType | null {
  const b = (i: number) => head[i] ?? -1;
  const ascii = (from: number, len: number) => String.fromCharCode(...Array.from(head.slice(from, from + len)));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (b(0) === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

/** Stored types that must never be rendered by the browser, even as a download. */
const ACTIVE = /html|svg|xml|javascript|ecmascript/i;

let fakeReader = false;

/**
 * Bytes behind a local fake-Notion URL. The fake that stored them may live in another module layer (pages and
 * actions vs route handlers in dev), whose registry this module can't see; then a read-only fake on the same file
 * (same signing key) is opened once here, which registers itself and can verify the signed URL.
 */
function fakeBytes(url: string): FakeFile | null {
  const hit = fakeFileBytes(url);
  if (hit || fakeReader || storageMode() !== "fake") return hit;
  fakeReader = true;
  const file = fakeNotionFile();
  if (!file) return null;
  createFakeNotion({ file });
  return fakeFileBytes(url);
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { ...DOWNLOAD_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function headersFor(name: string, stored: string | undefined, sniffed: InlineType | null, download: boolean, size?: number): Headers {
  const inline = !download && sniffed !== null;
  const type = sniffed ?? (stored && !ACTIVE.test(stored) ? stored : "application/octet-stream");
  const h = new Headers({
    ...DOWNLOAD_HEADERS,
    "Content-Type": type,
    "Content-Disposition": contentDisposition(name, inline ? "inline" : "attachment"),
  });
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) h.set("Content-Length", String(size));
  return h;
}

/**
 * Opens (or with ?download=1 downloads) a stored file. A link someone added in Notion redirects; files never get
 * cached and are served with nosniff and a sandbox CSP. `/api/files/session` answers 204 (a session probe: the
 * proxy answers 401 for every /api route once the session has expired).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await userOrNull())) return text("Your session expired. Sign in again, then open the file.", 401);
  const { id } = await params;
  if (id === "session") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (!ID.test(id)) return text("This file was not found.", 404);
  const download = new URL(req.url).searchParams.get("download") === "1";

  let file: Awaited<ReturnType<typeof openAttachment>>;
  try {
    file = await openAttachment(getRepo(), id);
  } catch (err) {
    const r = toActionError(err);
    const msg = r.ok ? "Something went wrong." : r.error;
    const status = !r.ok && r.code === "NOT_FOUND" ? 404 : !r.ok && r.code === "BUSY" ? 503 : 502;
    return text(msg, status);
  }

  if (file.external) {
    return new Response(null, { status: 302, headers: { Location: file.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }

  if (isFakeFileUrl(file.url)) {
    const f = fakeBytes(file.url);
    if (!f) return text("This file is no longer available. Upload it again.", 404);
    const bytes = new Uint8Array(f.data);
    return new Response(bytes, { headers: headersFor(file.name, file.contentType ?? f.contentType ?? undefined, sniff(bytes.slice(0, 16)), download, bytes.byteLength) });
  }

  let upstream: Response;
  try {
    upstream = await fetch(file.url, { cache: "no-store", redirect: "follow" });
  } catch {
    return text("Notion did not answer. Try again in a moment.", 502);
  }
  if (!upstream.ok || !upstream.body) return text("Notion could not send this file. Try again in a moment.", 502);

  // Read the first chunk to decide inline vs download, then stream the rest unchanged.
  const reader = upstream.body.getReader();
  let first: Uint8Array = new Uint8Array(0);
  try {
    const r = await reader.read();
    if (!r.done && r.value) first = r.value;
  } catch {
    return text("The download was interrupted. Try again.", 502);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.byteLength) controller.enqueue(first);
    },
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  const len = Number(upstream.headers.get("content-length"));
  return new Response(body, {
    headers: headersFor(file.name, file.contentType ?? upstream.headers.get("content-type") ?? undefined, sniff(first.slice(0, 16)), download, Number.isFinite(len) && len > 0 ? len : file.size),
  });
}
