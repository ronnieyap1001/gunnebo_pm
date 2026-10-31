import {
  AlignLeft,
  Calendar,
  CalendarRange,
  Hash,
  Link,
  ListChecks,
  Paperclip,
  Percent,
  SquareCheck,
  SquareChevronDown,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { FieldType } from "@/domain/types";
import { cn } from "@/lib/utils";

export const FIELD_TYPE_ICONS: Record<FieldType, LucideIcon> = {
  TEXT: Type,
  LONG_TEXT: AlignLeft,
  NUMBER: Hash,
  PERCENT: Percent,
  DATE: Calendar,
  DATE_RANGE: CalendarRange,
  DROPDOWN: SquareChevronDown,
  MULTIPLE: ListChecks,
  CHECKBOX: SquareCheck,
  LINK: Link,
  FILE: Paperclip,
};

export function FieldTypeIcon({ type, className }: { type: FieldType; className?: string }) {
  const Icon = FIELD_TYPE_ICONS[type] ?? Type;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}
