# UI build guide

Screens follow `DESIGN.md` section 5 (and the canvas/keyboard amendments in section 12). This file fixes the shared
building blocks so every screen looks and behaves the same.

## Rules

- Server Components load data through `src/server/queries/*`; Client Components never import `src/server/**`.
- Mutations are Server Actions in `src/app/(app)/<route>/actions.ts`. Each action: `requireUser()` → zod-parse input →
  build `Ctx` (opId comes from the client) → call a service → `updateTag(...)` when library/template/project-fields/settings
  changed → return `{ ok: true, data } | { ok: false, error, code }`. Never throw raw errors to the client.
- Optimistic UI: apply the change locally, send through the **per-project write queue** (`src/lib/write-queue.ts`:
  one in-flight write per project key, FIFO), roll back with a toast on error. A `401 session` response shows
  "Session expired. Sign in again" and keeps the queued change.
- Long operations use `src/lib/run-job.ts`: call `start…` once, then `continue…` until `done`, show
  `<ProgressDialog>`; retry with backoff on BUSY (max 5), stop with a plain message after that; on
  "Failed to find Server Action" reload the page and resume (the job id is in the URL `?job=`).
- Dense layout: 13–14 px base text, 32 px table rows, 48 px headers. Light by default, dark via the sidebar toggle.
- Keyboard: `src/lib/hotkeys.ts` `useHotkeys(map)` ignores events with meta/ctrl/alt (unless declared), while typing in
  inputs/textarea/contenteditable, and during IME composition (`e.isComposing`). `?` shows the shortcut overlay.
- Accessibility: every state is shown by colour AND icon AND text (tooltip / sr-only).

## Shared components (`src/components/**`)

| Component | Purpose |
|---|---|
| `state/state-badge.tsx` `StateBadge`, `StateDot`, `StateIcon`, `StateLegend` | `state-*` CSS classes from `globals.css`; icons: NS Circle, IP CircleDot, W Clock, B OctagonAlert, D CircleCheck, NA MinusCircle |
| `flow/node-card.tsx` `NodeCard` | Fixed 184×56. 4 px left stripe `var(--s-solid)`, bg `var(--s-bg)`, 1 px border `var(--s-border)`. Line 1: state icon + name (12 px medium, 2-line clamp at full zoom). Line 2: value (11 px, tabular). Top-right indicators: note count, file count, `P` project-only, flag pin, clock (DATE_PASSED_AUTO), `!` invalid/unknown choice. PERCENT: 2 px progress track at the bottom. Current: 2 px `--current-ring`. Selected: foreground outline. N/A: 50 % opacity, dashed border, no stripe. Semantic zoom via a zoom-bucket selector: full ≥ 0.45; compact 0.3–0.45 (name 1 line + value line, larger text, no indicators); overview < 0.3 (solid block with sequence number). Template mode: neutral colours, field-type icon and "Dropdown · 5 choices". |
| `flow/flow-canvas.tsx` `FlowCanvas` | React Flow 12 wrapper: `nodeTypes` defined at module level, `onlyRenderVisibleElements`, MiniMap (state colours in projects, neutral in template), Controls, dotted Background, smoothstep edges with closed arrowheads (green 60 % when source Done; dashed when touching N/A). Props: mode `template` / `project`, `editArrows` (handles + hover × + Backspace/Delete; otherwise `deleteKeyCode={null}` and no connections), `isValidConnection` using domain `wouldCreateCycle` (toast "That arrow would create a loop"), `onMoveEnd` debounced 300 ms batched positions, `onConnect`, `onEdgesDelete`, `onNodeClick`, `onPaneDoubleClick`, `focusNodeId`, `fitTo: 'current' | 'all'`, colour mode from next-themes. |
| `fields/value-editor.tsx` `ValueEditor` | Right input per field type, commits immediately (`onCommit(value)`): Dropdown = vertical pills with state dots, keys 1–9, Clear; Multiple = toggle chips with All / Clear and "n of 9" (coalesced 400 ms); Date = text input (domain `parseDateInput`, shows resolved full date) + calendar popover (react-day-picker via shadcn Calendar; convert with `toYmdLocal`/`fromYmdLocal`, pass server `today`) + Today / +1 week / Clear; Date range = two of those; Percent = slider step 5 + number input + 0/25/50/75/100; Number = input + unit; Text = input (Enter/blur); Long text = autosize textarea (blur / Cmd+Enter); Checkbox = switch; Link = URL input + Open ↗; File = attachments list. Helper line shows `describeReason`. |
| `fields/value-text.tsx` | Read-only display via domain `formatValue` |
| `library/definition-editor.tsx` `DefinitionEditor` | Name, description, field type select, choices editor (add, rename inline, drag reorder with dnd-kit + Alt+↑/↓, state pills NS IP W B D NA, archive / "Show archived" restore, "Copy choices from…", "Also apply to…" when other milestones share the list), unit for Number, read-only key ("ID for automations"). Used by Library, Template Flow and project-only steps. `onSave(patch)` per committed change. |
| `shell/side-panel.tsx` `SidePanel` | Right docked panel, 400 px default, drag-resizable 320–560 px (remembered in localStorage), Esc closes, non-modal; overlays below 1280 px wide. |
| `common/confirm-dialog.tsx`, `common/progress-dialog.tsx`, `common/empty-state.tsx` | |

## Screens

| Route | Owner notes |
|---|---|
| `/setup` | Storage status, "Create databases" and "Load the 64 milestones" with progress, plain-English problems with the fix. Redirect here from every screen when `schemaReady` or `seeded` is false. |
| `/library` | Tabs Milestones / Project fields. Dense table (drag handle, #, name inline, type select, choices preview with state dots `+n`, description, used in n projects, ⋯ menu). Row click → `SidePanel` + `DefinitionEditor`. `+ Milestone`, search, type filter. Note: "Changes apply to new projects. Existing projects update when you Sync them." Archive → toast with Undo. |
| `/template` | `FlowCanvas` template mode, toolbar: `+ Milestone` [N], Auto-layout ▾ [L] (Left→Right, Wrapped), Fit [F], Export JSON, Import JSON (preview dialog), Sync all projects. Side panel: `DefinitionEditor` + "Comes after / Leads to" pickers. Delete node = archive with "Reconnect neighbours" (default on) + Undo toast. Info strip lists unconnected nodes. |
| `/projects` | Table: Code, Name, summary fields, Status, % done, first current milestone, Updated. Search + status chips. New project [C] dialog → creation job with progress → opens the project. |
| `/projects/[id]` | Header (code badge, name, status pill, type pill, summary line, stacked state bar + "34 / 58 done · 58 %", counts, "Current:" chips, template-changed banner, ⋯: Edit details, Export to Excel, Sync from template…, Archive). Tabs Flow [V] / List / History [H]. Flow toolbar: Fit [F], Go to current [C], Auto-layout [L], Edit arrows [E], + Project step, Legend. Opening viewport: `?node=` centres that node and opens its panel; else fit current milestones; else fit all. Step side panel: header (state, name, badge From template / Project-only / Not in template, Comes after list, J/K prev/next, Esc), `ValueEditor`, N/A switch [X], Flag (None / Waiting / Blocked + reason), Notes (Cmd+Enter), Links & files (+ Link, + File ≤ 4 MB, drop zone), History (last 5 + Show all), footer "Last changed 2d ago · ID … (copy)". List view: 32 px rows in flow order, columns #, State, Milestone, Value (inline), Last changed, Latest note, counts; filters All / Current / Open / Blocked / Waiting / Done + Hide N/A; multi-select + Mark not applicable. History view: paged, filters. |
| `/portfolio` | Filters in the URL (status multi default Active, customer, project type, search). Grid: sticky left block (code, name + customer, % mini bar), vertical numbered headers with tooltips, 20×20 cells (`state-*`), N/A dashed, current = violet dot, missing = hatched, "Other" column. One delegated tooltip. Cells are links to `/projects/[id]?node=…`. Arrow keys move focus, Enter opens. "My open items" panel [O]: In progress + Blocked, chips "+ Waiting", "Include date-driven items", sorted by stateChangedAt ascending; row = dot · code · milestone · value · age (amber ≥ 14 d, red ≥ 30 d) · latest note. |
| `/archive` | Tabs Projects, Milestones, Project steps, Notes & files, Project fields. Each row: context, archived date, Restore. |
| `/settings` | Display name, time zone, Download full backup (+ last backup time), Verify history, Repair mirrors, Reload from Notion, Reset template to seed, Start over (type RESET), Sign out everywhere, Notion connection status. |

## Command palette
⌘K / Ctrl+K: projects, milestones of the current project, actions (New project, Export, Sync, Backup, Toggle theme).

## Infrastructure that already exists (use it, don't rebuild it)

- **Server Actions:** wrap every action body in `runAction(opId, (ctx) => service(ctx, …), { tags })` from
  `@/server/actions/run` (sign-in check, context with Singapore "today", cache tag refresh, plain-English
  `ActionResult`). Read-only lazy loads use `runQuery(() => …)`. Never throw from an action.
- **One opId per user action**, created in the browser with `newOpId()` (`@/lib/write-queue`). If a write fails with
  a network error or BUSY, retry it **with the same opId** (services are idempotent per opId; History may already
  hold the row). Writes to one project go through `enqueue(projectId, task)`.
- **Long jobs** (create project, sync, import/seed/reset, bulk N/A > 16, repair mirrors, backup paging, verify
  history): `runJob(() => continueAction(opId))` from `@/lib/run-job` with `<ProgressDialog>`.
- **Guard:** pages that read project/library data call `await requireReadyStorage()` (`@/server/guards`) first;
  it redirects to /setup until the databases exist and the milestones are loaded. /setup itself must not call it.
- **Queries** (screen data, already tested): `@/server/queries` (see `docs/API.md` and the DTO types exported by
  `src/server/queries/*.ts`). The project page should call `scheduleReconcile(id)` after loading.
- **Business functions:** `@/server/services` (see `docs/API.md`).
- **Components:** `NodeCard`/`NODE_TYPES` and `FlowCanvas`/`FlowProvider`/`useFlowControls`
  (`src/components/flow`), `ValueEditor` + `DateField` (`src/components/fields/value-editor.tsx`),
  `DefinitionEditor` (`src/components/library/definition-editor.tsx`), `StateBadge`/`StateDot`/`StateIcon`/
  `StateLegend`/`stateClass` (`src/components/state/state-badge.tsx`), `SidePanel`, `PageHeader`, `ConfirmDialog`,
  `ProgressDialog`, `EmptyState`, `useHotkeys`, shadcn/ui in `src/components/ui`.
- **Local data for trying screens:** `npx tsx --conditions=react-server scripts/dev-seed.ts --file <json> --demo`
  creates the schema, the 64 milestones and 4 demo projects in a fake-Notion file. Run the app against it with
  `APP_PASSWORD="local dev password 1234" FAKE_NOTION_FILE=<json> npx next dev -p <port>` and sign in with that password.
  Chromium + Playwright are installed (`require('playwright')`, `chromium.launch()`), so you can drive and
  screenshot the page yourself to check it works.
