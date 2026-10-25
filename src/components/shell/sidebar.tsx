"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Archive,
  FolderKanban,
  LayoutGrid,
  Library,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppMark } from "./app-mark";
import { logout } from "@/app/login/actions";

const MAIN_NAV = [
  { href: "/portfolio", label: "Portfolio", icon: LayoutGrid, key: "1" },
  { href: "/projects", label: "Projects", icon: FolderKanban, key: "2" },
  { href: "/library", label: "Milestone Library", icon: Library, key: "3" },
  { href: "/template", label: "Template Flow", icon: Workflow, key: "4" },
];

const FOOTER_NAV = [
  { href: "/archive", label: "Archive", icon: Archive },
  { href: "/settings", label: "Settings", icon: Settings },
];

const STORAGE_KEY = "gpm.sidebar.collapsed";

function NavLink({
  href,
  label,
  icon: Icon,
  collapsed,
  active,
}: {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  collapsed: boolean;
  active: boolean;
}) {
  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? <span className="sr-only">{label}</span> : <span className="truncate">{label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ storageLabel }: { storageLabel?: string }) {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
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

      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {MAIN_NAV.map((item) => (
          <NavLink key={item.href} {...item} collapsed={collapsed} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        {FOOTER_NAV.map((item) => (
          <NavLink key={item.href} {...item} collapsed={collapsed} active={isActive(item.href)} />
        ))}
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent",
            collapsed && "justify-center px-0",
          )}
          aria-label="Toggle dark mode"
        >
          {mounted && resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {!collapsed && <span>{mounted && resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</span>}
        </button>
        <form action={logout}>
          <button
            type="submit"
            className={cn(
              "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent",
              collapsed && "justify-center px-0",
            )}
          >
            <LogOut className="size-4" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </form>
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent",
            collapsed && "justify-center px-0",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && <span>{storageLabel ?? "Collapse"}</span>}
        </button>
      </div>
    </aside>
  );
}
