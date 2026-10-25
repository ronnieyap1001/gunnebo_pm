import { NextResponse, type NextRequest } from "next/server";
import {
  authConfig,
  SESSION_REFRESH_S,
  sessionCookieName,
  sessionCookieOptions,
  signSession,
  verifySession,
} from "@/server/auth/token";

/**
 * Every page and API route requires a valid session, except the ones excluded by the matcher below.
 * Server Actions and route handlers also call requireUser() themselves (defence in depth).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isAction = request.headers.has("next-action");
  const isApi = pathname.startsWith("/api/");

  const cfg = authConfig();
  if (!cfg.ok) {
    if (isAction || isApi) {
      return NextResponse.json({ error: "not_configured" }, { status: 503 });
    }
    return NextResponse.redirect(new URL("/not-configured", request.url));
  }

  const nowS = Math.floor(Date.now() / 1000);
  const cookieName = sessionCookieName();
  const session = verifySession(cfg.key, request.cookies.get(cookieName)?.value, nowS);

  if (!session) {
    if (isAction || isApi) {
      return NextResponse.json({ error: "session" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  if (nowS - session.seen > SESSION_REFRESH_S) {
    response.cookies.set(cookieName, signSession(cfg.key, { ...session, seen: nowS }), sessionCookieOptions());
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|login|not-configured|api/health|api/cron).*)",
  ],
};
