"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { FIELD_TYPE_META } from "@/domain/fieldTypes";
import { STATE_META } from "@/domain/state";
import { FIELD_TYPES, STATES, type FieldType, type Position, type State } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StateDot } from "@/components/state/state-badge";
import { useProject } from "./context";

export interface AddStepRequest {
  afterStepId?: string;
  position?: Position;
}

const NONE = "__none__";

/** "+ Project step": a step only this project has (name, field type, choices; optionally inserted after a step). */
export function AddStepDialog({ request, onClose, onAdded }: { request: AddStepRequest | null; onClose: () => void; onAdded: (id: string) => void }) {
  const { view, api } = useProject();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("DROPDOWN");
  const [after, setAfter] = useState<string>(NONE);
  const [choices, setChoices] = useState<{ label: string; state: State }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setName("");
    setFieldType("DROPDOWN");
    setAfter(request.afterStepId ?? NONE);
    setChoices([
      { label: "Not started", state: "NOT_STARTED" },
      { label: "In progress", state: "IN_PROGRESS" },
      { label: "Done", state: "DONE" },
    ]);
    setError(null);
  }, [request]);

  const meta = FIELD_TYPE_META[fieldType];
  const afterStep = after !== NONE ? view.byId.get(after) : undefined;

  async function submit() {
    const n = name.trim();
    if (!n) {
      setError("Give the step a name.");
      return;
    }
    const list = meta.hasChoices ? choices.filter((c) => c.label.trim()) : [];
    const labels = list.map((c) => c.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) {
      setError("Two choices have the same name.");
      return;
    }
    setSaving(true);
    setError(null);
    const id = await api.addStep({
      name: n,
      fieldType,
      choices: meta.hasChoices ? list.map((c) => ({ label: c.label.trim(), ...(meta.choicesHaveState ? { state: c.state } : {}) })) : undefined,
      afterStepId: afterStep?.id,
      position: afterStep ? undefined : request?.position,
    });
    setSaving(false);
    if (id) {
      onClose();
      onAdded(id);
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={(o) => (!o && !saving ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a project step</DialogTitle>
          <DialogDescription>Only this project gets the step; the template is not changed. You can edit or archive it later.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-step-name">Name</Label>
            <Input id="new-step-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Customs broker appointed" maxLength={500} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-step-type">Field type</Label>
              <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
                <SelectTrigger id="new-step-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {FIELD_TYPE_META[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-step-after">Insert after</Label>
              <Select value={after} onValueChange={setAfter}>
                <SelectTrigger id="new-step-after" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NONE}>Nothing (unconnected)</SelectItem>
                  {view.steps.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.seq}. {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {afterStep ? (
            <p className="text-xs text-muted-foreground">
              The new step goes between &ldquo;{afterStep.name}&rdquo; and what follows it; its arrows move to the new step.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">It is placed {request?.position ? "where you clicked" : "below the chart"}. Draw its arrows with Edit arrows.</p>
          )}

          {meta.hasChoices ? (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Choices</legend>
              <ul className="space-y-1">
                {choices.map((c, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <Input
                      value={c.label}
                      onChange={(e) => setChoices((cs) => cs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      placeholder={`Choice ${i + 1}`}
                      aria-label={`Choice ${i + 1}`}
                      className="h-8"
                    />
                    {meta.choicesHaveState ? (
                      <Select value={c.state} onValueChange={(v) => setChoices((cs) => cs.map((x, j) => (j === i ? { ...x, state: v as State } : x)))}>
                        <SelectTrigger size="sm" className="w-40 shrink-0" aria-label={`Colour of choice ${i + 1}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATES.map((s) => (
                            <SelectItem key={s} value={s}>
                              <StateDot state={s} /> {STATE_META[s].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove choice ${i + 1}`} onClick={() => setChoices((cs) => cs.filter((_, j) => j !== i))}>
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="button" size="xs" variant="outline" onClick={() => setChoices((cs) => [...cs, { label: "", state: "IN_PROGRESS" }])}>
                <Plus aria-hidden /> Choice
              </Button>
            </fieldset>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add step
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
