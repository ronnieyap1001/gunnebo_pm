"use client";

import { useRef } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  Keyboard,
  LayoutGrid,
  Loader2,
  Maximize,
  MoveRight,
  Plus,
  RefreshCw,
  Rows3,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "./kbd";
import type { SaveStatus } from "./write";

function Tip({ label, keyHint, children }: { label: string; keyHint?: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {keyHint ? <Kbd className="ml-1.5 border-background/30 bg-background/20 text-background">{keyHint}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** "Saving…" while writes are queued, "Not saved" after a failure, otherwise "Saved". */
export function SaveIndicator({ status }: { status: SaveStatus }) {
  return (
    <span
      className={cn(
        "flex h-7 items-center gap-1 px-1.5 text-xs whitespace-nowrap",
        status === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      role="status"
      aria-live="polite"
    >
      {status === "saving" ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
        </>
      ) : status === "error" ? (
        <>
          <AlertTriangle className="size-3.5" aria-hidden /> Not saved
        </>
      ) : (
        <>
          <Check className="size-3.5 text-[var(--state-d-solid)]" aria-hidden /> Saved
        </>
      )}
    </span>
  );
}

export function TemplateToolbar({
  onNew,
  layoutMenuOpen,
  onLayoutMenuOpenChange,
  onLayout,
  onFit,
  onExport,
  exporting,
  onImportFile,
  importing,
  onSyncAll,
  syncing,
  busy,
  onHelp,
  saveStatus,
  disabled,
}: {
  onNew: () => void;
  layoutMenuOpen: boolean;
  onLayoutMenuOpenChange: (open: boolean) => void;
  onLayout: (wrap: boolean) => void;
  onFit: () => void;
  onExport: () => void;
  exporting: boolean;
  onImportFile: (file: File) => void;
  importing: boolean;
  onSyncAll: () => void;
  syncing: boolean;
  /** A long job (import or sync) is running: both start buttons are disabled. */
  busy: boolean;
  onHelp: () => void;
  saveStatus: SaveStatus;
  /** No milestones yet: layout and fit have nothing to work on. */
  disabled?: { layout?: boolean };
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div
      role="toolbar"
      aria-label="Template flow tools"
      className="flex max-w-[calc(100cqw-2rem)] flex-wrap items-center gap-0.5 rounded-lg border bg-background/95 p-1 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <Tip label="New milestone" keyHint="N">
        <Button size="sm" onClick={onNew}>
          <Plus aria-hidden /> Milestone
        </Button>
      </Tip>

      <DropdownMenu open={layoutMenuOpen} onOpenChange={onLayoutMenuOpenChange}>
        <Tip label="Arrange the chart automatically" keyHint="L">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={disabled?.layout}>
              <LayoutGrid aria-hidden />
              <span className="@max-[880px]:sr-only">Auto-layout</span>
              <ChevronDown className="size-3 opacity-60" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Auto-layout (you can undo it)</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onLayout(false)}>
            <MoveRight aria-hidden />
            <span className="flex flex-col">
              <span>Left → Right</span>
              <span className="text-xs text-muted-foreground">One long row, branches stacked</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onLayout(true)}>
            <Rows3 aria-hidden />
            <span className="flex flex-col">
              <span>Wrapped</span>
              <span className="text-xs text-muted-foreground">Left → Right in rows that fit the screen</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tip label="Fit the whole chart" keyHint="F">
        <Button variant="ghost" size="sm" onClick={onFit} disabled={disabled?.layout}>
          <Maximize aria-hidden />
          <span className="@max-[880px]:sr-only">Fit</span>
        </Button>
      </Tip>

      <Separator orientation="vertical" className="mx-0.5 !h-5" />

      <Tip label="Download the template as a JSON file">
        <Button variant="ghost" size="sm" onClick={onExport} disabled={exporting} aria-busy={exporting}>
          {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          <span className="@max-[1080px]:sr-only">Export JSON</span>
        </Button>
      </Tip>
      <Tip label="Replace the template from a JSON file (you see a preview first)">
        <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={importing || busy} aria-busy={importing}>
          {importing ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
          <span className="@max-[1080px]:sr-only">Import JSON</span>
        </Button>
      </Tip>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onImportFile(file);
        }}
      />

      <Separator orientation="vertical" className="mx-0.5 !h-5" />

      <Tip label="Bring the template changes into every active project">
        <Button variant="ghost" size="sm" onClick={onSyncAll} disabled={syncing || busy} aria-busy={syncing}>
          {syncing ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          <span className="@max-[1080px]:sr-only">Sync all projects</span>
        </Button>
      </Tip>

      <Separator orientation="vertical" className="mx-0.5 !h-5" />
      <SaveIndicator status={saveStatus} />
      <Tip label="Keyboard shortcuts" keyHint="?">
        <Button variant="ghost" size="icon-sm" onClick={onHelp} aria-label="Keyboard shortcuts">
          <Keyboard aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}
