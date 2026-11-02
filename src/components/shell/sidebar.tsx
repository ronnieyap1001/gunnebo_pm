"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Archive,
  FolderKanban,
  Keyboard,
  LayoutGrid,
  Library,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { logout } from "@/app/login/actions";
import { AppMark } from "./app-mark";
import { useShell } from "./app-shell";
import { BackupReminder, type BackupStatus } from "./backup-reminder";
import { Kbd } from "./kbd";
import { useIsMac } from "./use-now";

const MAIN_NAV = [
  { href: "/portfolio", label: "Portfolio", icon: LayoutGrid, keys: "G P" },
  { href: "/projects", label: "Projects", icon: FolderKanban, keys: "G R" },
  { href: "/library", label: "Milestone Library", icon: Library, keys: "G L" },
  { href: "/template", label: "Template Flow", icon: Workflow, keys: "G T" },
];

const FOOTER_NAV = [
  { href: "/archive", label: "Archive", icon: Archive, keys: "G A" },
  { href: "/settings", label: "Settings", icon: Settings, keys: "G S" },
];

const STORAGE_KEY = "gpm.sidebar.collapsed";

const ITEM =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none";

function WithTooltip({ collapsed, label, children }: { collapsed: boolean; label: string; children: React.ReactElement }) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  keys,
  collapsed,
  active,
}: {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  keys: string;
  collapsed: boolean;
  active: boolean;
}) {
  return (
    <WithTooltip collapsed={collapsed} label={`${label} (${keys.replace(" ", " then ")})`}>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        title={collapsed ? undefined : `${label} (${keys.replace(" ", " then ")})`}
        className={cn(ITEM, active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground", collapsed && "justify-center px-0")}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
      </Link>
    </WithTooltip>
  );
}

export function Sidebar({ backup }: { backup: BackupStatus | null }) {
  const pathname = usePathname() ?? "/";
  const { resolvedTheme, setTheme } = useTheme();
  const { openPalette, openShortcuts } = useShell();
  const mac = useIsMac();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* private mode: ignore */
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const dark = mounted && resolvedTheme === "dark";
  const modKey = mac ? "⌘K" : "Ctrl K";

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-svh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-150",
        collapsed ? "w-14" : "w-56",
      )}
      aria-label="Main navigation"
    >
      <div className={cn("flex h-12 items-center gap-2 border-b px-3", collapsed && "justify-center px-0")}>
        <AppMark className="size-6" />
        {!collapsed && <span className="truncate text-sm font-semibold">Gunnebo PM</span>}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Screens">
        <WithTooltip collapsed={collapsed} label={`Search (${modKey})`}>
          <button
            type="button"
            onClick={openPalette}
            aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
            className={cn(
              ITEM,
              "mb-2 border border-sidebar-border bg-background/60 text-muted-foreground dark:bg-background/20",
              collapsed && "justify-center px-0",
            )}
          >
            <Search className="size-4 shrink-0" aria-hidden />
            {collapsed ? (
              <span className="sr-only">Search</span>
            ) : (
              <>
                <span className="flex-1 text-left">Search…</span>
                <Kbd>{modKey}</Kbd>
              </>
            )}
          </button>
        </WithTooltip>
        {MAIN_NAV.map((item) => (
          <NavLink key={item.href} {...item} collapsed={collapsed} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        <div className="mb-1.5 empty:hidden">
          <BackupReminder status={backup} collapsed={collapsed} />
        </div>
        {FOOTER_NAV.map((item) => (
          <NavLink key={item.href} {...item} collapsed={collapsed} active={isActive(item.href)} />
        ))}
        <WithTooltip collapsed={collapsed} label={dark ? "Light mode" : "Dark mode"}>
          <button
            type="button"
            onClick={() => setTheme(dark ? "light" : "dark")}
            className={cn(ITEM, collapsed && "justify-center px-0")}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? <Sun className="size-4 shrink-0" aria-hidden /> : <Moon className="size-4 shrink-0" aria-hidden />}
            {!collapsed && <span>{dark ? "Light mode" : "Dark mode"}</span>}
          </button>
        </WithTooltip>
        <WithTooltip collapsed={collapsed} label="Keyboard shortcuts (?)">
          <button type="button" onClick={openShortcuts} aria-keyshortcuts="?" className={cn(ITEM, collapsed && "justify-center px-0")}>
            <Keyboard className="size-4 shrink-0" aria-hidden />
            {collapsed ? (
              <span className="sr-only">Keyboard shortcuts</span>
            ) : (
              <>
                <span className="flex-1 text-left">Shortcuts</span>
                <Kbd>?</Kbd>
              </>
            )}
          </button>
        </WithTooltip>
        <form action={logout}>
          <WithTooltip collapsed={collapsed} label="Sign out">
            <button type="submit" className={cn(ITEM, collapsed && "justify-center px-0")}>
              <LogOut className="size-4 shrink-0" aria-hidden />
              {collapsed ? <span className="sr-only">Sign out</span> : <span>Sign out</span>}
            </button>
          </WithTooltip>
        </form>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(ITEM, "text-xs text-muted-foreground", collapsed && "justify-center px-0")}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4 shrink-0" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4 shrink-0" aria-hidden />
          )}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
