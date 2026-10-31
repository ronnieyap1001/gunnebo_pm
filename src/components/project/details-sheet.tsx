"use client";

import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, X } from "lucide-react";
import { PROJECT_STATUSES, type Choice, type ProjectStatus, type Value } from "@/domain/types";
import type { DetailDTO } from "@/server/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ValueEditor } from "@/components/fields/value-editor";
import { useProject } from "./context";
import { usePendingWrites } from "./use-queue";

const STATUS_LABELS: Record<ProjectStatus, string> = { ACTIVE: "Active", ON_HOLD: "On hold", CLOSED: "Closed" };
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

/**
 * Edit details: code, name, status and every project field. Each change saves on its own (no Save button) and is
 * logged in History.
 */
export function DetailsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { raw, projectId } = useProject();
  const pending = usePendingWrites(projectId);
  const p = raw.project;
  const fields = raw.details.filter((d) => !d.archived);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Project details</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5">
            {pending > 0 ? (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden /> Saving…
              </>
            ) : (
              "Every change saves straight away and is logged in History."
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="relative min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <CodeField key={`code-${p.code}`} />
          <NameField key={`name-${p.name}`} />
          <div className="space-y-1.5">
            <Label htmlFor="project-status">Status</Label>
            <StatusField />
          </div>
          <div className="space-y-4 border-t pt-4">
            {fields.length === 0 ? <p className="text-sm text-muted-foreground">No project fields yet. Add them in the Library under Project fields.</p> : null}
            {fields.map((d) => (
              <DetailField key={d.fieldId} d={d} />
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatusField() {
  const { raw, api } = useProject();
  return (
    <Select value={raw.project.status} onValueChange={(v) => void api.updateProject({ status: v })}>
      <SelectTrigger id="project-status" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROJECT_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {STATUS_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CodeField() {
  const { raw, api } = useProject();
  const [code, setCode] = useState(raw.project.code);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const clean = code.trim().toUpperCase();
  const invalid = clean !== "" && !CODE_PATTERN.test(clean);

  async function commit() {
    if (clean === raw.project.code) return setError(null);
    if (!clean || invalid) {
      setError("A code is 2–20 letters, digits or dashes and starts with a letter or digit, for example C0822 or C0822-SP1.");
      return;
    }
    setSaving(true);
    const r = await api.updateProject({ code: clean }, { quiet: true });
    setSaving(false);
    if (!r.ok && r.code !== "SESSION") setError(r.error);
    else setError(null);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="project-code">Code</Label>
      <div className="relative">
        <Input
          id="project-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          aria-invalid={Boolean(error) || invalid || undefined}
          aria-describedby="project-code-help"
          className="font-mono uppercase"
          maxLength={20}
        />
        {saving ? <Loader2 className="absolute top-2 right-2 size-4 animate-spin text-muted-foreground" aria-label="Saving" /> : null}
      </div>
      <p id="project-code-help" className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? "Unique. Suffixes like C0822-SP1 are fine. Old codes stay in History."}
      </p>
    </div>
  );
}

function NameField() {
  const { raw, api } = useProject();
  const [name, setName] = useState(raw.project.name);
  const [error, setError] = useState<string | null>(null);
  async function commit() {
    const n = name.trim();
    if (n === raw.project.name) return;
    if (!n) {
      setError("The project needs a name.");
      return;
    }
    const r = await api.updateProject({ name: n }, { quiet: true });
    if (!r.ok && r.code !== "SESSION") setError(r.error);
    else setError(null);
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor="project-name">Name</Label>
      <Input
        id="project-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        aria-invalid={Boolean(error) || undefined}
        maxLength={500}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function DetailField({ d }: { d: DetailDTO }) {
  const { api, raw } = useProject();
  const save = (value: Value | null) => void api.updateProject({ details: { [d.fieldId]: value } });
  const id = `detail-${d.fieldId}`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{d.label}</Label>
      {d.fieldType === "DROPDOWN" || d.fieldType === "MULTIPLE" ? (
        <ChoiceField id={id} d={d} onSave={save} />
      ) : (
        <div id={id}>
          <ValueEditor def={{ fieldType: d.fieldType, choices: d.choices, config: d.config }} value={d.value} today={raw.today} onCommit={save} label={d.label} compact />
        </div>
      )}
    </div>
  );
}

/** Searchable single / multiple choice with "Add 'X'" for a new option (added to the field for every project). */
function ChoiceField({ id, d, onSave }: { id: string; d: DetailDTO; onSave: (v: Value | null) => void }) {
  const { api } = useProject();
  const multiple = d.fieldType === "MULTIPLE";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [extra, setExtra] = useState<Choice[]>([]);
  useEffect(() => setExtra([]), [d.choices]);

  const all = [...d.choices, ...extra.filter((e) => !d.choices.some((c) => c.id === e.id))];
  const selected: string[] = d.value ? ("choiceId" in d.value ? [d.value.choiceId] : "choiceIds" in d.value ? d.value.choiceIds : []) : [];
  const visible = all.filter((c) => !c.archived || selected.includes(c.id));
  const q = query.trim();
  const exact = visible.some((c) => c.label.toLowerCase() === q.toLowerCase());

  function pick(choiceId: string) {
    if (multiple) {
      const next = selected.includes(choiceId) ? selected.filter((x) => x !== choiceId) : [...selected, choiceId];
      onSave(next.length ? { choiceIds: next } : null);
    } else {
      onSave(selected[0] === choiceId ? null : { choiceId });
      setOpen(false);
    }
  }

  async function add() {
    if (!q || adding) return;
    setAdding(true);
    const r = await api.addDetailChoice(d.fieldId, q);
    setAdding(false);
    if (r.ok) {
      setExtra((e) => [...e, { id: r.data.choiceId, label: q }]);
      setQuery("");
      if (multiple) onSave({ choiceIds: [...selected, r.data.choiceId] });
      else {
        onSave({ choiceId: r.data.choiceId });
        setOpen(false);
      }
    }
  }

  const label = selected.map((sid) => all.find((c) => c.id === sid)?.label ?? "Unknown").join(", ");

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" role="combobox" aria-expanded={open} className="h-8 min-w-0 flex-1 justify-between font-normal">
            <span className={cn("truncate", !label && "text-muted-foreground")}>{label || (multiple ? "Pick one or more" : "Pick one")}</span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
          <Command>
            <CommandInput value={query} onValueChange={setQuery} placeholder={`Search or add ${d.label.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>{q ? "No match." : "No options yet."}</CommandEmpty>
              <CommandGroup>
                {visible.map((c) => (
                  <CommandItem key={c.id} value={`${c.label} ${c.id}`} onSelect={() => pick(c.id)}>
                    <Check className={cn("size-4", selected.includes(c.id) ? "opacity-100" : "opacity-0")} aria-hidden />
                    {c.label}
                    {c.archived ? <span className="text-xs text-muted-foreground">(retired)</span> : null}
                  </CommandItem>
                ))}
                {q && !exact ? (
                  <CommandItem value={`__add__ ${q}`} onSelect={() => void add()} disabled={adding}>
                    {adding ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                    Add &ldquo;{q}&rdquo;
                  </CommandItem>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length ? (
        <Button size="icon-sm" variant="ghost" aria-label={`Clear ${d.label}`} onClick={() => onSave(null)}>
          <X aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
