"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Archive, ArchiveRestore, Copy, GripVertical, Plus, Search } from "lucide-react";
import type { Choice, FieldConfig, FieldType, State } from "@/domain/types";
import { FIELD_TYPES, STATES } from "@/domain/types";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { STATE_META } from "@/domain/state";
import { slugify } from "@/domain/slug";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { stateClass } from "@/components/state/state-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";

export interface EditableDef {
  name: string;
  description: string;
  fieldType: FieldType;
  choices: Choice[];
  config: FieldConfig;
  /** Fixed automation key (read-only). */
  key?: string;
}

export type DefPatch = Partial<Pick<EditableDef, "name" | "description" | "fieldType" | "choices" | "config">>;

export interface OtherDef {
  id: string;
  name: string;
  fieldType: FieldType;
  choices: Choice[];
}

export interface DefinitionEditorProps {
  def: EditableDef;
  onSave: (patch: DefPatch) => void;
  /** For "Copy choices from…" and "Also apply to…". */
  others?: OtherDef[];
  onApplyChoicesTo?: (targetIds: string[]) => void;
  /** Dropdown choices carry a state (milestones and steps). False for project fields. */
  withStates?: boolean;
  /** Allowed field types (project fields exclude File). */
  fieldTypes?: readonly FieldType[];
  readOnly?: boolean;
  /** Explains why the type can't be changed (e.g. system field). Disables the type select. */
  typeLocked?: string;
  /** A note under the type select that does not disable it (e.g. "can only switch between Dropdown and Multiple"). */
  typeHint?: React.ReactNode;
  /**
   * When set, picking another field type first shows this effect ("what happens") with Change type / Cancel; the
   * change is saved only after confirming. Without it the type is saved immediately (previous behaviour).
   */
  typeChangeEffect?: (to: FieldType) => React.ReactNode;
  nameLabel?: string;
  /** Show the description box (default true; project fields have no description). */
  withDescription?: boolean;
  descriptionPlaceholder?: string;
  /** Returns a message when a new name can't be used (e.g. another item already has it); the name is then not saved. */
  validateName?: (name: string) => string | null;
}

/** Match the services' limits (names and choice labels, descriptions, units). */
const NAME_MAX = 500;
const DESCRIPTION_MAX = 500;
const UNIT_MAX = 40;

const STATE_SHORT: Record<State, string> = {
  NOT_STARTED: "NS",
  IN_PROGRESS: "IP",
  WAITING: "W",
  BLOCKED: "B",
  DONE: "D",
  NOT_APPLICABLE: "NA",
};

function sameChoiceList(a: Choice[], b: Choice[]): boolean {
  const norm = (cs: Choice[]) =>
    JSON.stringify(cs.filter((c) => !c.archived).map((c) => [c.label.trim().toLowerCase(), c.state ?? null]));
  return norm(a) === norm(b);
}

export function DefinitionEditor({
  def,
  onSave,
  others = [],
  onApplyChoicesTo,
  withStates = true,
  fieldTypes = FIELD_TYPES,
  readOnly,
  typeLocked,
  typeHint,
  typeChangeEffect,
  nameLabel = "Name",
  withDescription = true,
  descriptionPlaceholder = "Optional notes on what this milestone means",
  validateName,
}: DefinitionEditorProps) {
  const [name, setName] = useState(def.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState(def.description);
  const [unit, setUnit] = useState(def.config.unit ?? "");
  useEffect(() => {
    setName(def.name);
    setNameError(null);
  }, [def.name]);
  useEffect(() => setDescription(def.description), [def.description]);
  useEffect(() => setUnit(def.config.unit ?? ""), [def.config.unit]);

  const meta = FIELD_TYPE_META[def.fieldType];
  const statesShown = withStates && meta.choicesHaveState;

  // "Also apply to": milestones that had the same choice list when this editor opened (parent keys the editor
  // by milestone id, so the baseline resets when another milestone is selected). Shown only after an edit.
  const [baseline] = useState(def.choices);
  const choicesChanged = !sameChoiceList(baseline, def.choices);
  const twins = useMemo(
    () =>
      meta.hasChoices && choicesChanged
        ? others.filter((o) => o.fieldType === def.fieldType && sameChoiceList(o.choices, baseline))
        : [],
    [others, def.fieldType, baseline, meta.hasChoices, choicesChanged],
  );

  const [pendingType, setPendingType] = useState<FieldType | null>(null);
  useEffect(() => setPendingType(null), [def.fieldType]);

  function pickType(t: FieldType) {
    if (t === def.fieldType) {
      setPendingType(null);
      return;
    }
    if (typeChangeEffect) setPendingType(t);
    else changeType(t);
  }

  function changeType(t: FieldType) {
    setPendingType(null);
    if (t === def.fieldType) return;
    const patch: DefPatch = { fieldType: t };
    // Dropdown choices need a state; give stateless choices "Not started" so they can be reviewed.
    if (withStates && FIELD_TYPE_META[t].choicesHaveState) {
      patch.choices = def.choices.map((c) => (c.state ? c : { ...c, state: "NOT_STARTED" }));
    }
    onSave(patch);
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="def-name">{nameLabel}</Label>
        <Input
          id="def-name"
          value={name}
          disabled={readOnly}
          maxLength={NAME_MAX}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "def-name-error" : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          onBlur={() => {
            const t = name.trim().replace(/\s+/g, " ");
            if (!t || t === def.name) {
              setName(def.name);
              setNameError(null);
              return;
            }
            const problem = validateName?.(t) ?? null;
            setNameError(problem);
            if (!problem) onSave({ name: t });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape" && name !== def.name) {
              // First Esc undoes the typing; the next one closes the panel.
              e.preventDefault();
              setName(def.name);
              setNameError(null);
            }
          }}
        />
        {nameError ? (
          <p id="def-name-error" role="alert" className="text-xs text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="def-type">Field type</Label>
        <Select value={pendingType ?? def.fieldType} onValueChange={(v) => pickType(v as FieldType)} disabled={readOnly || Boolean(typeLocked)}>
          <SelectTrigger id="def-type" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(fieldTypes.includes(def.fieldType) ? fieldTypes : [def.fieldType, ...fieldTypes]).map((t) => (
              <SelectItem key={t} value={t}>
                {FIELD_TYPE_META[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {typeLocked ? <p className="text-xs text-muted-foreground">{typeLocked}</p> : null}
        {!typeLocked && typeHint ? <p className="text-xs text-muted-foreground">{typeHint}</p> : null}
        {pendingType && typeChangeEffect ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-2.5" role="group" aria-label="Confirm field type change">
            <div className="text-xs font-medium">
              Change {FIELD_TYPE_META[def.fieldType].label} → {FIELD_TYPE_META[pendingType].label}?
            </div>
            {typeChangeEffect(pendingType)}
            <div className="flex gap-2">
              <Button size="sm" className="h-7" onClick={() => changeType(pendingType)}>
                Change type
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setPendingType(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {def.fieldType === "NUMBER" ? (
        <div className="space-y-1.5">
          <Label htmlFor="def-unit">Unit</Label>
          <Input
            id="def-unit"
            value={unit}
            placeholder="e.g. pcs"
            disabled={readOnly}
            maxLength={UNIT_MAX}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={() => {
              const u = unit.trim();
              if (u !== (def.config.unit ?? "")) onSave({ config: { ...def.config, unit: u || undefined } });
            }}
            className="h-8 w-32"
          />
        </div>
      ) : null}

      {meta.hasChoices ? (
        <ChoicesEditor
          choices={def.choices}
          withStates={statesShown}
          readOnly={readOnly}
          onChange={(choices) => onSave({ choices })}
          others={others.filter((o) => FIELD_TYPE_META[o.fieldType].hasChoices)}
        />
      ) : null}

      {meta.hasChoices && twins.length && onApplyChoicesTo ? (
        <ApplyToOthers twins={twins} onApply={onApplyChoicesTo} disabled={readOnly} />
      ) : null}

      {withDescription ? (
        <div className="space-y-1.5">
          <Label htmlFor="def-desc">Description</Label>
          <Textarea
            id="def-desc"
            value={description}
            disabled={readOnly}
            rows={3}
            maxLength={DESCRIPTION_MAX}
            aria-describedby={description.length > DESCRIPTION_MAX - 100 ? "def-desc-count" : undefined}
            placeholder={descriptionPlaceholder}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              if (description.trim() !== def.description.trim()) onSave({ description: description.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            }}
            className="field-sizing-content min-h-16 text-sm"
          />
          {description.length > DESCRIPTION_MAX - 100 ? (
            <p id="def-desc-count" className="text-right text-xs text-muted-foreground tabular-nums">
              {description.length} / {DESCRIPTION_MAX}
            </p>
          ) : null}
        </div>
      ) : null}

      {def.key ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">ID for automations</div>
          <code className="block rounded bg-muted px-2 py-1 text-xs">{def.key}</code>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ChoicesEditor({
  choices,
  withStates,
  readOnly,
  onChange,
  others,
}: {
  choices: Choice[];
  withStates: boolean;
  readOnly?: boolean;
  onChange: (choices: Choice[]) => void;
  others: OtherDef[];
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyQuery, setCopyQuery] = useState("");
  const copyList = others.filter((o) => o.name.toLowerCase().includes(copyQuery.trim().toLowerCase()));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const active = choices.filter((c) => !c.archived);
  const archived = choices.filter((c) => c.archived);

  function update(id: string, patch: Partial<Choice>) {
    onChange(choices.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function move(id: string, delta: number) {
    const idx = active.findIndex((c) => c.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= active.length) return;
    onChange([...arrayMove(active, idx, to), ...archived]);
  }
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = active.findIndex((c) => c.id === e.active.id);
    const to = active.findIndex((c) => c.id === e.over!.id);
    onChange([...arrayMove(active, from, to), ...archived]);
  }
  function add() {
    const label = newLabel.trim().replace(/\s+/g, " ");
    if (!label) return;
    const same = (c: Choice) => c.label.trim().toLowerCase() === label.toLowerCase();
    if (active.some(same)) {
      setAddError(`“${label}” is already a choice.`);
      return;
    }
    const old = archived.find(same);
    if (old) {
      // Bring the archived choice back (same id, so values that use it still match) instead of adding a twin.
      onChange([...active, { ...old, archived: undefined }, ...archived.filter((c) => c.id !== old.id)]);
      setNewLabel("");
      return;
    }
    const id = slugify(label, choices.map((c) => c.id));
    const choice: Choice = withStates ? { id, label, state: "NOT_STARTED" } : { id, label };
    onChange([...active, choice, ...archived]);
    setNewLabel("");
  }
  function copyFrom(source: OtherDef) {
    // Keep matching ids; archive choices that no longer exist; never delete.
    const sourceActive = source.choices.filter((c) => !c.archived);
    const byLabel = new Map(choices.map((c) => [c.label.trim().toLowerCase(), c]));
    const taken = new Set(choices.map((c) => c.id));
    const next: Choice[] = sourceActive.map((s) => {
      const existing = byLabel.get(s.label.trim().toLowerCase());
      if (existing) return { ...existing, label: s.label, state: withStates ? s.state : undefined, archived: undefined };
      const id = taken.has(s.id) ? slugify(s.label, taken) : s.id;
      taken.add(id);
      return withStates ? { id, label: s.label, state: s.state ?? "NOT_STARTED" } : { id, label: s.label };
    });
    const kept = new Set(next.map((c) => c.id));
    const retired = choices.filter((c) => !kept.has(c.id)).map((c) => ({ ...c, archived: true }));
    onChange([...next, ...retired]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Choices</Label>
        <div className="flex items-center gap-1">
          {others.length && !readOnly ? (
            <Popover
              open={copyOpen}
              onOpenChange={(o) => {
                setCopyOpen(o);
                if (!o) setCopyQuery("");
              }}
            >
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-xs">
                  <Copy className="size-3.5" /> Copy from…
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="end">
                {others.length > 8 ? (
                  <div className="relative mb-1">
                    <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={copyQuery}
                      onChange={(e) => setCopyQuery(e.target.value)}
                      placeholder="Find a list to copy"
                      aria-label="Find a list to copy"
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                ) : null}
                <div className="max-h-64 overflow-y-auto">
                  {copyList.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">No match</p> : null}
                  {copyList.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      onClick={() => {
                        copyFrom(o);
                        setCopyOpen(false);
                        setCopyQuery("");
                      }}
                    >
                      {o.name} <span className="text-xs text-muted-foreground">({o.choices.filter((c) => !c.archived).length})</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={active.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1">
            {active.map((c) => (
              <ChoiceRow
                key={c.id}
                choice={c}
                withStates={withStates}
                readOnly={readOnly}
                onLabel={(label) => update(c.id, { label })}
                onState={(state) => update(c.id, { state })}
                onArchive={() => update(c.id, { archived: true })}
                onMove={(d) => move(c.id, d)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {!readOnly ? (
        <div className="space-y-1">
          <div className="flex gap-1">
            <Input
              value={newLabel}
              maxLength={NAME_MAX}
              aria-label="New choice"
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? "def-add-choice-error" : undefined}
              onChange={(e) => {
                setNewLabel(e.target.value);
                if (addError) setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Add a choice and press Enter"
              className="h-8"
            />
            <Button variant="outline" size="icon" className="size-8 shrink-0" onClick={add} aria-label="Add choice">
              <Plus className="size-4" />
            </Button>
          </div>
          {addError ? (
            <p id="def-add-choice-error" role="alert" className="text-xs text-destructive">
              {addError}
            </p>
          ) : null}
        </div>
      ) : null}

      {archived.length ? (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} className="scale-75" /> Show {archived.length} archived
          </label>
          {showArchived ? (
            <ul className="space-y-1">
              {archived.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1 text-sm text-muted-foreground">
                  <span className="flex-1 truncate">{c.label}</span>
                  {!readOnly ? (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => update(c.id, { archived: undefined })}>
                      <ArchiveRestore className="size-3.5" /> Restore
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  choice,
  withStates,
  readOnly,
  onLabel,
  onState,
  onArchive,
  onMove,
}: {
  choice: Choice;
  withStates: boolean;
  readOnly?: boolean;
  onLabel: (label: string) => void;
  onState: (state: State) => void;
  onArchive: () => void;
  onMove: (delta: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: choice.id, disabled: readOnly });
  const [label, setLabel] = useState(choice.label);
  useEffect(() => setLabel(choice.label), [choice.label]);
  const style = transform ? { transform: `translate3d(0, ${Math.round(transform.y)}px, 0)`, transition } : { transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn("flex items-center gap-1 rounded-md border bg-background px-1 py-0.5", isDragging && "z-10 shadow-md")}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          onMove(e.key === "ArrowUp" ? -1 : 1);
        }
      }}
    >
      {!readOnly ? (
        <button type="button" className="cursor-grab p-0.5 text-muted-foreground" aria-label={`Reorder ${choice.label}`} {...attributes} {...listeners}>
          <GripVertical className="size-3.5" />
        </button>
      ) : null}
      <Input
        value={label}
        disabled={readOnly}
        maxLength={NAME_MAX}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const t = label.trim();
          if (t && t !== choice.label) onLabel(t);
          else setLabel(choice.label);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-7 flex-1 border-transparent px-1.5 shadow-none focus-visible:border-input"
        aria-label="Choice label"
      />
      {withStates ? (
        <div className="flex shrink-0 gap-px" role="radiogroup" aria-label={`State for ${choice.label}`}>
          {STATES.map((s) => {
            const on = (choice.state ?? "NOT_STARTED") === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                title={STATE_META[s].label}
                disabled={readOnly}
                onClick={() => onState(s)}
                className={cn(
                  stateClass(s),
                  "h-6 min-w-6 rounded px-1 text-[10px] font-semibold transition-colors",
                  on
                    ? "border border-[var(--s-border)] bg-[var(--s-bg)] text-[var(--s-fg)]"
                    : "text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground",
                )}
              >
                {STATE_SHORT[s]}
              </button>
            );
          })}
        </div>
      ) : null}
      {!readOnly ? (
        <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" onClick={onArchive} aria-label={`Archive ${choice.label}`} title="Archive">
          <Archive className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

function ApplyToOthers({ twins, onApply, disabled }: { twins: OtherDef[]; onApply: (ids: string[]) => void; disabled?: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Keep ticks across background refreshes; drop only milestones that are no longer listed.
  const twinKey = twins.map((t) => t.id).join("|");
  useEffect(() => {
    const ids = new Set(twinKey.split("|"));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [twinKey]);
  return (
    <div className="rounded-md border bg-muted/40 p-2 text-xs">
      <div className="mb-1 font-medium">Also apply these choices to</div>
      <div className="space-y-1">
        {twins.map((t) => (
          <label key={t.id} className="flex items-center gap-2">
            <Checkbox
              checked={selected.has(t.id)}
              onCheckedChange={(c) => {
                const next = new Set(selected);
                if (c) next.add(t.id);
                else next.delete(t.id);
                setSelected(next);
              }}
            />
            {t.name}
          </label>
        ))}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2 h-7"
        disabled={disabled || !selected.size}
        onClick={() => {
          onApply([...selected]);
          setSelected(new Set());
        }}
      >
        Apply to {selected.size || ""} selected
      </Button>
      <p className="mt-1 text-muted-foreground">Shown because these milestones had the same choices before your edit.</p>
    </div>
  );
}
