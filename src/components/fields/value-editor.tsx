"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ExternalLink, X } from "lucide-react";
import type {
  CheckboxValue,
  Choice,
  DateRangeValue,
  DateValue,
  DropdownValue,
  FieldDef,
  LinkValue,
  MultipleValue,
  NumberValue,
  PercentValue,
  TextValue,
  Value,
  Ymd,
} from "@/domain/types";
import { addDays, formatYmd, fromYmdLocal, isValidYmd, parseDateInput, toYmdLocal } from "@/domain/dates";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StateDot } from "@/components/state/state-badge";

export interface ValueEditorProps {
  def: FieldDef;
  value: Value | null;
  /** Today in the app's time zone (from the server), for "Today" buttons and typed dates. */
  today: Ymd;
  onCommit: (value: Value | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Smaller layout for table cells / popovers. */
  compact?: boolean;
}

/** The right input for each field type. Every committed change calls onCommit once. */
export function ValueEditor(props: ValueEditorProps) {
  switch (props.def.fieldType) {
    case "DROPDOWN":
      return <DropdownEditor {...props} />;
    case "MULTIPLE":
      return <MultipleEditor {...props} />;
    case "DATE":
      return <DateEditor {...props} />;
    case "DATE_RANGE":
      return <DateRangeEditor {...props} />;
    case "PERCENT":
      return <PercentEditor {...props} />;
    case "NUMBER":
      return <NumberEditor {...props} />;
    case "TEXT":
      return <TextEditor {...props} />;
    case "LONG_TEXT":
      return <LongTextEditor {...props} />;
    case "CHECKBOX":
      return <CheckboxEditor {...props} />;
    case "LINK":
      return <LinkEditor {...props} />;
    case "FILE":
      return <p className="text-xs text-muted-foreground">Add files or links below. One or more marks this milestone done.</p>;
  }
}

// ---------------------------------------------------------------------------

function visibleChoices(choices: Choice[], selected: Set<string>): Choice[] {
  return choices.filter((c) => !c.archived || selected.has(c.id));
}

function DropdownEditor({ def, value, onCommit, disabled, autoFocus, compact }: ValueEditorProps) {
  const current = (value as DropdownValue | null)?.choiceId ?? null;
  const choices = visibleChoices(def.choices, new Set(current ? [current] : []));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      const pick = choices.filter((c) => !c.archived)[n - 1];
      if (pick) {
        e.preventDefault();
        onCommit({ choiceId: pick.id });
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      onCommit(null);
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="radiogroup"
      aria-label={`Choose a value. Keys 1 to ${Math.min(9, choices.length)}`}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {choices.map((c, i) => {
        const active = c.id === current;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || (c.archived && !active)}
            onClick={() => onCommit(active ? null : { choiceId: c.id })}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 text-left text-sm transition-colors",
              compact ? "h-7" : "h-8",
              active ? "border-foreground/40 bg-accent font-medium" : "border-transparent hover:bg-accent/60",
            )}
          >
            <StateDot state={c.state ?? "NOT_STARTED"} />
            <span className="flex-1 truncate">
              {c.label}
              {c.archived ? <span className="ml-1 text-xs text-muted-foreground">(retired)</span> : null}
            </span>
            {!c.archived && i < 9 ? <kbd className="text-[10px] text-muted-foreground">{i + 1}</kbd> : null}
          </button>
        );
      })}
      {current ? (
        <Button variant="ghost" size="sm" className="h-7 justify-start text-muted-foreground" onClick={() => onCommit(null)} disabled={disabled}>
          <X className="size-3.5" /> Clear
        </Button>
      ) : null}
      {!choices.length ? <p className="text-xs text-muted-foreground">No choices yet. Add them in the Milestone Library.</p> : null}
    </div>
  );
}

function MultipleEditor({ def, value, onCommit, disabled }: ValueEditorProps) {
  const committed = useMemo(() => new Set((value as MultipleValue | null)?.choiceIds ?? []), [value]);
  const [local, setLocal] = useState<Set<string>>(committed);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setLocal(committed), [committed]);

  const choices = visibleChoices(def.choices, local);
  const activeChoices = def.choices.filter((c) => !c.archived);

  function schedule(next: Set<string>) {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const ids = def.choices.map((c) => c.id).filter((id) => next.has(id));
      onCommit(ids.length ? { choiceIds: ids } : null);
    }, 400);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {choices.map((c) => {
          const on = local.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => {
                const next = new Set(local);
                if (on) next.delete(c.id);
                else next.add(c.id);
                schedule(next);
              }}
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs transition-colors",
                on ? "border-[var(--state-d-border)] bg-[var(--state-d-bg)] font-medium text-[var(--state-d-fg)]" : "hover:bg-accent",
              )}
            >
              {c.label}
              {c.archived ? " (retired)" : ""}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {local.size} of {activeChoices.length}
        </span>
        <Button variant="ghost" size="sm" className="h-6 px-2" disabled={disabled} onClick={() => schedule(new Set(activeChoices.map((c) => c.id)))}>
          All
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2" disabled={disabled} onClick={() => schedule(new Set())}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** A single date with typed entry (day-first, "today", "+3d", "+2w") and a calendar. */
export function DateField({
  value,
  today,
  onCommit,
  disabled,
  autoFocus,
  label,
  placeholder = "e.g. 12 Nov 2026, today, +2w",
}: {
  value: Ymd | undefined;
  today: Ymd;
  onCommit: (ymd: Ymd | undefined) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value ? formatYmd(value) : "");
  const [open, setOpen] = useState(false);
  useEffect(() => setText(value ? formatYmd(value) : ""), [value]);
  const parsed = text.trim() ? parseDateInput(text, today) : undefined;
  const invalid = Boolean(text.trim()) && !parsed;

  function commitText() {
    if (!text.trim()) {
      if (value) onCommit(undefined);
      return;
    }
    if (parsed && parsed !== value) onCommit(parsed);
    if (parsed) setText(formatYmd(parsed));
  }

  return (
    <div className="space-y-1">
      {label ? <div className="text-xs text-muted-foreground">{label}</div> : null}
      <div className="flex items-center gap-1">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            }
          }}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          autoFocus={autoFocus}
          className="h-8"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label="Open calendar" disabled={disabled}>
              <CalendarDays className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              weekStartsOn={1}
              today={fromYmdLocal(today)}
              selected={value && isValidYmd(value) ? fromYmdLocal(value) : undefined}
              defaultMonth={value && isValidYmd(value) ? fromYmdLocal(value) : fromYmdLocal(today)}
              onSelect={(d) => {
                setOpen(false);
                onCommit(d ? toYmdLocal(d) : undefined);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {parsed && text.trim() && parsed !== value && formatYmd(parsed) !== text.trim() ? (
        <div className="text-xs text-muted-foreground">Will save as {formatYmd(parsed)}</div>
      ) : null}
      {invalid ? <div className="text-xs text-destructive">Not a date. Try 12 Nov 2026, 12/11/2026 or +2w.</div> : null}
    </div>
  );
}

function DateEditor({ value, today, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const current = (value as DateValue | null)?.date;
  const commit = (d: Ymd | undefined) => onCommit(d ? { date: d } : null);
  return (
    <div className="space-y-2">
      <DateField value={current} today={today} onCommit={commit} disabled={disabled} autoFocus={autoFocus} />
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" size="sm" className="h-7" disabled={disabled} onClick={() => commit(today)}>
          Today
        </Button>
        <Button variant="outline" size="sm" className="h-7" disabled={disabled} onClick={() => commit(addDays(current ?? today, 7))}>
          +1 week
        </Button>
        {current ? (
          <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={disabled} onClick={() => commit(undefined)}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DateRangeEditor({ value, today, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const v = (value as DateRangeValue | null) ?? {};
  function commit(next: DateRangeValue) {
    const clean: DateRangeValue = {};
    if (next.start) clean.start = next.start;
    if (next.end) clean.end = next.end;
    onCommit(clean.start || clean.end ? clean : null);
  }
  const reversed = Boolean(v.start && v.end && v.end < v.start);
  return (
    <div className="space-y-2">
      <DateField label="Start" value={v.start} today={today} onCommit={(d) => commit({ ...v, start: d })} disabled={disabled} autoFocus={autoFocus} />
      <DateField label="End" value={v.end} today={today} onCommit={(d) => commit({ ...v, end: d })} disabled={disabled} />
      {reversed ? <p className="text-xs text-destructive">The end date is before the start date.</p> : null}
    </div>
  );
}

function PercentEditor({ value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const committed = (value as PercentValue | null)?.percent ?? 0;
  const [local, setLocal] = useState(committed);
  const [text, setText] = useState(String(committed));
  useEffect(() => {
    setLocal(committed);
    setText(String(committed));
  }, [committed]);
  const commit = (n: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    setLocal(clamped);
    setText(String(clamped));
    if (clamped !== committed || value === null) onCommit(clamped === 0 && value === null ? null : { percent: clamped });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Slider
          value={[local]}
          min={0}
          max={100}
          step={5}
          disabled={disabled}
          onValueChange={([n]) => {
            setLocal(n);
            setText(String(n));
          }}
          onValueCommit={([n]) => commit(n)}
          aria-label="Percent complete"
        />
        <div className="flex items-center gap-1">
          <Input
            value={text}
            inputMode="numeric"
            onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={() => commit(Number(text || 0))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(Number(text || 0));
            }}
            className="h-8 w-16 text-right tabular-nums"
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label="Percent"
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </div>
      <div className="flex gap-1">
        {[0, 25, 50, 75, 100].map((n) => (
          <Button key={n} variant={local === n ? "secondary" : "outline"} size="sm" className="h-7 flex-1" disabled={disabled} onClick={() => commit(n)}>
            {n}
          </Button>
        ))}
      </div>
    </div>
  );
}

function NumberEditor({ def, value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const committed = (value as NumberValue | null)?.number;
  const [text, setText] = useState(committed === undefined ? "" : String(committed));
  useEffect(() => setText(committed === undefined ? "" : String(committed)), [committed]);
  const commit = () => {
    const t = text.trim().replace(/,/g, "");
    if (!t) {
      if (committed !== undefined) onCommit(null);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && n !== committed) onCommit({ number: n });
  };
  const invalid = Boolean(text.trim()) && !Number.isFinite(Number(text.trim().replace(/,/g, "")));
  return (
    <div className="flex items-center gap-2">
      <Input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-invalid={invalid || undefined}
        className="h-8 tabular-nums"
        disabled={disabled}
        autoFocus={autoFocus}
      />
      {def.config.unit ? <span className="text-sm text-muted-foreground">{def.config.unit}</span> : null}
    </div>
  );
}

function TextEditor({ value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const committed = (value as TextValue | null)?.text ?? "";
  const [text, setText] = useState(committed);
  useEffect(() => setText(committed), [committed]);
  const commit = () => {
    const t = text.trim();
    if (t !== committed.trim()) onCommit(t ? { text: t } : null);
  };
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setText(committed);
      }}
      className="h-8"
      disabled={disabled}
      autoFocus={autoFocus}
    />
  );
}

function LongTextEditor({ value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const committed = (value as TextValue | null)?.text ?? "";
  const [text, setText] = useState(committed);
  useEffect(() => setText(committed), [committed]);
  const commit = () => {
    if (text.trim() !== committed.trim()) onCommit(text.trim() ? { text: text.trim() } : null);
  };
  return (
    <div className="space-y-1">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
        rows={5}
        className="field-sizing-content min-h-24 text-sm"
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <p className="text-[11px] text-muted-foreground">Saves when you click away, or with Ctrl+Enter.</p>
    </div>
  );
}

function CheckboxEditor({ value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const on = Boolean((value as CheckboxValue | null)?.checked);
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={on} onCheckedChange={(c) => onCommit(c ? { checked: true } : null)} disabled={disabled} autoFocus={autoFocus} />
      {on ? "Yes" : "No"}
    </label>
  );
}

function LinkEditor({ value, onCommit, disabled, autoFocus }: ValueEditorProps) {
  const v = value as LinkValue | null;
  const [url, setUrl] = useState(v?.url ?? "");
  const [label, setLabel] = useState(v?.label ?? "");
  useEffect(() => {
    setUrl(v?.url ?? "");
    setLabel(v?.label ?? "");
  }, [v?.url, v?.label]);
  const valid = /^https?:\/\/\S+$/i.test(url.trim());
  const commit = () => {
    const u = url.trim();
    if (!u) {
      if (v) onCommit(null);
      return;
    }
    if (!valid) return;
    const l = label.trim();
    if (u !== v?.url || (l || undefined) !== v?.label) onCommit(l ? { url: u, label: l } : { url: u });
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder="https://…"
          aria-invalid={(Boolean(url.trim()) && !valid) || undefined}
          className="h-8"
          disabled={disabled}
          autoFocus={autoFocus}
        />
        {v?.url ? (
          <Button asChild variant="outline" size="icon" className="size-8 shrink-0">
            <a href={v.url} target="_blank" rel="noopener noreferrer" aria-label="Open link">
              <ExternalLink className="size-4" />
            </a>
          </Button>
        ) : null}
      </div>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        placeholder="Label (optional)"
        className="h-8"
        disabled={disabled}
      />
      {url.trim() && !valid ? <p className="text-xs text-destructive">Links must start with http:// or https://</p> : null}
    </div>
  );
}
