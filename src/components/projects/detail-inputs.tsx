"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import type {
  Choice,
  DateRangeValue,
  DateValue,
  DropdownValue,
  LinkValue,
  MultipleValue,
  NumberValue,
  PercentValue,
  ProjectField,
  TextValue,
  Value,
  Ymd,
} from "@/domain/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { DateField } from "@/components/fields/value-editor";

/** Text the user typed for a Number / Percent / Link field, kept until it parses. */
export type DraftText = Record<string, string>;

export interface DetailInputProps {
  field: ProjectField;
  /** Choices to show (props merged with choices added from this form). */
  choices: Choice[];
  value: Value | null;
  onChange: (value: Value | null) => void;
  /** Raw text of Number / Percent / Link inputs. */
  text: string | undefined;
  onText: (text: string) => void;
  error?: string;
  today: Ymd;
  /** "Add 'X'" for Dropdown / Multiple fields; resolves to the new choice id (or null when it failed). */
  onAddChoice?: (label: string) => Promise<string | null>;
  inputId: string;
  disabled?: boolean;
}

export const URL_PATTERN = /^https?:\/\/\S+$/i;

/** Parses the typed text of a Number field ("1,200" → 1200). Undefined when empty, NaN when not a number. */
export function parseNumberText(t: string): number | undefined {
  const s = t.trim().replace(/,/g, "");
  if (!s) return undefined;
  return Number(s);
}

/** The right input for each project field type (FILE is not offered for project fields). */
export function DetailInput(props: DetailInputProps) {
  switch (props.field.fieldType) {
    case "DROPDOWN":
      return <ChoiceSelect {...props} />;
    case "MULTIPLE":
      return <ChoiceChips {...props} />;
    case "TEXT":
      return (
        <Input
          id={props.inputId}
          value={(props.value as TextValue | null)?.text ?? ""}
          onChange={(e) => props.onChange(e.target.value ? { text: e.target.value } : null)}
          disabled={props.disabled}
          aria-invalid={props.error ? true : undefined}
          className="h-8"
        />
      );
    case "LONG_TEXT":
      return (
        <Textarea
          id={props.inputId}
          value={(props.value as TextValue | null)?.text ?? ""}
          onChange={(e) => props.onChange(e.target.value ? { text: e.target.value } : null)}
          disabled={props.disabled}
          rows={3}
          className="field-sizing-content min-h-16 text-sm"
        />
      );
    case "NUMBER":
    case "PERCENT":
      return <NumberInput {...props} />;
    case "DATE":
      return (
        <DateField
          value={(props.value as DateValue | null)?.date}
          today={props.today}
          onCommit={(d) => props.onChange(d ? { date: d } : null)}
          disabled={props.disabled}
        />
      );
    case "DATE_RANGE": {
      const v = (props.value as DateRangeValue | null) ?? {};
      const set = (next: DateRangeValue) => {
        const clean: DateRangeValue = {};
        if (next.start) clean.start = next.start;
        if (next.end) clean.end = next.end;
        props.onChange(clean.start || clean.end ? clean : null);
      };
      return (
        <div className="grid grid-cols-2 gap-2">
          <DateField
            label="Start"
            value={v.start}
            today={props.today}
            onCommit={(d) => set({ ...v, start: d })}
            disabled={props.disabled}
          />
          <DateField label="End" value={v.end} today={props.today} onCommit={(d) => set({ ...v, end: d })} disabled={props.disabled} />
        </div>
      );
    }
    case "CHECKBOX":
      return (
        <label className="flex h-8 items-center gap-2 text-sm">
          <Checkbox
            id={props.inputId}
            checked={Boolean(props.value)}
            onCheckedChange={(c) => props.onChange(c === true ? { checked: true } : null)}
            disabled={props.disabled}
          />
          Yes
        </label>
      );
    case "LINK":
      return (
        <Input
          id={props.inputId}
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={props.text ?? (props.value as LinkValue | null)?.url ?? ""}
          onChange={(e) => {
            props.onText(e.target.value);
            const u = e.target.value.trim();
            props.onChange(u && URL_PATTERN.test(u) ? { url: u } : null);
          }}
          disabled={props.disabled}
          aria-invalid={props.error ? true : undefined}
          className="h-8"
        />
      );
    case "FILE":
      return <p className="text-xs text-muted-foreground">Files are added on the project page.</p>;
  }
}

function NumberInput({ field, value, onChange, text, onText, error, inputId, disabled }: DetailInputProps) {
  const percent = field.fieldType === "PERCENT";
  const committed = percent ? (value as PercentValue | null)?.percent : (value as NumberValue | null)?.number;
  const shown = text ?? (committed === undefined ? "" : String(committed));
  const unit = percent ? "%" : field.config?.unit;
  return (
    <div className="flex items-center gap-2">
      <Input
        id={inputId}
        value={shown}
        inputMode="decimal"
        onChange={(e) => {
          onText(e.target.value);
          const n = parseNumberText(e.target.value);
          if (n === undefined) onChange(null);
          else if (Number.isFinite(n)) {
            if (percent) onChange({ percent: Math.max(0, Math.min(100, Math.round(n))) });
            else onChange({ number: n });
          }
        }}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className="h-8 w-32 text-right tabular-nums"
      />
      {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
    </div>
  );
}

/** Plain "contains" matching, so the list shows exactly the choices Enter can pick (cmdk's default is fuzzy). */
function containsFilter(value: string, search: string): number {
  const q = search.trim().toLowerCase();
  return !q || value.toLowerCase().includes(q) ? 1 : 0;
}

const choiceValue = (c: Choice) => `${c.label} ${c.id}`;

/** Dropdown: searchable list with an inline "Add 'X'" when nothing matches exactly. */
function ChoiceSelect({ field, choices, value, onChange, onAddChoice, inputId, disabled, error }: DetailInputProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const selectedId = (value as DropdownValue | null)?.choiceId ?? null;
  const selected = choices.find((c) => c.id === selectedId);
  const active = choices.filter((c) => !c.archived);
  const q = query.trim();
  const exact = active.some((c) => c.label.toLowerCase() === q.toLowerCase());
  const canAdd = Boolean(onAddChoice) && q.length > 0 && !exact;

  async function add() {
    if (!onAddChoice || !q) return;
    setAdding(true);
    const id = await onAddChoice(q);
    setAdding(false);
    if (id) {
      onChange({ choiceId: id });
      setQuery("");
      setOpen(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={inputId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          className="h-8 w-full justify-between px-2.5 font-normal"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.label : onAddChoice ? "Choose or add…" : "Choose…"}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-56 p-0" align="start">
        <Command filter={containsFilter}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={onAddChoice ? `Search or add a ${field.label.toLowerCase()}…` : "Search…"}
            aria-label={`Search ${field.label}`}
            onKeyDown={(e) => {
              // Enter with no highlighted match adds the typed value.
              if (e.key === "Enter" && canAdd && !active.some((c) => containsFilter(choiceValue(c), q))) {
                e.preventDefault();
                void add();
              }
            }}
          />
          <CommandList>
            {!canAdd ? <CommandEmpty>No match.</CommandEmpty> : null}
            <CommandGroup>
              {active.map((c) => (
                <CommandItem
                  key={c.id}
                  value={choiceValue(c)}
                  data-checked={c.id === selectedId}
                  onSelect={() => {
                    onChange(c.id === selectedId ? null : { choiceId: c.id });
                    setOpen(false);
                  }}
                >
                  {c.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup forceMount className={cn(!canAdd && !selectedId && "hidden")}>
              {canAdd ? (
                <CommandItem forceMount value={`__add__ ${q}`} onSelect={() => void add()} disabled={adding}>
                  {adding ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
                  Add &ldquo;{q}&rdquo;
                </CommandItem>
              ) : null}
              {selectedId ? (
                <CommandItem
                  forceMount
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-muted-foreground"
                >
                  <X aria-hidden />
                  Clear
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Multiple: toggle chips, plus an inline "Add" box when the field allows new choices. */
function ChoiceChips({ choices, value, onChange, onAddChoice, disabled, field }: DetailInputProps) {
  const selected = new Set((value as MultipleValue | null)?.choiceIds ?? []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const active = choices.filter((c) => !c.archived);

  function set(next: Set<string>) {
    const ids = choices.map((c) => c.id).filter((id) => next.has(id));
    onChange(ids.length ? { choiceIds: ids } : null);
  }

  async function add() {
    const label = (draft ?? "").trim();
    if (!onAddChoice || !label) return;
    const existing = active.find((c) => c.label.toLowerCase() === label.toLowerCase());
    if (existing) {
      set(new Set([...selected, existing.id]));
      setDraft(null);
      return;
    }
    setAdding(true);
    const id = await onAddChoice(label);
    setAdding(false);
    if (id) {
      const ids = [...selected, id];
      onChange({ choiceIds: ids });
      setDraft(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={field.label}>
      {active.map((c) => {
        const on = selected.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => {
              const next = new Set(selected);
              if (on) next.delete(c.id);
              else next.add(c.id);
              set(next);
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              on ? "state-d border-[var(--s-border)] bg-[var(--s-bg)] font-medium text-[var(--s-fg)]" : "hover:bg-accent",
            )}
          >
            {on ? <Check className="size-3" aria-hidden /> : null}
            {c.label}
          </button>
        );
      })}
      {onAddChoice ? (
        draft === null ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setDraft("")} disabled={disabled}>
            <Plus aria-hidden /> Add
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft(null);
                }
              }}
              placeholder="New choice"
              aria-label={`New ${field.label} choice`}
              className="h-7 w-36 text-xs"
              disabled={adding}
            />
            <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={() => void add()} disabled={adding || !draft.trim()}>
              {adding ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add
            </Button>
          </span>
        )
      ) : null}
    </div>
  );
}
