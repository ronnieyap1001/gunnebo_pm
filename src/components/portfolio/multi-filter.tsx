"use client";

import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { Choice } from "@/domain/types";
import { cn } from "@/lib/utils";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Multi-select filter button ("Customer: SITA, NEC") with a searchable checklist. */
export function MultiFilter({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: Choice[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.filter((o) => selected.includes(o.id));
  // Ids from an old link or a retired choice still filter the grid, so they count here too.
  const count = new Set(selected).size;
  const summary = count === 0 ? "All" : count === chosen.length && count <= 2 ? chosen.map((c) => c.label).join(", ") : `${count} selected`;
  const active = count > 0;

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange(options.map((o) => o.id).filter((x) => next.includes(x)));
  }

  return (
    <div className="inline-flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled || options.length === 0}
            aria-label={`${label} filter: ${summary}`}
            className={cn(
              "inline-flex h-7 max-w-64 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
              active
                ? "border-foreground/25 bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              active && "rounded-r-none border-r-0 pr-1.5",
            )}
          >
            <span>{label}:</span>
            <span className={cn("truncate", active && "font-medium")}>{summary}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-60 p-0" align="start">
          <Command>
            {options.length > 6 ? <CommandInput placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label}`} /> : null}
            <CommandList>
              <CommandEmpty>No match.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.id} value={`${o.label} ${o.id}`} onSelect={() => toggle(o.id)}>
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-3.5 items-center justify-center rounded-[3px] border",
                        selected.includes(o.id) ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {selected.includes(o.id) ? <Check className="size-3" /> : null}
                    </span>
                    {o.label}
                    {selected.includes(o.id) ? <span className="sr-only"> (selected)</span> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {active ? (
        <button
          type="button"
          onClick={() => onChange([])}
          disabled={disabled}
          aria-label={`Clear the ${label} filter`}
          className="inline-flex h-7 items-center rounded-r-full border border-l-0 border-foreground/25 bg-accent pr-2 pl-1 text-accent-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
