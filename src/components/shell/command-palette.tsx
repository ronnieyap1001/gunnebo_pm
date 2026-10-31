"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Archive,
  DatabaseBackup,
  FileSpreadsheet,
  FolderKanban,
  Keyboard,
  LayoutGrid,
  Library,
  Loader2,
  Moon,
  Plus,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { StateDot } from "@/components/state/state-badge";
import { paletteProjectsAction, paletteStepsAction, type PaletteProject, type PaletteStep } from "@/app/(app)/projects/actions";
import { callAction, toastFailure } from "./action-call";

const SCREENS = [
  { href: "/portfolio", label: "Portfolio", icon: LayoutGrid, keys: "G P" },
  { href: "/projects", label: "Projects", icon: FolderKanban, keys: "G R" },
  { href: "/library", label: "Milestone Library", icon: Library, keys: "G L" },
  { href: "/template", label: "Template Flow", icon: Workflow, keys: "G T" },
  { href: "/archive", label: "Archive", icon: Archive, keys: "G A" },
  { href: "/settings", label: "Settings", icon: Settings, keys: "G S" },
];

/** Projects are reloaded in the background when the palette opens and the list is older than this. */
const STALE_MS = 30_000;

/**
 * Every typed word must appear in the item (its text or keywords), so "C0822" finds that project and not every code
 * that happens to contain the same digits in order. Matches at the start of a word rank first.
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = ` ${value} ${(keywords ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return 0;
    score += hay.startsWith(` ${w}`) ? 1 : hay.includes(` ${w}`) ? 0.8 : 0.5;
  }
  return score / words.length;
}

function projectIdFromPath(pathname: string): string | null {
  const m = /^\/projects\/([^/?#]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * ⌘K / Ctrl+K: jump to a screen, a project (code, name or customer) or a milestone of the open project, and run
 * the common actions (New project, Toggle theme, Download backup, Export to Excel).
 */
export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { resolvedTheme, setTheme } = useTheme();
  const [projects, setProjects] = useState<PaletteProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadedAt = useRef(0);
  const [steps, setSteps] = useState<{
    projectId: string;
    code: string;
    steps: PaletteStep[];
  } | null>(null);
  const currentProjectId = projectIdFromPath(pathname);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const r = await callAction(() => paletteProjectsAction(), { retries: 1 });
    setLoading(false);
    setLoadFailed(!r.ok);
    if (r.ok) {
      setProjects(r.data);
      loadedAt.current = Date.now();
    } else {
      toastFailure(r, { title: "Couldn't load the projects" });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!projects || Date.now() - loadedAt.current > STALE_MS) void loadProjects();
  }, [open, projects, loadProjects]);

  // Milestones of the open project: refreshed every time the palette opens on a project page (values change often).
  useEffect(() => {
    if (!open || !currentProjectId) return;
    let cancelled = false;
    void callAction(() => paletteStepsAction(currentProjectId), {
      retries: 1,
    }).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) setSteps({ projectId: currentProjectId, ...r.data });
    });
    return () => {
      cancelled = true;
    };
  }, [open, currentProjectId]);

  function run(fn: () => void) {
    onOpenChange(false);
    fn();
  }

  const projectSteps = currentProjectId && steps?.projectId === currentProjectId ? steps : null;
  const dark = resolvedTheme === "dark";

  // shadcn's CommandDialog puts its title outside the dialog (a stray heading on every page), so the dialog is built here.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Jump to a project, a screen or an action</DialogDescription>
        </DialogHeader>
        <Command className="rounded-none!" filter={paletteFilter} vimBindings={false}>
          <CommandInput
            placeholder="Search projects, milestones, screens and actions…"
            aria-label="Search projects, milestones, screens and actions"
          />
          <CommandList className="max-h-[min(60svh,440px)]">
            <CommandEmpty>
              {loading ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Loading projects…
                </span>
              ) : loadFailed && !projects ? (
                "Couldn't load the projects. Close the palette and open it again to retry."
              ) : (
                "Nothing matches. Try a project code such as C0822."
              )}
            </CommandEmpty>

            <CommandGroup heading="Actions">
              <CommandItem value="New project create" onSelect={() => run(() => router.push("/projects?new=1"))}>
                <Plus aria-hidden />
                New project
                <CommandShortcut>C</CommandShortcut>
              </CommandItem>
              {projectSteps ? (
                <CommandItem
                  value={`Export ${projectSteps.code} to Excel xlsx`}
                  onSelect={() => run(() => window.location.assign(`/api/export/project/${encodeURIComponent(projectSteps.projectId)}`))}
                >
                  <FileSpreadsheet aria-hidden />
                  Export {projectSteps.code} to Excel
                </CommandItem>
              ) : null}
              <CommandItem value="Toggle theme dark light mode" onSelect={() => run(() => setTheme(dark ? "light" : "dark"))}>
                {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
                {dark ? "Switch to light mode" : "Switch to dark mode"}
              </CommandItem>
              <CommandItem value="Download backup" onSelect={() => run(() => router.push("/settings#backup"))}>
                <DatabaseBackup aria-hidden />
                Download backup
              </CommandItem>
              <CommandItem value="Keyboard shortcuts help" onSelect={() => run(onShowShortcuts)}>
                <Keyboard aria-hidden />
                Keyboard shortcuts
                <CommandShortcut>?</CommandShortcut>
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />
            <CommandGroup heading="Go to">
              {SCREENS.map((s) => (
                <CommandItem key={s.href} value={`Go to ${s.label}`} onSelect={() => run(() => router.push(s.href))}>
                  <s.icon aria-hidden />
                  {s.label}
                  <CommandShortcut>{s.keys}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>

            {projects && projects.length ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Projects">
                  {projects.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.code} ${p.name}`}
                      keywords={p.customer ? [p.customer] : undefined}
                      onSelect={() => run(() => router.push(`/projects/${encodeURIComponent(p.id)}`))}
                    >
                      <FolderKanban aria-hidden className="text-muted-foreground" />
                      <span className="w-24 shrink-0 font-mono text-xs font-medium">{p.code}</span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.customer ? <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{p.customer}</span> : null}
                      {p.status !== "ACTIVE" ? <span className="shrink-0 text-[11px] text-muted-foreground">{p.statusLabel}</span> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}

            {projectSteps ? (
              <>
                <CommandSeparator />
                <CommandGroup heading={`Milestones in ${projectSteps.code}`}>
                  {projectSteps.steps.map((s) => (
                    <CommandItem
                      key={s.id}
                      value={`${String(s.seq).padStart(2, "0")} ${s.name}`}
                      keywords={s.value && s.value !== "—" ? [s.value] : undefined}
                      onSelect={() =>
                        run(() =>
                          router.push(`/projects/${encodeURIComponent(projectSteps.projectId)}?view=flow&node=${encodeURIComponent(s.id)}`),
                        )
                      }
                    >
                      <StateDot state={s.state} />
                      <span className="w-6 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                        {String(s.seq).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {s.isCurrent ? <span className="shrink-0 text-[11px] text-[var(--current-ring)]">Current</span> : null}
                      <span className="max-w-36 shrink-0 truncate text-xs text-muted-foreground">{s.value}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
