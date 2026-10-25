"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldTypeIcon } from "./field-type-icon";
import { STATE_RULE } from "./type-change";

/**
 * Small "name + field type" dialog for "+ Milestone" and "+ Field". `onCreate` resolves to an error message (shown
 * inline, the dialog stays open) or null (the dialog closes).
 */
export function NewItemDialog({
  open,
  onOpenChange,
  title,
  description,
  nameLabel,
  namePlaceholder,
  fieldTypes,
  defaultType,
  submitLabel,
  showStateRule,
  validateName,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  nameLabel: string;
  namePlaceholder: string;
  fieldTypes: readonly FieldType[];
  defaultType: FieldType;
  submitLabel: string;
  showStateRule?: boolean;
  /** Returns a message when the name can't be used (e.g. another item already has it). */
  validateName?: (name: string) => string | null;
  onCreate: (name: string, fieldType: FieldType) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>(defaultType);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setFieldType(defaultType);
      setError(null);
      setPending(false);
    }
  }, [open, defaultType]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    const n = name.trim().replace(/\s+/g, " ");
    if (!n) {
      setError(`${nameLabel} can't be empty.`);
      return;
    }
    const invalid = validateName?.(n);
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    setError(null);
    const problem = await onCreate(n, fieldType);
    setPending(false);
    if (problem) setError(problem);
    else onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="new-item-name">{nameLabel}</Label>
            <Input
              id="new-item-name"
              autoFocus
              value={name}
              maxLength={500}
              placeholder={namePlaceholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "new-item-error" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-item-type">Field type</Label>
            <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
              <SelectTrigger id="new-item-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {fieldTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    <FieldTypeIcon type={t} className="text-muted-foreground" />
                    {FIELD_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showStateRule ? <p className="text-xs text-muted-foreground">Colour: {STATE_RULE[fieldType]}</p> : null}
          </div>
          {error ? (
            <p id="new-item-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {pending ? "Adding…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
