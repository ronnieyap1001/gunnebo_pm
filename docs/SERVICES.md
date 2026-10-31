# Services and queries (business layer)

Services hold every business rule. Screens (Server Actions) and later automations (Phase 2 email worker) call them;
nothing else writes to storage. They depend only on `src/domain/**` and the `Repo` contract in `src/server/repo/types.ts`.

## Conventions

```ts
// src/server/services/context.ts
export interface Ctx {
  actor: string;                 // display name ("Me" until Microsoft sign-in)
  source: EventSource;           // 'MANUAL' from the UI, 'SYSTEM' for sync/import/reconcile, 'EMAIL' in Phase 2
  opId: string;                  // one UUID per user action; created in the browser and passed through
  now: Iso;                      // single timestamp for the whole action
  day: DayContext;               // { today, timeZone } from Settings 'app.timezone' (default 'Asia/Singapore')
  correlationId?: string;        // defaults to opId
  externalRef?: string;          // Phase 2 (email message id)
  repo: Repo;                    // injected so tests run on the fake
}
export class AppError extends Error { code: 'VALIDATION'|'NOT_FOUND'|'CONFLICT'|'CODE_TAKEN'|'CYCLE'|'BUSY'|'BLOCK_LIMIT'|'STALE_PLAN'|'FORBIDDEN'; }
```

- Every mutation: validate input (zod / `normalizeValue`) → read current → check → write state → update project
  cells/progress mirrors when a step changed → append History (one row per user action; a row may relate to many
  steps; per-step detail goes in `data`). Throw `AppError` with a plain-English message for anything the user can fix.
- Idempotency: a step whose `lastOp === ctx.opId` was already written by this op → skip the write and return current
  state. `history.hasOp(opId)` → skip appending again. Creation batches skip rows whose `stepKey` exists.
- Never hard-delete. Archive = `archived: true, archivedAt, archiveBatch`.
- History `summary` examples: `C0822 · Customer PO / LOI: Awaiting → Full PO`, `C0822 · Note on BOM: "Waiting for PE…"`,
  `Library · Renamed "BOM" to "Bill of materials"`, `C0822 · Synced from template (3 changes)`.
- History `data` always includes `{ stepName?, milestoneKey?, old?: ValueSnapshot, new?: ValueSnapshot }` where relevant.

## Template and library (`library.ts`)

Template = milestones (Repo) + Settings `template.flow` (Flow keyed by milestone id) + Settings `template.revision`.

- `getTemplate(repo)` → `Template` (archived milestones included; callers filter).
- `createMilestone(ctx, { name, fieldType, description?, choices?, afterMilestoneId?, position? })`:
  key = `slugify(name, all keys incl. archived)`; order = after.order + 0.5 (else max + 1);
  adds a flow node (position given, or below the lowest node); with `afterMilestoneId` uses `insertAfterInFlow`;
  revision + 1; History `milestone.created`.
- `updateMilestone(ctx, id, patch: { name?, description?, fieldType?, choices?, config? })`: validates choices
  (unique ids, DROPDOWN choices need a state, labels non-empty); new choices get `slugify(label, existing ids incl. archived)`;
  choices are never removed (UI sends archived: true). Revision + 1. History `milestone.updated` with old/new.
- `applyChoicesTo(ctx, sourceId, targetIds[])` ("Also apply to 55–58"): copies labels/states by matching id; new ids minted
  when an id collides with an archived one in the target.
- `reorderMilestone(ctx, id, { beforeId?, afterId? })`: fractional order between neighbours; no revision bump.
- `archiveMilestone(ctx, id, { reconnect = true })` → `{ batchId }`: archive page + `archiveNodeInFlow`; revision + 1.
- `restoreBatch(ctx, batchId)`: un-archive milestones with that batch + `restoreBatchInFlow`; revision + 1.
- Flow ops (Settings `template.flow` read-modify-write): `moveTemplateNodes(ctx, positions)` (no history/revision),
  `addTemplateEdge(ctx, from, to)` (AppError CYCLE / DUPLICATE), `archiveTemplateEdge(ctx, edgeId)` (reason USER),
  `layoutTemplate(ctx, { wrap, viewportWidth })`. Edge changes bump the revision and write History.

## Project fields (`projectFields.ts`)

- `createProjectField`, `updateProjectField` (type change only via `convertValue` for every project's value; else
  AppError naming the blocking projects), `archiveProjectField` / `restoreProjectField` (system fields cannot be
  archived). When a Customer / Project type choice is added, the Notion select mirror gets the option (repo handles it).

## Projects (`projects.ts`)

- `startCreateProject(ctx, { code, name, status, details })` → `{ projectId, total }`: code trimmed + upper-cased,
  `^[A-Z0-9][A-Z0-9-]{1,19}$`, unique incl. archived (AppError CODE_TAKEN: "C0822 is used by an archived project.
  Restore it from the Archive"). Details normalised per field. Creates the Project row (`setup: 'CREATING'`, flow =
  snapshot flow keyed by temp ids, cells {}), stores job `job:<opId>` = `{ kind: 'createProject', projectId, drafts }`.
- `continueCreateProject(ctx, opId)` → `{ done, created, total }`: creates up to 8 missing steps per call
  (stepKey = `<projectId>:<tempId>`); when all exist: remap flow, build cells, set `setup: 'READY'`, progress,
  History `project.created` `{ revision, nodeCount, edgeCount }`, clear the job.
- `updateProject(ctx, id, patch: { code?, name?, status?, details? })`: History `project.updated` listing changed fields
  (old → new display). If the "Project closed" step has a date ≤ today and status ≠ CLOSED, the UI prompts.
- `archiveProject` / `restoreProject`.
- `reconcileProject(ctx, projectId)`: recompute cells/progress/current from all steps (+ attachment counts) and
  PATCH the project only when different. Called after the project page renders (`after()`), and by "Repair mirrors".

## Steps (`steps.ts`)

- `setStepValue(ctx, { stepId, value, expectedRev })` → `{ step, project: { progress, cells } }`:
  normalise; a retired (archived) choice may be kept but not newly chosen; no-op when equal; old/new ValueSnapshot;
  if the new value-derived state is DONE or NOT_APPLICABLE and a flag is set → clear the flag (History notes it);
  `valueSetAt = now`, `lastChangedAt = now`, `stateChangedAt = now` when the derived state changed; rev + 1;
  lastOp = opId. Then update the project's cell (read project → replace one cell → write) and append History
  `step.value_changed`. `expectedRev` mismatch → AppError CONFLICT ("This milestone changed elsewhere; reloaded").
- `setStepNotApplicable(ctx, { stepId, notApplicable, expectedRev })`, `setStepFlag(ctx, { stepId, flag, reason? })`
  (reason saved as a note), `confirmStepDate(ctx, stepId)` (sets valueSetAt = now, clears the clock marker).
- `bulkSetNotApplicable(ctx, { projectId, stepIds (≤ 16 per call), notApplicable })`: one Steps query, N patches,
  one project patch, ONE History row relating to all steps.
- Project-only steps: `addProjectStep(ctx, { projectId, name, fieldType, afterStepId?, position? })`,
  `updateStepDefinition(ctx, stepId, patch)` (template-derived steps: FORBIDDEN), `archiveProjectStep(ctx, stepId,
  { reconnect })` → batchId (template-derived: FORBIDDEN, suggest N/A), `restoreProjectBatch(ctx, projectId, batchId)`.
- Project flow (Project `Flow` read-modify-write): `moveProjectNodes`, `addProjectEdge`, `archiveProjectEdge`
  (reason USER), `layoutProject`. Arrow changes write History (`edge.added` / `edge.archived`).

## Notes and attachments (`notes.ts`, `attachments.ts`)

- `addNote`, `editNote` (History old → new), `archiveNote`, `restoreNote`.
- `addLink(ctx, { projectId, stepId?, name?, url })` (http/https only; name defaults to host), `addFile` (called by
  the upload route), `archiveAttachment`, `restoreAttachment`. FILE-type steps: update the cell's `fc`.
- History rows `note.added`, `note.edited`, `note.archived`, `attachment.added`, `attachment.archived`.

## Sync (`sync.ts`)

- `previewSync(ctx, projectId)` → `SyncPlan` (+ template revision).
- `startSync(ctx, { projectId, selectedIds })`: `applySync` (STALE_PLAN → AppError, UI reopens preview); store job
  `{ kind: 'sync', projectId, result, unselected: { itemId: hash } }`.
- `continueSync(ctx, opId)`: create new steps (≤ 8/call, idempotent), apply step patches (≤ 8/call, skip when
  lastOp === opId), then finalize: remap flow, rebuild cells from fresh steps, set `templateRevision`, merge
  unselected items into `syncDismissed`, ONE History row `project.synced` (data: summary + item ids), clear the job.
- `syncAllActive` is driven by the browser: for each active project, `previewSync` → `startSync(defaultChecked ids)`
  → `continueSync` until done.

## Template file, seed, reset, backup (`templateFile.ts`, `admin.ts`)

- `exportTemplate(repo)` → `TemplateFile`. `previewImport(ctx, file)` → `ImportPlan.summary`.
- `startImport(ctx, file, { reason: 'import'|'seed'|'reset' })`: first append History `template.snapshot`
  (data = current export) unless seeding an empty library; store job with the plan.
- `continueImport(ctx, opId)`: creates (≤ 8/call), updates, archives, project fields; then save remapped flow,
  revision + 1, History `template.imported` (or `template.seeded`), Settings `seed.appliedAt` when seeding.
- `startOver(ctx)`: `admin.trashAll()` + `resetCaches()` (UI requires typing RESET and offers a backup first).
- Backup: browser pages through `admin.exportPage(db, cursor)` per database and builds one JSON file;
  Settings `backup.lastAt` is recorded.
- `verifyHistoryPage(ctx, cursor)` → recomputes row hashes, returns mismatches. `repairMirrors` = reconcile each project.

## Queries (`src/server/queries/*.ts`, Next-specific)

Read models for screens. They return plain serialisable DTOs with derived state (computed with `ctx.day`).
Library, template and project fields are cached with `unstable_cache(..., { tags: ['library'] | ['project-fields'] |
['settings'], revalidate: 60 })`; Server Actions call `updateTag(tag)` after writes. Projects are never cached.

- `getLibraryView()`, `getTemplateView()`, `getProjectsList()`, `getProjectPageData(id)` (project, steps with state/
  display/isCurrent, flow, notes per step (latest + count), attachment counts, progress, counts per state, current ids,
  pending sync count, detail fields), `getPortfolioData(filters)` (columns = active template milestones in flow order;
  rows = projects; cells → state/short value/stepId; "Other" column; open items), `getArchiveData()`,
  `getStepHistory(stepId, cursor)`, `getProjectHistory(projectId, filters, cursor)`, `getSetupStatus()`.
