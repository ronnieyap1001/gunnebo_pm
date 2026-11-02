"use client";

import Link from "next/link";
import { DatabaseBackup } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface BackupStatus {
  /** Last full backup download, or null when there never was one. */
  lastAt: string | null;
  /** Whole days since the last backup (null = never). */
  days: number | null;
}

/** Days without a backup after which the sidebar reminds the user. */
export const BACKUP_REMINDER_DAYS = 7;

export function needsBackupReminder(b: BackupStatus | null): boolean {
  if (!b) return false;
  return b.days === null || b.days > BACKUP_REMINDER_DAYS;
}

/** Sidebar footer note: shown when Settings record no backup in the last 7 days. Links to Settings → Backup. */
export function BackupReminder({ status, collapsed }: { status: BackupStatus | null; collapsed: boolean }) {
  if (!needsBackupReminder(status)) return null;
  const text = status!.days === null ? "No backup yet" : `Last backup ${status!.days} days ago`;
  const link = (
    <Link
      href="/settings#backup"
      className={cn(
        "state-w flex items-start gap-2 rounded-md border border-[var(--s-border)] bg-[var(--s-bg)] px-2 py-1.5 text-xs text-[var(--s-fg)] transition-colors hover:brightness-[0.97] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none dark:hover:brightness-110",
        collapsed && "justify-center px-0",
      )}
    >
      <DatabaseBackup className="mt-px size-4 shrink-0" aria-hidden />
      {collapsed ? (
        <span className="sr-only">{text}. Download a backup in Settings.</span>
      ) : (
        <span className="min-w-0">
          <span className="block font-medium">{text}</span>
          <span className="block opacity-90">Download a backup</span>
        </span>
      )}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{text}. Download a backup in Settings.</TooltipContent>
    </Tooltip>
  );
}
