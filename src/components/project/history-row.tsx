"use client";

import { ArrowRight, Bot, Hand, Mail } from "lucide-react";
import type { EventSource } from "@/domain/types";
import type { HistoryItemDTO } from "@/server/queries";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { eventLabel, SOURCE_LABELS } from "./event-types";
import { shortInstant, stripCode } from "./format";

const SOURCE_ICON: Record<EventSource, typeof Hand> = { MANUAL: Hand, EMAIL: Mail, SYSTEM: Bot };

export function SourceIcon({ source, className }: { source: EventSource; className?: string }) {
  const Icon = SOURCE_ICON[source] ?? Hand;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex text-muted-foreground", className)}>
          <Icon className="size-3" aria-hidden />
          <span className="sr-only">{SOURCE_LABELS[source] ?? source}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{SOURCE_LABELS[source] ?? source}</TooltipContent>
    </Tooltip>
  );
}

export function actorLabel(actor: string, displayName: string): string {
  return actor === displayName ? "You" : actor || "Unknown";
}

/** "old → new" with the old value struck through; null when the row has neither. */
export function OldNew({ oldDisplay, newDisplay, className }: { oldDisplay: string | null; newDisplay: string | null; className?: string }) {
  if (!oldDisplay && !newDisplay) return null;
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1", className)}>
      {oldDisplay ? <span className="text-muted-foreground line-through decoration-muted-foreground/50">{oldDisplay}</span> : null}
      {oldDisplay && newDisplay ? <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-label="changed to" /> : null}
      {newDisplay ? <span className="font-medium">{newDisplay}</span> : null}
    </span>
  );
}

/**
 * One compact History line for the side panel: "24 Oct 14:05 · You · Awaiting → LOI received".
 * Rows without old/new values show their summary instead.
 */
export function StepHistoryLine({
  item,
  timeZone,
  displayName,
  code,
  now,
}: {
  item: HistoryItemDTO;
  timeZone: string;
  displayName: string;
  code: string;
  now: string | null;
}) {
  const hasValues = Boolean(item.oldDisplay || item.newDisplay) && item.type === "step.value_changed";
  const summary = stripCode(item.summary, code);
  return (
    <li className="flex items-start gap-1.5 py-1 text-xs">
      <SourceIcon source={item.source} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground">
          <time dateTime={item.occurredAt}>{shortInstant(item.occurredAt, timeZone, now)}</time> · {actorLabel(item.actor, displayName)}
          {hasValues ? null : <> · {eventLabel(item.type)}</>}
        </div>
        {hasValues ? (
          <OldNew oldDisplay={item.oldDisplay} newDisplay={item.newDisplay} />
        ) : (
          <div className="break-words text-foreground/90" title={summary}>
            {summary}
          </div>
        )}
      </div>
    </li>
  );
}
