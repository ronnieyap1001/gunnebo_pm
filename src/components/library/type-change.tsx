"use client";

/**
 * "What happens if I change the field type?" Plain-English effect of a type change, shown before it is applied
 * (inline in the DefinitionEditor and in the dialog behind the table's type select).
 */
import type { FieldType } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldTypeIcon } from "./field-type-icon";

/** How the colour (state) of a step is worked out for each type. */
export const STATE_RULE: Record<FieldType, string> = {
  TEXT: "Empty = Not started, filled in = Done.",
  LONG_TEXT: "Empty = Not started, filled in = Done.",
  NUMBER: "Empty = Not started, any number = Done.",
  PERCENT: "0 or empty = Not started, 1–99 = In progress, 100 = Done.",
  DATE: "Empty = Not started, a future date = In progress (planned), today or earlier = Done.",
  DATE_RANGE: "Empty = Not started, until the end date = In progress, after it = Done.",
  DROPDOWN: "Each choice has its own colour (state), set below.",
  MULTIPLE: "Nothing ticked = Not started, anything ticked = Done.",
  CHECKBOX: "Unticked = Not started, ticked = Done.",
  LINK: "Empty = Not started, a link = Done.",
  FILE: "Done once a file or link is attached.",
};

type Conversion = "always" | "sometimes" | "never";

/** Mirrors domain convertValue: which existing values survive a type change. */
function conversion(from: FieldType, to: FieldType): { kind: Conversion; when?: string } {
  if (from === "FILE") return { kind: "always" };
  switch (`${from}->${to}`) {
    case "TEXT->LONG_TEXT":
    case "LONG_TEXT->TEXT":
    case "DROPDOWN->MULTIPLE":
    case "PERCENT->NUMBER":
    case "DATE->DATE_RANGE":
      return { kind: "always" };
    case "MULTIPLE->DROPDOWN":
      return { kind: "sometimes", when: "when at most one choice is ticked" };
    case "NUMBER->PERCENT":
      return { kind: "sometimes", when: "when the number is a whole number from 0 to 100" };
    case "TEXT->LINK":
    case "LONG_TEXT->LINK":
      return { kind: "sometimes", when: "when the text is a web address (http:// or https://)" };
    default:
      return { kind: "never" };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface TypeChangeEffectProps {
  from: FieldType;
  to: FieldType;
  /** milestone: projects change at Sync; field: values convert now. */
  kind: "milestone" | "field";
  /** Milestone: projects using it. Field: projects with a value. */
  usedIn: number;
  /** Stored choices (active ones). */
  choiceCount: number;
}

export function typeChangeLines({ from, to, kind, usedIn, choiceCount }: TypeChangeEffectProps): string[] {
  const lines: string[] = [];
  const fromMeta = FIELD_TYPE_META[from];
  const toMeta = FIELD_TYPE_META[to];
  const conv = conversion(from, to);

  if (kind === "milestone") {
    lines.push(
      usedIn > 0
        ? `Used in ${plural(usedIn, "project")}. They keep the current type until you Sync them.`
        : "Not used in any project yet, so only new projects get the new type.",
    );
    if (usedIn > 0) {
      if (conv.kind === "always") lines.push("Values already entered convert automatically when a project is synced.");
      else if (conv.kind === "sometimes")
        lines.push(`Values already entered convert at Sync ${conv.when}; other steps keep the old type until their value is cleared.`);
      else lines.push("Steps that already have a value keep the old type until it is cleared. No value is ever lost.");
    }
  } else {
    if (usedIn === 0) lines.push("No project has a value in this field yet.");
    else if (conv.kind === "always") lines.push(`The values in ${plural(usedIn, "project")} are converted now, without losing anything.`);
    else if (conv.kind === "sometimes")
      lines.push(
        `The values in ${plural(usedIn, "project")} are converted now ${conv.when}. If any value doesn't fit, nothing changes and the projects that block it are listed.`,
      );
    else
      lines.push(
        `${plural(usedIn, "project")} ${usedIn === 1 ? "has" : "have"} a value that can't become ${toMeta.label}. The change will be refused until ${usedIn === 1 ? "that value is" : "those values are"} cleared.`,
      );
  }

  if (fromMeta.hasChoices && !toMeta.hasChoices && choiceCount > 0) {
    lines.push(`The ${plural(choiceCount, "choice")} are kept, so switching back restores them.`);
  } else if (!fromMeta.hasChoices && toMeta.hasChoices) {
    lines.push(choiceCount > 0 ? `The ${plural(choiceCount, "choice")} saved earlier come back.` : "Add the choices after the change.");
  } else if (from === "MULTIPLE" && to === "DROPDOWN" && kind === "milestone") {
    lines.push("Choices without a colour start as Not started. Set a state for each one.");
  } else if (from === "DROPDOWN" && to === "MULTIPLE" && kind === "milestone") {
    lines.push("The choices keep their labels; their colours aren't used by Multiple.");
  }

  if (kind === "milestone") lines.push(`Colour: ${STATE_RULE[to]}`);
  return lines;
}

export function TypeChangeEffect(props: TypeChangeEffectProps) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
      {typeChangeLines(props).map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/** Confirmation behind the table's inline type select. */
export function TypeChangeDialog({
  open,
  onOpenChange,
  name,
  effect,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  effect: TypeChangeEffectProps | null;
  onConfirm: () => void;
}) {
  const to = effect?.to;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {to ? <FieldTypeIcon type={to} className="size-4 text-muted-foreground" /> : null}
            Change “{name}” to {to ? FIELD_TYPE_META[to].label : ""}?
          </DialogTitle>
          <DialogDescription>
            {effect ? `${FIELD_TYPE_META[effect.from].label} → ${FIELD_TYPE_META[effect.to].label}` : null}
          </DialogDescription>
        </DialogHeader>
        {effect ? <TypeChangeEffect {...effect} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            autoFocus
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            Change type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
