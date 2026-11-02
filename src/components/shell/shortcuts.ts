/**
 * Every keyboard shortcut of the app, per screen (DESIGN.md section 5 "Keyboard" and section 12, UI.md). Shown by the
 * "?" overlay; the screen the user is on is listed first.
 */
export interface ShortcutRow {
  /** Key groups: each inner array is pressed together ("mod" = ⌘ on Mac, Ctrl elsewhere); groups are alternatives or a sequence. */
  keys: string[][];
  /** "then" for key sequences (G then P), "or" for alternatives (J or ↓). */
  join?: "then" | "or";
  what: string;
}

export interface ShortcutSection {
  id: string;
  title: string;
  /** Path prefix of the screen (null = everywhere). */
  path: string | null;
  rows: ShortcutRow[];
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    id: "global",
    title: "Everywhere",
    path: null,
    rows: [
      { keys: [["mod", "K"]], what: "Command palette: jump to a project, a screen or an action" },
      { keys: [["?"]], what: "Show these shortcuts" },
      { keys: [["/"]], what: "Search on this screen" },
      { keys: [["G"], ["P"]], join: "then", what: "Go to Portfolio" },
      { keys: [["G"], ["R"]], join: "then", what: "Go to Projects" },
      { keys: [["G"], ["L"]], join: "then", what: "Go to Milestone Library" },
      { keys: [["G"], ["T"]], join: "then", what: "Go to Template Flow" },
      { keys: [["G"], ["A"]], join: "then", what: "Go to Archive" },
      { keys: [["G"], ["S"]], join: "then", what: "Go to Settings" },
      { keys: [["Esc"]], what: "Close a dialog, menu or side panel" },
    ],
  },
  {
    id: "portfolio",
    title: "Portfolio",
    path: "/portfolio",
    rows: [
      { keys: [["←"], ["↑"], ["↓"], ["→"]], what: "Move between cells" },
      { keys: [["Home"], ["End"]], what: "First / last cell of the row" },
      { keys: [["Enter"]], what: "Open that milestone in its project" },
      { keys: [["O"]], what: "Show or hide My open items" },
      { keys: [["/"]], what: "Search projects by code or name" },
    ],
  },
  {
    id: "projects",
    title: "Projects",
    path: "/projects",
    rows: [
      { keys: [["C"]], what: "New project" },
      { keys: [["/"]], what: "Search code, name or customer" },
      { keys: [["↑"], ["↓"]], what: "Move between rows" },
      { keys: [["Enter"]], what: "Open the project" },
    ],
  },
  {
    id: "project",
    title: "Project: Flow",
    path: "/projects/",
    rows: [
      { keys: [["V"]], what: "Switch between Flow and List" },
      { keys: [["H"]], what: "History" },
      { keys: [["F"]], what: "Fit the whole chart" },
      { keys: [["C"]], what: "Go to the current milestones" },
      { keys: [["L"]], what: "Auto-layout" },
      { keys: [["E"]], what: "Edit arrows for this project" },
      { keys: [["J"], ["K"]], what: "Previous / next milestone (side panel open)" },
      { keys: [["1–9"]], what: "Pick a dropdown choice" },
      { keys: [["X"]], what: "Mark not applicable" },
      { keys: [["N"]], what: "Add a note" },
      { keys: [["mod", "Enter"]], what: "Save the note or long text" },
      { keys: [["Esc"]], what: "Close the side panel" },
    ],
  },
  {
    id: "project-list",
    title: "Project: List",
    path: "/projects/",
    rows: [
      { keys: [["↑"], ["↓"]], join: "or", what: "Move between rows (also J / K)" },
      { keys: [["Enter"]], what: "Edit the value" },
      { keys: [["Tab"]], what: "Next row's value" },
      { keys: [["Esc"]], what: "Cancel the edit" },
      { keys: [["X"]], what: "Mark not applicable" },
      { keys: [["N"]], what: "Add a note" },
      { keys: [["O"]], what: "Open the side panel" },
    ],
  },
  {
    id: "template",
    title: "Template Flow",
    path: "/template",
    rows: [
      { keys: [["N"]], what: "New milestone" },
      { keys: [["L"]], what: "Auto-layout menu" },
      { keys: [["F"]], what: "Fit the whole chart" },
      { keys: [["Delete"], ["⌫"]], join: "or", what: "Archive the selected milestone or delete the selected arrow" },
      { keys: [["←"], ["↑"], ["↓"], ["→"]], what: "Nudge the selected milestone" },
      { keys: [["Shift", "drag"]], what: "Select several milestones" },
      { keys: [["Esc"]], what: "Close the panel" },
    ],
  },
  {
    id: "library",
    title: "Milestone Library",
    path: "/library",
    rows: [
      { keys: [["N"]], what: "New milestone or project field" },
      { keys: [["/"]], what: "Search the list" },
      { keys: [["J"], ["K"]], what: "Next / previous row" },
      {
        keys: [
          ["Alt", "↑"],
          ["Alt", "↓"],
        ],
        what: "Move the row up / down",
      },
      { keys: [["Esc"]], what: "Close the panel" },
    ],
  },
  {
    id: "archive",
    title: "Archive",
    path: "/archive",
    rows: [{ keys: [["1–5"]], what: "Switch tabs" }],
  },
];

/** True when the section belongs to the screen at `pathname`. */
export function isCurrentSection(s: ShortcutSection, pathname: string): boolean {
  if (!s.path) return false;
  if (s.path === "/projects/") return /^\/projects\/[^/]+/.test(pathname);
  if (s.path === "/projects") return pathname === "/projects";
  return pathname === s.path || pathname.startsWith(s.path + "/");
}

/** Sections with the current screen's first (after "Everywhere"). */
export function sectionsFor(pathname: string): ShortcutSection[] {
  const global = SHORTCUT_SECTIONS.filter((s) => !s.path);
  const here = SHORTCUT_SECTIONS.filter((s) => isCurrentSection(s, pathname));
  const rest = SHORTCUT_SECTIONS.filter((s) => s.path && !isCurrentSection(s, pathname));
  return [...global, ...here, ...rest];
}
