"use server";

import { redirect } from "next/navigation";
import { authConfig, checkPassword, safeNextPath } from "@/server/auth/token";
import { startSession, endSession } from "@/server/auth/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const cfg = authConfig();
  if (!cfg.ok) redirect("/not-configured");

  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? ""));

  if (!checkPassword(password)) {
    // Slows down casual guessing. Real protection: a long password plus Vercel Authentication (see README).
    await new Promise((r) => setTimeout(r, 800));
    return { error: "That password is not right." };
  }
  await startSession();
  redirect(next);
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
