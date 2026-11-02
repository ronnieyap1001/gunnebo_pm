"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig, checkPassword, safeNextPath } from "@/server/auth/token";
import { startSession, endSession } from "@/server/auth/session";
import { clientKey, loginThrottle } from "@/server/auth/throttle";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const cfg = authConfig();
  if (!cfg.ok) redirect("/not-configured");

  const key = clientKey(await headers());
  const waitMs = loginThrottle.retryAfterMs(key);
  if (waitMs > 0) {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return { error: `Too many wrong passwords. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.` };
  }

  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""));

  if (!checkPassword(password)) {
    loginThrottle.recordFailure(key);
    // Slows down casual guessing. Real protection: a long password plus Vercel Authentication (see README).
    await new Promise((r) => setTimeout(r, 800));
    return { error: "That password is not right." };
  }
  loginThrottle.recordSuccess(key);
  await startSession();
  redirect(next);
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
