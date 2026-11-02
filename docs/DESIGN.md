> Developer reference for Phase 1. You do not need to read this; the short plan is in the chat. Section 12 (review amendments) overrides earlier sections where they differ.

# Gunnebo PM: Phase 1 technical design

## 0. Summary for the user (plain words, for the "wait for my OK" step)

- **What it is.** A local web app that runs on your Mac. You start it with `npm install` once and then `npm run dev`, and open http://localhost:3000. All data lives in one `data/` folder, which is never uploaded to GitHub.
- **Milestone Library and Template Flow.** These are two views of the same master list: a table, and a flow chart you reshape with arrows. The seed is your 64 milestones as one chain.
- **New projects.** A new project copies the template. After that the project is its own copy. You can mark steps Not applicable, add project-only steps and re-route arrows. Template changes reach a project only when you press **Sync from template**. Sync shows a preview first and never deletes anything.
- **Node colours.** A node's colour always comes from its value, using your state tags. A small Waiting/Blocked flag lets date, number or text steps go amber or red.
- **History.** Every change is written to a permanent history: old → new, who, and when (Singapore time). Delete always means archive, so anything can be restored.
- **Build order.** 12 small steps. After each one you get screenshots in chat, plus a "pull, run, open this URL, try this" checklist.

---

## 1. Tech stack (exact pins) and changes from the brief

Every version is pinned exactly (`.npmrc` `save-exact=true`) and `package-lock.json` is committed. Run `npm audit signatures` after each install.

| Package | Version | Note |
|---|---|---|
| next | 16.4.3 | Published 2026-10-23. Fall back to 16.4.2 if the step-1 smoke test misbehaves. App Router, Turbopack. |
| react, react-dom | 19.3.1 | |
| typescript | **6.0.3** | npm `latest` is 7.0.2 (the native Go port). Next's build-time type check relies on the JS compiler API. |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | |
| shadcn CLI | 4.22.1 | Run as `npx shadcn@4.22.1`. Not a dependency. Components: button, input, textarea, select, checkbox, switch, slider, popover, calendar, command, dialog, sheet, alert-dialog, table, tabs, badge, tooltip, dropdown-menu, context-menu, toggle-group, scroll-area, sonner. Whatever versions shadcn adds (radix, lucide-react, cmdk, react-day-picker, sonner) are then pinned exactly. |
| @xyflow/react | 12.12.0 | |
| @dagrejs/dagre | **3.1.1** | 3.1.2 is one day old and nothing in it is needed. Sits behind `layoutGraph()`. |
| prisma (dev), @prisma/client, @prisma/adapter-better-sqlite3 | **7.10.1 exact** | Verified: the prisma `latest` tag is 8.0.0-rc.27. |
| better-sqlite3 | **12.11.1 exact** | Verified: the adapter depends on `^12.6.0`, so 13.0.3 would be a second, unused native build. 12.11.1 supports Node 20–26 and dedupes with the adapter. A direct dependency is needed for the backup script. |
| zod | 4.6.7 | The single validation layer. |
| next-themes | 0.4.6 | Class strategy, default **Light**. |
| write-excel-file | **4.1.1** | Replaces exceljs 4.4.0, which was published 2023-10 and depends on archiver@5 and unzipper@0.10 (deprecated sub-dependencies whose install warnings would alarm a non-developer). write-excel-file has one dependency (fflate) and supports multiple sheets, fills, date formats and column widths. Phase 1 only exports. |
| zustand | 5.0.16 | Client store for the canvas, list and panel. |
| date-fns | 4.4.0 | Parsing and formatting. |
| @dnd-kit/core, @dnd-kit/sortable | 6.3.1, 10.0.0 | Reordering library rows and choices, with a keyboard sensor. |
| dev: vitest | 5.0.5 | Engines `^22.12 \|\| ^24 \|\| >=26`. Uses the `forks` pool because of the native module. |
| dev: tsx | 4.23.15 | Runs the scripts. |
| dev: @playwright/test | **1.63.0** | Verified: 1.63.0 expects chromium-1243, which is preinstalled in /opt/pw-browsers; 1.64.1 expects 1248. Used only in the container and CI. The user never downloads browsers. |
| dev: @types/node 24.x, @types/react 19.3.0, @types/better-sqlite3 | pinned at install | |

**Not used:**
- elkjs: async and about 8 MB. dagre handles a left-to-right DAG of about 100 nodes. elkjs could later be lazy-loaded behind the same `layoutGraph()`.
- exceljs.
- dotenv: Node's `process.loadEnvFile()` is used inside a try block, and `.env` is optional.
- next/font/google: uses the system font stack instead, which works offline and behind a corporate proxy.
- `next lint`: removed in Next 16. Quality checks are `tsc --noEmit` plus tests, with an optional ESLint flat config.
- @tanstack/react-table and virtualization: not needed at this data size.

**Node:** `.nvmrc` = 24, and `engines` = `^22.12.0 || ^24.0.0`. The container runs 22.22 and CI covers 24. The README tells the user to install Node 24 LTS from nodejs.org.

## 2. Repository layout and runtime

```
prisma.config.ts            # Prisma 7 config; URL defaults to absolute file:<repo>/data/gunnebo-pm.db (no .env needed)
prisma/schema.prisma        # generator "prisma-client" -> ../src/generated/prisma ; datasource provider "sqlite" only
prisma/migrations/          # created by the developer only (migrate dev --create-only); triggers hand-appended
prisma/seed/template.v1.json
scripts/  prepare.ts doctor.ts backup.ts restore.ts reset.ts seed-demo.ts screenshot.ts
src/domain/      # PURE, no Prisma/Next: fieldTypes, values (zod), state, format, dates, graph (cycle, flowOrder, current,
                 # progress, bridge), layout (dagre), snapshot, syncPlan, templateFile
src/server/db/client.ts      # new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) }), cached on globalThis; PRAGMA foreign_keys=ON
src/server/auth/currentUser.ts  # requireUser() -> seeded local user
src/server/services/*        # all writes: fn(ctx, input), one transaction, writes Events
src/server/queries/*         # reads -> DTOs with derived state
src/server/files/fileStore.ts   # FileStore interface + LocalFileStore
src/app/(app)/...            # pages + thin actions.ts (defineAction(schema, handler))
src/app/api/...              # binary/file routes only
src/components/flow|grid|fields/
src/generated/prisma         # gitignored
```

**Rules:**
- `src/app` and `src/components` never import the Prisma client. A small vitest test greps the imports to enforce this.
- Pages that read the database render per request, with no `'use cache'`, because state depends on "today".

**Data folder (gitignored):** `data/gunnebo-pm.db` (with its `-wal` and `-shm` files), `data/uploads/` and `data/backups/`. The optional `BACKUP_DIR` setting points backups at another folder, such as OneDrive. Only copies go there; the live database stays local.

**npm scripts:**
- `postinstall`: `prisma generate`.
- `predev`: `tsx scripts/prepare.ts`.
- `dev`: `next dev -H 127.0.0.1 -p 3000`. It binds to loopback because there is no login and Next listens on all interfaces by default.
- `start`: optional faster daily mode. Runs prepare, then `next build`, then `next start -H 127.0.0.1`.
- `test`, `test:e2e`, `typecheck`, `doctor`.
- `backup`, `restore`, `reset:template`, `reset:all`.
- `seed:demo` and `screenshot`: for the developer only. They use `data/demo.db`.

**`prepare.ts` runs these steps in order:**
1. **doctor**:
   - Node major is 22 or 24. Otherwise it prints a plain message naming the installer.
   - better-sqlite3 opens an in-memory database. Otherwise it prints "run `xcode-select --install`, then `npm rebuild better-sqlite3`".
   - It warns if the repo path contains `OneDrive`, `Library/Mobile Documents` or `CloudStorage`.
   - It checks that `data/` is writable.
   - It refuses a non-loopback host unless `AUTH_ENABLED` is set.
2. Create `data/`, `data/uploads/` and `data/backups/`.
3. `prisma generate`. This is cheap insurance for a user who pulled but skipped `npm install`.
4. If the database exists and migrations are pending, take a backup.
5. `prisma migrate deploy`. The user's machine never runs `migrate dev`.
6. `PRAGMA journal_mode=WAL`.
7. If `AppSetting.seedAppliedAt` is missing, run the seed.
8. If the last automatic backup is more than 24 hours old, take one. Keep the newest 14 automatic backups.
9. Print "Open http://localhost:3000". The README adds: if the page doesn't load, use http://127.0.0.1:3000.

The scripts are plain TypeScript with no bash, so Windows also works.

## 3. Data model (Prisma, SQLite now, Postgres-ready)

**Shared rules:**
- Ids are `String @id @default(cuid())`, except `Event.id`.
- Foreign keys are `onDelete: Restrict` everywhere, because nothing is hard-deleted.
- Soft delete uses `archivedAt DateTime?`. Archiving one user action stamps a shared `archiveBatchId String?` on everything it archives.
- Only portable features are used: Json columns, Prisma enums (supported on SQLite since Prisma 6.2), and Int autoincrement.

**Enums**
- `FieldType`: TEXT, LONG_TEXT, NUMBER, PERCENT, DATE, DATE_RANGE, DROPDOWN, MULTIPLE, CHECKBOX, LINK, FILE
- `StateTag`: NOT_STARTED, IN_PROGRESS, WAITING, BLOCKED, DONE, NOT_APPLICABLE
- `ProjectStatus`: ACTIVE, ON_HOLD, CLOSED
- `NodeFlag`: WAITING, BLOCKED
- `AttachmentKind`: FILE, LINK
- `EventSource`: MANUAL, EMAIL, SYSTEM

**Choice JSON** (used by Milestone.choices, ProjectNode.choices and ProjectField.choices):
`[{ id, label, state?, archived? }]`
- **id**: a slug matching `^[a-z0-9_-]{1,64}$`, unique within its owner, never reused, and unchanged by renames.
- **state**: required for DROPDOWN choices on milestones and project nodes. Absent for MULTIPLE and for project fields.
- **archived**: hidden from new picks. In a project it is shown as "retired".
- Array order is display order.
- New ids are built from the label as a slug, with a numeric suffix if taken.

**Value JSON** (`ProjectNode.value` and `ProjectFieldValue.value`), with one zod schema per type:

| Type | Shape |
|---|---|
| TEXT, LONG_TEXT | `{text}` |
| NUMBER | `{number}`, optional `config.unit` |
| PERCENT | `{percent}`: integer 0–100 |
| DATE | `{date:'YYYY-MM-DD'}` |
| DATE_RANGE | `{start?, end?}`, start ≤ end |
| DROPDOWN | `{choiceId}` |
| MULTIPLE | `{choiceIds:[]}`, kept in choice order |
| CHECKBOX | `{checked:true}` |
| LINK | `{url, label?}`, http or https only |
| FILE | no value; derived from the node's active attachments |

Empty input is normalised to `null` on write: blank text after trimming, `[]`, unchecked, or both range ends empty. A dropdown starts as `null` (Not started), not as its first choice.

| Table | Key columns |
|---|---|
| **User** | id (seed `local`), name ("Me", editable in Settings), email? @unique, createdAt |
| **AppSetting** | key PK, value Json. Keys: `timezone`="Asia/Singapore", `seedAppliedAt`, `lastBackupAt` |
| **Milestone** (library entry) | id, **key @unique** (slug made at creation, never changed by renames, shown read-only as "ID for automations"), name, description?, fieldType, choices Json, config Json, sortOrder Float (library order and flow tie-break), createdAt, updatedAt, archivedAt?, archiveBatchId? |
| **FlowTemplate** | id, name ("Standard"), isDefault, **revision Int** (+1 on any definition or arrow change, import, add or archive; not on node moves or library reorder), createdAt, updatedAt |
| **TemplateNode** | id, templateId, milestoneId, posX, posY, archivedAt?, archiveBatchId?; `@@unique([templateId, milestoneId])`. Phase 1 has exactly one per active milestone |
| **TemplateEdge** | id, templateId, sourceNodeId, targetNodeId, createdAt, archivedAt?, archiveBatchId?; `@@unique([sourceNodeId, targetNodeId])`. Drawing an archived pair again restores the same row and id |
| **ProjectField** (configurable details) | id, key @unique, systemKey? @unique (customer, endUser, site, product, quantity, projectType, notes), label, fieldType, choices Json, config Json, sortOrder Float, showInSummary Bool (shown in project header and Projects table), createdAt, updatedAt, archivedAt? |
| **Project** | id (stable external reference), **code @unique** (trimmed and upper-cased; archived projects keep theirs reserved), name, status ProjectStatus, templateId, templateRevisionSynced Int, syncedAt?, createdAt, updatedAt, archivedAt? |
| **ProjectFieldValue** | id, projectId, fieldId, value Json?, updatedAt; `@@unique([projectId, fieldId])` |
| **ProjectNode** | id (stable; used in URLs `?node=` and by Phase 2), projectId, milestoneId? (null = project-only), name, description?, fieldType, choices Json (snapshot), config Json, value Json?, notApplicable Bool, flag NodeFlag?, sortOrder Float, posX, posY, valueSetAt? (value writes only), lastChangedAt? (value, N/A or flag writes), rev Int, createdAt, updatedAt, archivedAt?, archiveBatchId? (project-only nodes only); `@@unique([projectId, milestoneId])`, where NULLs are distinct in both SQLite and Postgres |
| **ProjectEdge** | id, projectId, sourceNodeId, targetNodeId, templateEdgeId? (null = drawn in this project), createdAt, archivedAt?, archiveBatchId?; `@@unique([sourceNodeId, targetNodeId])` |
| **Note** | id, projectId, nodeId? (null = project note), body, authorId, createdAt, updatedAt, archivedAt? |
| **Attachment** | id, projectId, nodeId?, kind, title, url? (LINK), storage String default 'local', storageKey? (relative path, never sent to the client), fileName?, mimeType?, sizeBytes?, sha256?, createdAt, archivedAt? |
| **Event** (append-only) | **id Int @default(autoincrement())** (strict order; usable as a worker cursor), recordedAt (default now), occurredAt (= now; email time in Phase 2), source, actorId?, projectId?, nodeId?, milestoneId?, entityType, entityId, type String, oldValue Json?, newValue Json? (each `{raw, display, state}`, so history stays readable after renames), payload Json? (nodeName and milestoneKey at that time, note text, sync summary…), correlationId?, externalRef?; `@@unique([source, externalRef])`, `@@index([projectId, id])`, `@@index([nodeId, id])` |

**Append-only enforcement.** The initial migration has hand-appended `BEFORE UPDATE` and `BEFORE DELETE` triggers on Event that `RAISE(ABORT)`. The service layer has no update or delete path for events. An integration test checks the triggers exist after `migrate deploy`, because a later Prisma SQLite "RedefineTables" migration on Event would silently drop them.

## 4. Key algorithms (all in `src/domain`, pure, unit-tested)

### 4.1 Dates and "today"
- Calendar dates are `'YYYY-MM-DD'` strings, compared as strings and never turned into Date objects.
- Instants are stored as UTC DateTime and shown in Singapore time as `24 Oct 2026, 14:05`.
- `todayIn(tz, now)` = `Intl.DateTimeFormat('en-CA', {timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit'}).format(now)`. The timezone comes from `AppSetting.timezone`.
- It is computed once per request on the server and passed into every domain function and to client components. The browser never uses `new Date()` for state.
- An open tab refreshes its data on window focus, so a tab left open past midnight recolours.
- Display format: `12 Nov 2026`.
- Typed entry is day-first: `12/11/2026`, `12 Nov`, `2026-11-12`, `t` or `today`, `+3d`, `+2w`, `-1d`.

### 4.2 `deriveState(node, {today, attachmentCount}) → {state, reason}`

State is never stored. Rules are checked in order and the first match wins:
1. `notApplicable` → NOT_APPLICABLE (reason NA_MARKED).
2. `flag` → WAITING or BLOCKED (reason FLAG).
3. Value fails zod → NOT_STARTED (INVALID_VALUE). The UI shows "Invalid value" and a warning is logged.
4. Value null (for FILE: attachmentCount = 0) → NOT_STARTED (EMPTY).
5. By field type:
   - **DROPDOWN**: the chosen choice's `state`, including retired choices. A NOT_APPLICABLE tag counts as N/A everywhere. An unknown id → NOT_STARTED (UNKNOWN_CHOICE, with a warning icon).
   - **DATE**:
     - `date > today` → IN_PROGRESS (DATE_PLANNED).
     - Otherwise DONE. The reason is DATE_PASSED_AUTO if the local date of `valueSetAt` is before `date` (a small clock icon: "turned green because the date passed"); otherwise DATE_REACHED.
   - **DATE_RANGE**:
     - `end` set and `end ≤ today` → DONE (RANGE_ENDED).
     - `start` set and `start > today` → IN_PROGRESS (RANGE_UPCOMING).
     - Otherwise → IN_PROGRESS (RANGE_RUNNING). This covers a running range, a start with no end, or an end alone in the future.
   - **PERCENT**: 0 → NOT_STARTED; 1–99 → IN_PROGRESS; 100 → DONE. Input is validated as an integer from 0 to 100.
   - **NUMBER** (not mapped in the brief): any finite number, including 0 → DONE.
   - **TEXT / LONG_TEXT / LINK / CHECKBOX / MULTIPLE** (one or more selected) → DONE.
   - **FILE**: one or more active attachments of either kind → DONE.

**Colours:**

| State | Colour | Icon (lucide) |
|---|---|---|
| Not started | grey (slate) | Circle |
| In progress | blue | CircleDot |
| Waiting | amber | Clock |
| Blocked | red | OctagonAlert |
| Done | green | CircleCheck |
| Not applicable | faded and dashed | MinusCircle |

The icons mean colour is not the only signal.

### 4.3 `formatValue` (value line, tooltips, Excel)

| Type | Shown as |
|---|---|
| Dropdown | The label; "(retired)" if archived |
| Multiple | `Packing list, MSDS +2` |
| Date | `12 Nov 2026`; future dates show `Plan 12 Nov 2026` |
| Date range | `1 Jan 2027 → 31 Dec 2028` |
| Percent | `60 %` |
| Number | `24 pcs`, using the unit |
| Text | The first 40 characters |
| Checkbox | `Yes` |
| Link | The host name |
| File | The file name, or `3 files` |
| Empty | A muted `—` |

### 4.4 Graph algorithms
The **active graph** is the nodes and edges with `archivedAt` null.

**`wouldCreateCycle(edges, s, t)`**
- Rule: true if `s === t`, or if `s` can be reached from `t` by a breadth-first search over active edges.
- Checked in five places:
  - React Flow `isValidConnection`: instant feedback, with the toast "That arrow would create a loop".
  - The server transaction: the check that counts.
  - Sync apply: the edge is skipped and reported.
  - Import: the file is rejected.
  - Restore: the edge is skipped.

**`addEdge`**
- Both ends must be active and in the same flow.
- Duplicates are refused.
- An archived edge with the same pair is restored, keeping its id and `templateEdgeId`.

**`flowOrder(nodes, edges)`**
- Kahn's topological sort. The ready set is a min-heap keyed on `(sortOrder, name, id)`.
- Leftover nodes (impossible, since cycles are blocked) are appended by sortOrder and a warning banner is shown.
- It drives the List view, J/K navigation, the Excel Milestones sheet, the sequence numbers in the zoomed-out view and, applied to the template, the Portfolio columns.

**sortOrder**
- A template-derived node copies `Milestone.sortOrder`, and sync refreshes it silently because it only breaks ties.
- A project-only node gets `X.sortOrder + 0.5` when created with "Insert after X", or `max + 1` otherwise.
- Library reorder renumbers `Milestone.sortOrder` from 1 to n and never touches arrows.

**Current milestones** (N/A nodes are see-through):
```
cleared(n) = state(n)==DONE || (state(n)==NA && every active predecessor p: cleared(p))   // memoised, visited-set guard
current(n) = state(n) ∉ {DONE, NA} && every active predecessor p: cleared(p)             // no predecessors ⇒ current while open
```
- A(open) → B(N/A) → C: C is **not** current.
- A(done) → B(N/A) → C: C is current.
- Results are sorted in flow order.

**Progress**
- `applicable` = active nodes whose state is not NA. `done` = nodes in DONE.
- `pct = applicable === 0 ? 0 : floor(100 × done / applicable)`.
- The header shows `34 / 58 done · 58 %`, plus a stacked bar with counts per state.
- Project-only nodes count; archived nodes don't.
- The Portfolio, the header and the Excel export all use the same function.

### 4.5 Insert, delete and restore nodes

**Insert after X** (node context menu, template or project):
1. Create node N.
2. Archive each `X→s` edge and add `N→s`.
3. Add `X→N`.

All of this happens in one transaction.

**Archive a node** (Delete key or menu) with "Reconnect neighbours", which is on by default. In one transaction:
1. Create a new `archiveBatchId`.
2. Archive the node (in the template, also its Milestone) and every active edge touching it, all stamped with that batch id.
3. If reconnect is on: for each predecessor p and successor s, add or restore `p→s` when it is missing and does not create a cycle. These are bridge edges. They are not part of the batch and stay after a restore.
4. Bump the template revision, if this is the template.
5. Write events with one correlationId.

The UI shows a toast "Archived 'BOM' · Undo" for 8 seconds.

**Restore a batch** (Undo, or the Archive page):
- Un-archive the batch's node, its milestone, and those edges whose two ends are active and that don't create a cycle.
- Report any skipped edges, e.g. "Restored with 2 arrows".

**Projects:**
- Only project-only nodes can be archived.
- Delete on a template-derived node offers "Mark Not applicable instead?".

### 4.6 Template → project copy
`buildProjectSnapshot(template)` is pure.
- For each active TemplateNode `tn` (milestone `m`), create a draft node with:
  - milestoneId = m.id; name, description, fieldType and config from m;
  - choices = m.choices without the archived ones, ids unchanged;
  - sortOrder = m.sortOrder; position = tn's position;
  - value = null; notApplicable = false; flag = null; rev = 0.
- Build the map `tn.id → draftId`.
- For each active TemplateEdge whose two ends are mapped, create a draft edge with `templateEdgeId = e.id`.

`createProject(ctx, {code, name, status, fields})` runs in one transaction:
1. Check the code is unique. If an archived project holds it, return the error "C0822 is used by an archived project. Restore it?".
2. Insert the Project with `templateRevisionSynced = template.revision`.
3. Insert the nodes, edges and ProjectFieldValues.
4. Write **one** `project.created` event with payload `{revision, nodeCount, edgeCount}`.

The seed copies as 64 nodes and 63 edges.

### 4.7 Sync from template
`planSync(template, project)` is pure and returns `{items: SyncItem[], warnings}`.

Each item has a stable id, a kind, a `defaultChecked` value, a description, and before → after state whenever a node's colour would change.

**Matching:** a project node goes with the milestone whose id equals its `milestoneId`. Template-derived project nodes are never archived, so there is no "removed in project" case.

**For each active template node (milestone M):**
1. **No project node for M** → `addNode:<M.id>` (checked).
   - Position: if a template predecessor maps to project node P, place it at (P.x + 240, P.y + 120), moved down 80 px until it no longer overlaps. Otherwise use the template position.
   - The new node is highlighted.
2. **Project node N exists:**
   - name or description differ → `updateDefinition:<M.id>` (checked). config and sortOrder ride along silently.
   - choices differ → `updateChoices:<M.id>` (checked).
     - Merged list: template choices in template order, with the template's label, state and archived flag; then any project choices missing from the template, appended with `archived: true`.
     - Choices are never removed. A value on a retired choice keeps its label and tag.
     - The preview shows each added, renamed, retagged or retired choice, and the colour change if N's current value is affected (for example after a retag).
   - fieldType differs:
     - N has no value → `changeType:<M.id>` (checked).
     - N has a value → `changeType:<M.id>` as a **conflict** (unchecked): "Adopt new type: current value '12 Nov 2026' is kept in history and copied to a system note, then cleared."
     - Left unchecked, N keeps its old type and the item comes back at the next sync.
     - There are no automatic value conversions.
3. **Project nodes whose milestone is archived or no longer in the template** → `markNA:<nodeId>` (unchecked, optional). The node always shows a "not in template" badge.

**Edges:**
4. For each active template edge E (milestones a→b), where both ends map to project nodes that exist or are added in this plan:
   - The project has an edge (active or archived) with `templateEdgeId = E.id` → skip. Arrows you removed are never re-added.
   - The project has an **archived** edge with the same pair → skip; it counts as removed by you.
   - The project has an **active** edge with the same pair and no templateEdgeId → silently link it (set templateEdgeId). No visible change.
   - Otherwise → `addEdge:<E.id>`: checked if a or b is newly added in this plan, unchecked otherwise ("template re-routed").
   - If the edge would create a cycle in the projected graph → a warning "skipped: would create a loop", not selectable.
5. For each active project edge P with a templateEdgeId whose template edge is archived → `removeEdge:<P.id>` (archived, never hard-deleted).
   - Checked when it is a **splice**: the template now has a path a → … → b whose intermediate milestones are all added in this plan, i.e. a step was inserted between them.
   - Unchecked otherwise ("template removed this arrow").

**Never touched:**
- values (except an explicitly ticked adopt-type item);
- the N/A switch and flags;
- positions of existing nodes;
- notes and attachments;
- project-only nodes;
- edges drawn in the project.

**`applySync(ctx, projectId, selectedItemIds)`**
- The server **re-plans** from fresh database state and does not trust the client's copy.
- It applies only the intersection with the selected ids, in one transaction, in this order: add nodes → definitions, choices and types → add edges (cycles re-checked one by one) → archive edges → N/A marks.
- It writes one `source: SYSTEM` event per change plus a `project.synced` summary, all sharing one correlationId. The actor is the user who clicked.
- It sets `templateRevisionSynced = template.revision` and `syncedAt`.

**Banner and re-runs**
- The banner "Template changed since last sync · Review" shows while `templateRevisionSynced < template.revision`.
- An empty plan only updates the stored revision.
- Unchecked items appear again whenever Sync is opened.
- Applying every item and then re-planning gives an empty plan (tested).

### 4.8 Library and definition edits
- **Add a milestone** (Library or canvas): creates a Milestone (key = slug of the name, with a suffix if taken) and a TemplateNode placed below the graph, unconnected. The side panel immediately offers "Comes after…".
- **Edit name, description, type or choices:** updates the Milestone, bumps the revision, and writes `milestone.updated` with old and new values and no projectId. Projects are not touched, because they keep a snapshot. The editor says: "Applies to new projects. Existing projects update when you Sync them (used in N projects)."
- **Type change in the library:** choices stay stored when switching to a type without choices, so switching back restores them. Multiple → Dropdown gives choices without a state the default NOT_STARTED and highlights them for review.
- **Choices:**
  - add (new id); rename, retag or reorder (same id); archive. They are never deleted, and "Show archived" lets you restore one.
  - **Copy choices from…** replaces this milestone's active choices with the source's labels, states and ids. Old choices that don't match are archived. Used for invoice milestones 55–58.
- **Reorder:** changes sortOrder only. It never changes arrows and does not bump the revision.
- **Archive a milestone:** the same action as archiving its template node, with reconnect (4.5).
- **ProjectField:** values point live at the field definition; there is no snapshot.
  - system fields (with a systemKey) can be renamed and have their choices edited, but cannot be archived or retyped;
  - a type change on a user-added field is allowed only if no project has a non-empty value; otherwise the editor names the projects that block it;
  - Customer and Product choices can be added inline from the project form.
- **Project-only nodes:** the definition can be edited in the project. A type change when a value exists asks first: "the value will be cleared; it stays in history".

### 4.9 Template file, import, export and seed

**Format:**
```
{ format: "gunnebo-pm.template", version: 1, exportedAt, templateRevision,
  milestones: [{ key, name, description?, fieldType, config?, sortOrder, position?: {x,y},
                 choices: [{ id, label, state?, archived? }] }],
  edges: [{ from: key, to: key }],
  projectFields?: [{ key, systemKey?, label, fieldType, choices, config?, sortOrder, showInSummary }] }
```

**Validation:** zod first, then semantic checks:
- keys and choice ids match the slug pattern and are unique;
- every DROPDOWN choice has a state;
- edges point at known keys, with no self-loops or duplicates;
- the graph is acyclic (Kahn's algorithm uses up every node);
- limits: at most 1 MB, 1,000 milestones, 100 choices each, and strings of 500 characters.

Errors come back in plain English with paths, e.g. `milestones[12].choices[3].state must be one of …`.

**Import** has one mode, "replace the template":
1. Show a preview: milestones added, updated or archived; choice changes; arrows added or removed.
2. Confirm.
3. Take an automatic backup.
4. In one transaction:
   - upsert milestones **by key**, keeping existing ids so projects stay linked;
   - merge choices by id; missing ones are archived;
   - archive milestones not in the file (restorable);
   - replace template edges, reusing or restoring the row for the same pair so project links survive;
   - set positions, running the wrapped auto-layout if none are given;
   - upsert projectFields by key, and never archive missing ones;
   - bump the revision;
   - write `template.imported` events (SYSTEM) under one correlationId.

Projects change only when synced. Import is a server action, because the 1 MB limit matches the file limit.

**Export:** `GET /api/template/export` in the same format, archived choices included.

**Seed:** `prisma/seed/template.v1.json`, written by hand from the brief and loaded **through the importer**, so a fresh install exercises import every time.
- Milestones: 64 in order, sortOrder 1–64. Keys are slugs (`customer-po-loi`).
- Choices: ids are label slugs (`awaiting`, `loi-received`, `held-open-items`), with states from the bracket codes.
  - 55–58 get their own copies of 54's choices (same slugs, separate lists).
  - 37 is MULTIPLE with no states.
- Types: 49 is PERCENT, 60 is DATE_RANGE, and 63 is TEXT as written (switchable to Long text in the Library).
- Edges: the 63-edge chain 1 → … → 64, with no positions, so the importer runs the wrapped layout.
- The seed also creates:
  - User `local` ("Me");
  - FlowTemplate "Standard" (isDefault);
  - AppSetting timezone;
  - 7 project fields:
    - Customer: Dropdown, SITA · IDEMIA · NEC · Collins Aerospace
    - End user: Text
    - Site / country: Text
    - Product: Dropdown, AFL · AFL-Compact · ImmSec · ABCS
    - Quantity: Number
    - Project type: Dropdown, Project · Spare order · Adhoc · Warranty replacement
    - Notes: Long text
- **No sample projects.**

### 4.10 Portfolio and My open items
All state is computed on the server per request in one query: projects, nodes, latest note per node, attachment counts. The client receives compact arrays.

**Rows:** non-archived projects, filtered by:
- Status: multi-select, default **Active**;
- Customer: multi-select, from the Customer field's choices;
- Project type: multi-select;
- a search on code or name.

Filters live in the URL. When the URL has none, the last-used set comes back from localStorage.

**Columns**
- The active template nodes in **template flow order**.
- Vertical header `08 Customer PO / LOI`, truncated, with the full name in a tooltip.
- A sticky left block: code, then name with the customer as a subtitle, then % done with a mini bar.

**Cells**
- **Normal cell:** a 20×20 square in the state colour. N/A cells are a dashed outline; current milestones get a small violet dot.
- **Missing node** (milestone added to the template, project not yet synced): a hatched cell, "not in this project · sync".
- **"Other" column** (last): the number of project-only and not-in-template nodes, coloured by their worst state. Worst first: BLOCKED > WAITING > IN_PROGRESS > NOT_STARTED > DONE.
- **Click:** each cell is `<a href="/projects/{id}?view=flow&node={nodeId}">`, so Cmd-click opens a new tab.
- **Tooltip:** one delegated tooltip for the whole grid (pointerover plus data attributes) shows code, milestone, value, state, last changed and latest note.
- **Keyboard:** arrow keys move a roving focus between cells, and Enter opens the node.
- **Rendering:** a plain table with sticky CSS and no virtualization. 100 × 70 is about 7k cells.

**My open items** (collapsible right panel)
- Scope: nodes in the projects matching the grid's filters, with state IN_PROGRESS or BLOCKED.
- Chips:
  - **+ Waiting** (off by default);
  - **Include planned dates (n)** (off by default). When off, nodes whose reason is DATE_PLANNED or RANGE_UPCOMING are left out.
- Sort: `lastChangedAt` ascending (oldest first), then flow order.
- Row: state dot · code · milestone · value · age (`12d`; amber after 14 days, red after 30) · latest note snippet. A click opens the node.

### 4.11 Service layer and events
- **Signature:** `fn(ctx, input)`, with `ctx = {actorId, source: MANUAL|EMAIL|SYSTEM, occurredAt?, correlationId?, externalRef?}`.
- **Every mutation:**
  1. zod-validate the input;
  2. open `prisma.$transaction`;
  3. read the current row;
  4. check `expectedRev` (node writes);
  5. apply the change;
  6. call `appendEvent(tx, …)` with old and new `{raw, display, state}` and payload `{nodeName, milestoneKey, …}`;
  7. return a DTO with the derived state.
- **Server actions** are `defineAction(schema, handler)`: `requireUser()` → ctx with MANUAL → the service.
- **Event granularity:** one event per committed change: dropdown click, chip toggle, date commit, slider release, text blur or Enter, N/A toggle, flag, note, attachment.
- **Not logged:** node position moves and auto-layout.
- **Event types:**
  - project: `project.created/updated/archived/restored/synced`
  - node: `node.value_changed/na_changed/flag_changed/added/updated/archived/restored/definition_synced/type_adopted`
  - edge: `edge.added/archived/restored`
  - note: `note.added/edited/archived`
  - attachment: `attachment.added/archived`
  - library and template (no projectId): `milestone.created/updated/archived/restored/reordered`, `template.edge_added/edge_archived/imported`
- **Concurrency:** `ProjectNode.rev` goes up on every value, flag, N/A or definition write. A mismatch returns "This milestone changed elsewhere; reloaded" and the client refetches. This protects against old tabs now and the mail job later.

### 4.12 Attachments
- **FileStore interface:** `put(stream, {projectId, attachmentId, fileName, mimeType}) → {storageKey, sizeBytes, sha256}` and `openRead(storageKey)`.
- **LocalFileStore** writes to `data/uploads/<projectId>/<attachmentId>/<sanitised-name>`. Paths never come from the client.
- **Upload:** `POST /api/attachments`, multipart, through a Route Handler. Server Actions have a 1 MB body limit. `MAX_UPLOAD_MB` = 50.
- **Download:** `GET /api/attachments/[id]` streams the file with Content-Disposition (inline for PDFs and images) and `X-Content-Type-Options: nosniff`.
- **Links:** http or https only. SharePoint and OneDrive hosts get their own icon.
- **Archiving** hides the attachment; the file stays on disk. Every add or archive writes an event.

## 5. Screens and routes

**Routes:**
- `/` redirects to `/portfolio`.
- `/portfolio?status=&customer=&type=&q=`
- `/projects?q=&status=&new=1`
- `/projects/[id]?view=flow|list|history&node=<nodeId>`
- `/library?tab=milestones|project-fields&m=<milestoneId>`
- `/template?m=<milestoneId>`
- `/archive?tab=projects|milestones|nodes|notes-files`
- `/settings`

**API (file and binary only):**
- `POST /api/attachments`
- `GET /api/attachments/[id]`
- `GET /api/projects/[id]/export` (.xlsx)
- `GET /api/template/export` (.json)

Everything else goes through server actions.

**Shell:**
- Left sidebar, 224 px, collapsible to icons.
- Top items: Portfolio, Projects, Milestone Library, Template Flow.
- Bottom items: Archive, Settings, theme toggle (Light by default, Dark, System), Search ⌘K.
- Page header: 48 px.
- Side panel: docked on the right, 400 px, resizable from 320 to 560 px with the width remembered. Non-modal. It pushes content aside at 1280 px or wider and overlays it on narrower screens.

**State colour tokens:**
- CSS variables `--state-{ns|ip|w|b|d|na}-{solid|bg|border|fg}` in OKLCH, defined for light and dark.
- Shared by nodes, cells, chips, the minimap, the legend, and a hex mirror used for Excel fills.
- React Flow `colorMode` follows next-themes.

**Node card (shared by every canvas):**
- Fixed at 208×64 px.
- Visual: a 4 px state stripe, a tinted background and a 1 px state border.
- Name line: state icon, then the name at 12 px medium, clamped to 2 lines. The full name is in the tooltip.
- Value line: 11 px, tabular figures.
- Indicators, top right: note count, attachment count, `P` (project-only), a pin (flag), a clock (DATE_PASSED_AUTO), `!` (invalid value or unknown choice).
- PERCENT nodes get a 2 px progress track along the bottom.
- States:
  - **Current:** a 2 px violet ring. Violet is not used by any state.
  - **Selected:** a foreground outline.
  - **N/A:** 50 % opacity, dashed border, no fill, no stripe.
- **Semantic zoom** (a zoom-bucket selector, so nodes re-render only when the bucket changes):
  - full at zoom ≥ 0.6;
  - compact from 0.35 to 0.6: name only, 16 px;
  - overview below 0.35: a solid state block showing the flow sequence number.
- **Template canvas:** the same card in a neutral colour, with a field-type icon and "Dropdown · 5 choices".

**Edges:** smoothstep, 1.5 px, closed arrowhead.
- Green at 60 % opacity when the source is Done; muted otherwise.
- Dashed when touching an N/A node.
- Hovering shows a delete `×` in the editing modes.

**Template Flow (`/template`)**
- **Toolbar:**
  - `+ Milestone` [N]
  - `Auto-layout ▾` [L]: Left→Right, or Left→Right wrapped (dagre LR ranks chunked into rows of 10; y = row × (row height + 80))
  - `Fit` [F]
  - `Export JSON`, `Import JSON`
  - a "Saved" indicator
- **dagre settings:** rankdir LR, nodesep 24, ranksep 56, node 208×64. Auto-layout animates and offers Undo.
- **Moving nodes:** drag; positions save on drag stop, debounced 300 ms and batched. Shift-drag selects a group.
- **Connecting:** drag from the right handle to a left handle. Self-loops, duplicates and cycles are rejected.
- **Deleting an arrow:** select it and press Delete, or use the hover `×`.
- **Adding a node:** toolbar or N (at the viewport centre); double-click the canvas (at the pointer); drag from a handle onto empty canvas (already connected); context menu "Insert after".
- **Deleting a node:** archives it with "Reconnect neighbours" and an Undo toast.
- **Side panel:**
  - DefinitionEditor: name, description, field type, a choices editor with state pills (NS IP W B D NA), "Copy choices from…", and the read-only key.
  - "Comes after / Leads to" multi-selects, a keyboard alternative to dragging arrows.
- **Also:** minimap coloured by state, zoom and pan controls, and an info strip listing unconnected nodes.

**Milestone Library (`/library`)**
- **Milestones tab:** a dense table in sortOrder.
- **Columns:**
  - drag handle (dnd-kit; Alt+↑/↓ also moves a row);
  - #;
  - name, edited inline;
  - field type select;
  - choices preview: state dots and labels, `+n`;
  - description;
  - "Used in n projects";
  - ⋯ menu: Edit, Show in Template Flow, Archive.
- **Row click** opens the same DefinitionEditor in the side panel.
- **Toolbar:** `+ Milestone`, search, filter by type, and the "applies to new projects" note.
- **Project fields tab:** the same table and editor without state tags, plus a "system" badge and the showInSummary toggle.

**Projects (`/projects`)**
- **Table columns:** Code, Name, the summary fields (Customer, Product, Qty, Type…), Status, % done, first current milestone, Updated.
- **Above the table:** search and status chips.
- **New project** (C or the palette) opens a dialog:
  - Code and Name are required. Uniqueness is checked as you type, including archived codes.
  - Status, then the fields from ProjectField. Customer and Product support `Add "X"` inline.
  - A footnote: "Copies 64 milestones and 63 arrows from the template".
  - Creating the project opens its Flow view.

**Project page (`/projects/[id]`)**

*Header* (sticky, collapsible to one line):
- Row 1: code badge, name, Status pill, Type pill, the Flow/List/History toggle [V] [H], Edit details (a sheet; every change logged), and a ⋯ menu (Export to Excel, Sync from template…, Archive project).
- Row 2: summary fields, e.g. `SITA · Heathrow T5 · London, UK · AFL-Compact × 24`.
- Row 3: stacked state bar, then `34 / 58 done · 58 % · 3 in progress · 2 waiting · 1 blocked`.
- Row 4: `Current:` chips in flow order, with `+n` for overflow. A click selects the node and pans to it.
- The template-changed banner.

*Flow view:*
- **Opening view:**
  - with `?node=`: centre that node at zoom 1 and open its panel;
  - otherwise: fit the current milestones (padding 0.3, maxZoom 1);
  - if nothing is current: fit everything.
- **Toolbar:** Fit [F], Go to current [C], Auto-layout [L], Edit arrows [E], `+ Project milestone`, Legend.
- **Edit arrows mode** shows the handles and the arrow `×`, with the banner "Editing arrows for this project only; the template is not changed". Outside this mode arrows cannot be created or deleted (`deleteKeyCode` is null).

*Node side panel:*
- **Header:** state icon, name, a badge (From template / Project-only / Not in template), `Comes after: A ✓, B ●`, prev/next [J/K], close [Esc].
- **Value:**
  - the field-type editor, autofocused;
  - helper text with the reason, e.g. "Future date → In progress (planned)".
- **Not applicable for this project** switch [X].
- **Flag:** None / Waiting / Blocked. An optional reason is saved as a note.
- **Notes:** add with Ctrl/Cmd+Enter; listed newest first; edit or archive, both logged.
- **Links & files:** `+ Link`, `+ File`, a drop zone; each row has open and archive.
- **History:** the last 5 events, then "Show all". Format: `24 Oct 14:05 · You · Awaiting → LOI received`, with a source icon.
- **Footer:** `Last changed 2d ago · ID … (copy)`.
- **Definitions:**
  - template-derived nodes: read-only, with an "Edit in Library" link;
  - project-only nodes: an editable DefinitionEditor.

*Value inputs:*
- **Dropdown:** a vertical list of choice pills with state dots. One click saves. Keys 1–9 pick a choice; Clear empties it.
- **Multiple:** toggle chips, with All / Clear and `n of 9`.
- **Date:** typed entry plus an inline calendar, with Today / +1 week / Clear.
- **Date range:** two date inputs.
- **Percent:** a slider (step 5), a number input, and 0/25/50/75/100 buttons.
- **Number:** a number input plus the unit.
- **Text:** saves on Enter or blur.
- **Long text:** an auto-growing textarea that saves on blur or Cmd/Ctrl+Enter.
- **Checkbox:** a switch.
- **Link:** a URL input with an `Open ↗` button.
- **File:** the attachments list.

*Saving model:*
- There are no Save buttons. Every change is applied optimistically in the zustand store.
- The server action returns the updated node DTO.
- On error the change rolls back and a plain-English toast explains why.

*List view:*
- **Layout:** 32 px rows, sticky header, flow order.
- **Columns:**
  - #
  - State pill
  - Milestone, with `P` on project-only nodes
  - Value: inline editor for text and number; a popover for the other types
  - Last changed
  - Latest note
  - Note and file counts
- **Keyboard:**
  - ↑/↓ or J/K: move between rows
  - Enter: edit the value
  - Esc: cancel
  - Tab: next row's value
  - X: N/A
  - N: note
  - O: open the panel
- **Filters:** All / Current / Open / Blocked / Waiting / Done, plus Hide N/A.
- **Bulk:** multi-select rows, then **Mark not applicable**. One correlationId covers the batch; useful for spare orders.

*History view:*
- The project's event log, newest first, 100 per page.
- Filters: milestone, type and source.

**Archive (`/archive`)**
- **Tabs:** Projects, Milestones, Project milestones, Notes & files.
- **Each row:** context (such as the project code), archived date, and Restore.
- **Not here:** choices are restored inside the choice editor.

**Settings (`/settings`):** display name, timezone (default Asia/Singapore), Back up now, the last backup time, and the data folder path.

**Excel export** (`C0822 <name> 2026-10-24.xlsx`)
- **Summary:** details, progress, state counts, export time.
- **Milestones:** in flow order. Columns: #, milestone, type, value, state (filled in the state colour), N/A, flag, comes after, last changed, latest note, links/files.
- **History:** all events, newest first.
- **Files & links.**
- Dates are written as `Date.UTC(y, m-1, d)` with the format `d mmm yyyy`, so they never shift by a day.

**Keyboard**
- One central hook ignores keys while you type in inputs, textareas and contenteditable fields. `?` opens an overlay listing every shortcut.
- **Global:** ⌘/Ctrl+K command palette (projects, milestones in the current project, and actions: New project, Export, Sync, Back up now, Toggle theme), `/` search, Esc.
- **Project:** V, H, J/K, Enter, X, N, F, C, L, E.
- **Template:** N, Delete, L, F, arrow keys to nudge.
- **Portfolio:** arrow keys, Enter, O for the open-items panel.

## 6. Build steps (each step: commits with clear messages and the session attribution lines, push to the feature branch, update the draft-PR checklist, Playwright screenshots in chat in light and dark, and a "Try it" block)

The "Try it" block on the Mac is always: **GitHub Desktop → Pull → Terminal: `npm install`, then `npm run dev` → open the URL**.

**Step 0: Plan approval.** Post the short summary (section 0) and the open questions in chat and in the PR description. No code until the user says OK.

**Step 1: Scaffold and app shell**
- *Delivered:*
  - Next 16.4.3 with TypeScript, App Router, `src/`, Tailwind 4 and Turbopack, all versions exact.
  - shadcn init and base components; next-themes; the system font stack.
  - Sidebar with placeholder pages for every route.
  - Repo setup: `.gitignore`, `.nvmrc`, engines, `.npmrc`, dev bound to 127.0.0.1.
  - README v0 with one-time Mac setup and the two commands.
  - First commit and the draft PR.
- *User sees:* the shell, light and dark, at http://localhost:3000.
- *One-time Mac setup:*
  1. Install Node 24 LTS from nodejs.org.
  2. Install GitHub Desktop.
  3. Clone `ronnieyap1001/gunnebo_pm` into `/Users/<you>/Code`, **not** a OneDrive, iCloud or Documents folder.
  4. Switch to the feature branch.
  5. Repository → Open in Terminal.

**Step 2: Database, seed, read-only Library**
- *Delivered:*
  - Prisma 7.10.1 schema with every Phase 1 table, and the initial migration plus the Event triggers.
  - `prisma.config.ts` and the database client.
  - `prepare.ts`, `doctor.ts` and `backup.ts`.
  - The template-file zod schema and validator, the seed JSON, and the importer.
  - Value schemas in `domain/fieldTypes`.
  - `/library` as a read-only table.
- *Tests:*
  - the seed validates;
  - cycles, dangling keys and duplicate keys are rejected;
  - integration: an Event UPDATE or DELETE fails.
- *User sees:* `/library` with 64 milestones and coloured choice chips; a `data/` folder appears; `npm run backup` creates a backup.

**Step 3: State engine and Library editing**
- *Delivered:*
  - `domain/state`, `format` and `dates`.
  - Library: add, rename, reorder, archive with Undo, change type, and the choice editor (add, rename, reorder, retag, archive, Copy choices from…) with live state-preview chips.
  - The Project fields tab.
  - Events and revision bumps.
  - The `/archive` Milestones tab.
- *Tests:* table-driven deriveState for every type, the today boundary, and the SGT/UTC midnight case (2026-10-24T16:30Z is already 25 Oct in Singapore).
- *User sees:* retag "Revising" to Waiting and its chip turns amber; archive "BOM", then restore it from `/archive`; `npm test` output pasted in chat.

**Step 4: Template Flow Editor**
- *Delivered:*
  - FlowCanvas and the shared node card with semantic zoom.
  - Drag with saved positions; arrows with the cycle guard; deleting arrows.
  - Every way to add a node, and archiving with reconnect and Undo.
  - DefinitionEditor and "Comes after / Leads to" in the side panel.
  - dagre LR and wrapped layouts with Undo, minimap, controls, Fit.
- *Tests:* cycle check, flowOrder, bridging, the wrapped layout.
- *User sees:* at `/template`, press L and choose wrapped; run "Engineering job request" alongside order admin and merge it back; a backward arrow is refused with a message; delete an arrow and press Undo.

**Step 5: Projects (create from template, edit, archive)**
- *Delivered:*
  - `/projects` table and the New project dialog (inline Add customer/product, code check).
  - buildProjectSnapshot and createProject.
  - The Edit details sheet and status changes, both with events.
  - Archive and restore (the Archive Projects tab).
  - A read-only project canvas.
- *Tests:*
  - unit: snapshot gives 64/63, choice ids kept, edges remapped, archived choices excluded, no values;
  - integration: create.
- *User sees:* create C0822 (SITA, AFL-Compact × 24) and it opens with 64 grey nodes.

**Step 6: Project Flow View (main screen)**
- *Delivered:*
  - State colours, value lines, current rings, arrow colouring.
  - Header with summary, stacked bar, progress, current chips, collapse.
  - Opening viewport.
  - Side panel with every value editor, N/A, Flag and History.
  - J/K, `?node=` deep links, optimistic saves, the rev check.
- *Tests:*
  - unit: current milestones (N/A see-through, branches and merges) and progress;
  - integration: setNodeValue writes exactly one event with old and new values.
- *User sees:*
  - Set "Customer PO / LOI" to Awaiting: the node turns amber.
  - Set it to Full PO: it turns green and the next node becomes current.
  - Enter a future FAT date: blue "Plan …".
  - Mark "Storage at factory" N/A: it fades.
  - History shows each change.

**Step 7: Notes, links, attachments**
- *Delivered:*
  - Notes: add, edit and archive, with events.
  - Links.
  - FileStore, plus the upload and download routes (50 MB).
  - The FILE type.
  - Note and attachment counts on the cards.
  - The Archive tab for notes and files.
- *User sees:* upload a PDF to a node, add a SharePoint link, write a note; the counts appear on the card; the file is under `data/uploads/`; History shows the entries.

**Step 8: Project structure and List and History views**
- *Delivered:*
  - Edit arrows mode, project-only nodes (`+ Project milestone`, Insert after), archive and restore of project-only nodes, auto-layout in projects.
  - List view: inline editing, keyboard, filters, Hide N/A, bulk Mark N/A.
  - History view.
- *User sees:*
  - At `?view=list`, change three values without the mouse.
  - Bulk-mark the warranty rows N/A.
  - Press V: the same node is selected in Flow.
  - Re-route an arrow, and `/template` is unchanged.

**Step 9: Portfolio and My open items**
- *Delivered:*
  - The grid, filters, delegated tooltip, cell links, keyboard focus and the Other column.
  - The open-items panel with its chips.
  - `seed:demo` for screenshots only, using `data/demo.db`.
- *User sees:* at `/portfolio`, hover cells, filter by SITA, click a red cell to land on that node, and see open items oldest first.

**Step 10: Sync from template**
- *Delivered:*
  - The revision banner.
  - planSync and applySync.
  - The preview dialog with grouped checkboxes and before → after colours.
  - Apply in one transaction with correlated events.
- *Tests:* the full scenario suite (section 7), idempotency, and integration apply-twice.
- *User sees:*
  1. In `/template`, insert "Customs pre-check" after ETA and add a choice to Training.
  2. Open C0822: the banner appears.
  3. Review the preview and Apply.
  4. Earlier values are unchanged, and History shows the sync.

**Step 11: Export, import, backup, restore, reset, Settings**
- *Delivered:*
  - The Excel export (4 sheets).
  - Template JSON export, and import with preview and backup.
  - The Settings page.
  - `restore.ts` and `reset.ts` (`reset:template`, and `reset:all` with a typed RESET).
- *Tests:* export → import round trip; the xlsx is produced with the expected sheet names.
- *User sees:* Export to Excel opens in Excel; export the template and re-import it to see the preview; `npm run backup` creates `data/backups/<time>/`.

**Step 12: Keyboard, palette, performance, hardening, final README**
- *Delivered:*
  - ⌘K palette, the `?` overlay and the hotkey guard.
  - A performance pass with a 150-node demo project.
  - The Playwright smoke test (container only).
  - GitHub Actions: ubuntu on every push; macOS on PR events and manual runs, to save macOS minutes.
  - The final README:
    - start, stop (Ctrl+C) and update;
    - where data lives;
    - back up and restore;
    - the two reset commands;
    - "copy the data folder before deleting the app folder";
    - the three most likely install errors and their fixes.
- *User sees:* ⌘K, type "C08"; the README on the branch; CI green on macOS.

Cuttable polish if time is short: the command palette, "Comes after / Leads to" comboboxes, the colour-coded age in open items, and drag-to-create from a handle.

## 7. Tests

**Vitest unit tests** (`src/domain`, no database):
- **deriveState** for every type: empty or filled; the date boundary (yesterday, today, tomorrow); DATE_PASSED_AUTO; every DATE_RANGE case; percent 0, 1, 99 and 100; NA-tagged choices; retired choices; unknown choice; invalid value; precedence N/A > flag > value.
- **todayIn:** SGT vs UTC at 2026-10-24T16:30Z.
- **formatValue** for every type.
- **Graph:** wouldCreateCycle, flowOrder (branches, merges, tie-breaks), current milestones (A→NA→C both ways, parallel branches, merges, roots), progress (floor, zero applicable), bridging and restoreBatch.
- **buildProjectSnapshot.**
- **planSync scenarios:**
  - new milestone mid-chain (splice: edges added and the old edge removal checked);
  - two inserted steps in a row;
  - renamed choice;
  - retagged choice (colour-change preview);
  - removed choice still in use (retired, value kept);
  - type change on an empty node vs a node with a value (conflict, unchecked);
  - milestone removed from the template;
  - an edge the user deleted is not re-added;
  - a template edge between existing nodes is unchecked;
  - a user-drawn same-pair edge is linked silently;
  - a cycle-causing edge is skipped;
  - project-only nodes and edges are untouched;
  - apply all then re-plan gives an empty plan;
  - apply defaults then re-plan leaves only the unchecked items.
- **Template file:** seed passes; cycle, dangling and duplicate fail; export → import round trip preserves ids and keys.
- **Import rule:** `src/app` and `src/components` don't import Prisma.

**Integration tests** (temporary SQLite migrated with `migrate deploy` in globalSetup):
- createProject copies 64 nodes and 63 edges;
- setNodeValue writes one event and bumps rev; a stale rev is rejected;
- the Event triggers block UPDATE and DELETE;
- a failing step rolls the transaction back;
- applySync applied twice changes nothing;
- foreign keys are enforced.

**E2E** (Playwright 1.63.0, container only, demo database):
open portfolio → open project → click node → choose "Full PO" → the node turns green and History updates. The same harness produces the screenshots.

## 8. Git, data hygiene, backup and reset

**`.gitignore`:**
- `node_modules/`, `.next/`, `src/generated/`
- `data/`, `*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal`
- `.env`, `.env.*` (but keep `!.env.example`)
- `exports/`, `screenshots/`, `test-results/`, `playwright-report/`, `coverage/`
- `*.tsbuildinfo`, `next-env.d.ts`, `.DS_Store`

**Committed:** `package-lock.json`, `prisma/migrations/`, the seed JSON (taken from the brief; no user data) and `.env.example` (DATABASE_URL, APP_TIMEZONE, BACKUP_DIR, MAX_UPLOAD_MB; all optional).

**Rules:**
- Screenshots use demo data only, from `data/demo.db`. They go to chat, never into the repo.
- A CI step fails if any `data/` or `*.db` file is tracked.

**Backups:**
- **Database:** `npm run backup` copies `data/gunnebo-pm.db` to `<backups>/<YYYY-MM-DD_HHmm>[-label]/` using better-sqlite3's online `db.backup()`, which is safe while the app runs in WAL mode.
- **Uploads:** they never change once written, so new upload files are copied into a single mirror, `<backups>/uploads/`. There is no full copy per backup.
- **When automatic backups run:** daily on start, before pending migrations, before an import, and before either reset.
- **Retention:** the newest 14 automatic backups are kept. Manual and pre-operation backups are kept until deleted by hand.
- **Settings** shows "Back up now" and the last backup time.

**Restore:** `npm run restore`
1. Refuses if port 3000 is in use: "Stop the app first: press Ctrl+C in its Terminal window".
2. Lists the backups.
3. Backs up the current state.
4. Replaces the database and removes stale `-wal` and `-shm` files.
5. Merges the uploads mirror back.

**Reset:**
- **`npm run reset:template`** puts the Library and Template back to the seed and keeps projects. It is a backup plus an import of the seed in replace mode.
- **`npm run reset:all`**:
  1. Asks you to type RESET.
  2. Takes a backup and moves `data/uploads/` into it.
  3. Deletes the database files.
  4. Runs `migrate deploy` and the seed.

## 9. Login and hosting readiness
- **Single user now:** every server action and route handler calls `requireUser()`, which returns the seeded local user.
- **Before hosting:**
  - add Auth.js with the Microsoft Entra ID provider (it fits Phase 2's Graph consent), or Supabase Auth;
  - add a Next 16 `proxy.ts` (formerly middleware) redirect;
  - add `ownerId` and `assigneeId` columns;
  - only `requireUser()` changes.
- **Until then:** the app binds to loopback only.
- **Moving to Postgres:**
  1. Switch the provider to postgresql and use `@prisma/adapter-pg@7.10.1` in `client.ts`.
  2. Create a fresh baseline migration and re-create the Event triggers in plpgsql.
  3. Move the data with a `db:export-json` / `db:import-json` script, to be written then.
  4. Add a FileStore implementation for Supabase Storage or Vercel Blob, using signed direct uploads because of Vercel's 4.5 MB body limit.
- **Portability rules now:**
  - no raw SQL in services (only in the triggers migration and the backup script);
  - no JSON-path filters and no `mode:'insensitive'`; filtering and search happen in TypeScript;
  - project codes are upper-cased on save.

## 10. How later phases plug in
- **Phase 2 (Outlook):**
  - `npm run mail:sync`, or a scheduled route, uses a Graph delta query and calls **the same services** with `ctx = {source: EMAIL, occurredAt: receivedDateTime, externalRef: 'graph:<internetMessageId>'}`.
  - `@@unique([source, externalRef])` makes re-runs harmless.
  - Each email is logged with a `node.email_logged` event in the node's history.
  - Mapping uses `Project.code` (`/C\d{4}/`), `Milestone.key` and `ProjectNode.id`.
  - Proposals use a new `ChangeProposal(projectId, nodeId, proposedValue, status, emailEventId)` table. Accepting one calls setNodeValue with a shared correlationId.
  - The autoincrement `Event.id` serves as the worker's cursor.
- **Phase 3 (SharePoint):**
  - `Attachment.storage = 'sharepoint'`, plus `externalId` (driveItemId) and `category` columns.
  - A `ProjectFolderSetting(projectId, category, driveId, folderPath)` table.
  - A SharePoint FileStore implementation.
- **Phase 4 (commercial and daily brief):**
  - `CommercialRecord(projectId, kind PO|INVOICE|PAYMENT|CREDIT_NOTE, amountMinor Int, currency, issuedOn, dueOn, paidOn, milestoneKey?)`, linked to invoice milestones 54–59.
  - The daily brief reuses deriveState, currentNodes and the open-items query.
- **Templates per project type:** the FlowTemplate table and `Project.templateId` already exist. Later this needs only a picker in New project.

## 11. Main risks and mitigations

**Mac install and environment**
- **better-sqlite3 install fails on the Mac** (proxy, or an unusual Node version).
  - Prebuilt 12.x binaries for Node 22 and 24, with `.nvmrc` and `engines`.
  - `doctor` prints the exact fix.
  - The macOS CI job proves the install.
  - Fallback: `@prisma/adapter-libsql@7.10.1`, which changes one file and keeps the same database file format.
- **Prisma surprises** (the 8.0 RC is on `latest`, Prisma 7 does less automatically, engine download blocked).
  - Exact pins and explicit generate, migrate deploy and seed steps.
  - The user's machine never runs `migrate dev`.
  - `doctor` explains an engine-download failure: use a home network or hotspot, or set `PRISMA_ENGINES_MIRROR`.
- **Fresh releases** (next 16.4.3 is one day old).
  - Smoke test in step 1, with 16.4.2 as the fallback.
  - dagre pinned to 3.1.1.
- **Pushing workflow files may be refused** by the session's GitHub token, which may lack workflow scope.
  - CI is optional; if the push is refused, say so and keep the YAML as a documented file instead.

**Data safety**
- **Losing data** (reset, file copy in WAL mode, synced folder).
  - Online backups, plus automatic backups before every risky operation.
  - A typed confirmation for reset.
  - A synced-folder warning and the README in plain words.
- **Event triggers silently dropped** by a future SQLite table-redefinition migration.
  - An integration test asserts the triggers exist.
  - Developer checklist: re-append the trigger SQL whenever a migration touches Event.

**Data correctness**
- **The user expects library edits to change existing projects.**
  - The "applies to new projects" note, "Used in n projects", and the banner with a one-click preview.
- **A planned date turns green when it passes (false Done).**
  - DATE_PASSED_AUTO clock marker.
  - Planned dates hidden from open items by default.
- **Off-by-one-day errors.**
  - String dates, an injected `today`, the midnight test, and `Date.UTC` in Excel.

**Performance**
- **60+ nodes are unreadable or slow.**
  - Fixed-size memoised cards, semantic zoom, `onlyRenderVisibleElements`, module-level `nodeTypes`.
  - The opening view centres on the current milestones; the wrapped layout fits the seed chain.
  - One delegated tooltip.

**Exposure**
- **No login.** The app binds to 127.0.0.1, and `prepare` refuses other hosts unless `AUTH_ENABLED` is set.

---

## 12. Amendments after independent review (these override sections 1–11 where they differ)

Two reviewers (requirements coverage, adversarial failure hunt) audited the merged plan. Accepted changes:

### Setup and environment
- **Node versions.** `engines` = `^22.12.0 || ^24.0.0 || ^26.0.0`; doctor accepts 22, 24 and 26. Node 26 becomes Active LTS on 2026-10-28, so the README says "install the LTS version from nodejs.org (24 or 26 both work)". `.nvmrc` is for the developer only. CI matrix covers 24 and 26.
- **The user's install command is `npm ci`, not `npm install`.** It never rewrites the lockfile, so GitHub Desktop never reports local changes. A container test (`scripts/check-lockfile.ts`) asserts the lockfile contains darwin-arm64 and darwin-x64 entries for `@tailwindcss/oxide`, `lightningcss` and `@next/swc` (npm/cli#4828). Developer rule: regenerate the lockfile only from a clean `rm -rf node_modules package-lock.json && npm install`.
- **Quiet terminal.** `.npmrc`: `save-exact=true`, `audit=false`, `fund=false`, `update-notifier=false`. Child processes run with `PRISMA_HIDE_UPDATE_MESSAGE=1` and `NEXT_TELEMETRY_DISABLED=1`. README: "Only run the commands in this README; ignore commands the terminal suggests."
- **Doctor runs early and is dependency-free.** `scripts/doctor.mjs` (plain JS, Node built-ins only) checks Node version, write access to `data/`, reachability of registry.npmjs.org, github.com and binaries.prisma.sh, and maps common errors to plain fixes: certificate errors → `NODE_EXTRA_CA_CERTS` / `npm config set cafile`; `NODE_MODULE_VERSION` → "run `npm ci`"; gyp/xcrun → install Command Line Tools. Try to wire it as `preinstall` (verify npm ordering); otherwise document `node scripts/doctor.mjs` as the troubleshooting command. `prepare.ts` imports only built-ins at the top and dynamic-imports better-sqlite3 and Prisma after the checks.
- **Single instance.** `prepare` writes `data/app.lock` (pid, port), clears it if the pid is dead, and refuses a second instance with a plain message. `restore` and `reset` use the same lock instead of a port probe.
- **Try-it block** always starts with "In the Terminal window where the app is running, press Ctrl+C".
- **Migrations are immutable once pushed.** Add new migrations only. `prepare` catches P3005/P3009/checksum errors and prints a plain message pointing to `npm run reset:all` (which backs up first). After `migrate deploy`, `prepare` runs a read-only `validateData` (zod over every value/choices/config JSON) and prints counts of invalid rows. The user is told that data entered before the build is finished is test data.
- **Backups while the app runs for weeks.** `instrumentation.ts` `register()` (Node runtime) starts an hourly check that runs the online `db.backup()` on its own connection when `lastBackupAt` is over 24 h old, and applies retention. Sidebar footer warns when the last backup is over 48 h old.

### Next.js and security
- **Dynamic rendering.** `export const dynamic = 'force-dynamic'` on the `(app)` layout, plus a `getRequestContext()` that awaits `connection()` and computes `today`. CI runs `next build` without a database and asserts every `(app)` route is dynamic.
- **Host check (DNS rebinding).** `src/proxy.ts` returns 421 for any Host other than `localhost:<port>` / `127.0.0.1:<port>` (override with `ALLOWED_HOSTS`). Non-GET route handlers require `Sec-Fetch-Site: same-origin` or a matching Origin. Either exclude `/api/attachments` from the matcher or set `experimental.proxyClientMaxBodySize` to `'60mb'` so uploads are not truncated at 10 MB.
- **Server action body limit** raised to `2mb`; the app's own template-import check stays at 1 MB with a plain message, checked in the browser first.
- **Hotkeys** ignore events with meta/ctrl/alt (except declared combos) and while `e.isComposing`. React Flow `deleteKeyCode={['Backspace','Delete']}` in editing modes, labelled ⌫; every delete goes through `onBeforeDelete` to the archive service.

### Database and concurrency
- **One write path.** Every write, including position saves, settings and `lastBackupAt`, goes through `withTx(fn)` = `prisma.$transaction(fn, {maxWait: 10_000, timeout: 20_000})`. All validation (zod, rev, cycle) runs before the first write. Multi-query read models (project page, Portfolio) run inside a short read transaction so they never see a half-applied sync (the better-sqlite3 adapter shares one connection; only `startTransaction` takes the mutex). A grep test enforces no bare `prisma.<model>.create/update/delete` outside `withTx`.
- **Rev check** is `updateMany({where: {id, rev: expectedRev}, data: {..., rev: {increment: 1}}})`; count 0 → conflict. Safe on Postgres READ COMMITTED.
- **Client write queue.** Per-node queue in the zustand store: one write in flight per node; the next write uses the rev returned by the previous response; queued value writes collapse to the latest. Multiple-chip toggles and slider moves coalesce for ~400 ms and send the full value as one write and one event. A conflict is shown only when the server rev differs from the last acknowledged rev.
- **Store refresh.** Queries return `version` = max `Event.id` for the project plus template revision. The store is keyed by projectId; newer props replace server state and re-apply pending optimistic ops. `router.refresh()` is scheduled at the next midnight in the configured timezone, as well as on focus and `visibilitychange`.
- **Events.** `externalRef` is a plain `@@index([source, externalRef])`, **not unique** (one email can produce several events). Phase 2 adds `InboundItem(id, source, externalRef @unique, receivedAt, from, subject, bodyPreview, status, redactedAt?)` for idempotency; events reference it. Worker cursor is `(recordedAt, id)` with a safety lag, not `Event.id` alone (Postgres sequences are not commit-ordered). A `scripts/redact.ts` (drop trigger, redact payload, re-create trigger, append `system.redacted`) is a Phase 2 deliverable. `User.externalId` is added for Entra; never re-key `local`.
- **Phase 4 money** uses `Decimal @db.Decimal(18,2)` or BigInt minor units, never Int.

### State, dates and display
- **Flag precedence.** N/A > flag > value. A value write that produces DONE or N/A clears the flag in the same transaction (logged as `node.flag_changed`, toast "Flag cleared"). A date that passes by itself does not clear the flag, so a flagged FAT date stays red until handled.
- **DATE_PASSED_AUTO** clock marker can be cleared with "Confirm it happened", which sets `valueSetAt` to now (logged).
- **stateChangedAt** on ProjectNode is set whenever a write changes the derived state category. My open items sorts by it ("in progress for 12d"). `lastChangedAt` stays for the List view.
- **Open items chips.** "Include date-driven items" (off) hides DATE_PLANNED, RANGE_UPCOMING **and RANGE_RUNNING**. "+ Waiting" (off).
- **Date boundary.** One conversion module in `src/domain/dates`: `toYmd(d)` from local parts and `fromYmd(s) = new Date(y, m-1, d)`. A grep test bans `toISOString().slice` and `new Date('YYYY-MM-DD')` in `src`. The Calendar gets the server's `today` prop. Typed "3 Jan" resolves to the year that puts it within ±6 months of today, and the resolved full date is shown before saving. `todayIn` uses `formatToParts`. Relative times render after mount from a server-supplied `now`. Excel instants are converted to timezone wall-clock parts, then `Date.UTC(parts)`.
- **Dropdowns start empty** (Not started), not on their first choice.

### Library, choices and keys
- **Keys and choice ids.** Slugify truncates to 48 characters at a word boundary before any numeric suffix; empty slugs (Chinese or symbol-only labels) fall back to `c-<6 base36>`. Uniqueness checks include archived ids. The seed JSON uses short hand-picked keys (e.g. `pre-po-approval`). A test checks every seed key and choice id.
- **Copy choices from…** matches by label and mints a new id when a source id collides with an archived id here.
- **"Same choices as 54".** 55–58 are separate copies. The choice editor offers "Also apply to: …" when other milestones have an identical choice list.
- **One number everywhere.** The displayed "#" is the template flow-order index (Library default sort, List, Portfolio headers, Excel). Library drag-reorder changes only the tie-break between steps with no path between them; otherwise a toast says "Arrows decide the order; change them in Template Flow".
- **Undo is exact.** Bridge edges created by "Reconnect neighbours" are recorded in the batch (`createdByBatchId` on TemplateEdge and ProjectEdge). Restoring the batch archives those bridges if still active, so archive + Undo returns the identical edge set (unit-tested). Archive + Undo nets to no pending sync items.
- **Edge archive reasons.** `archivedReason` (USER, INSERT_AFTER, SYNC, NODE_ARCHIVED, IMPORT) on ProjectEdge and TemplateEdge. Only USER and INSERT_AFTER count as "removed by you" in planSync; SYNC and NODE_ARCHIVED edges are re-offered (checked when they reconnect around a node the template removed). Test: insert M → sync → remove M → sync returns the project to a→b.
- **Lossless type conversions** via pure `convertValue(from, to, value)`: TEXT↔LONG_TEXT, DROPDOWN→MULTIPLE, MULTIPLE→DROPDOWN when 0–1 selected, PERCENT→NUMBER, NUMBER→PERCENT when an integer 0–100, DATE→DATE_RANGE (`{start}`), TEXT→LINK when a valid http(s) URL. Convertible changes are ordinary checked sync items that keep the value. Non-convertible changes on nodes with a value **never clear the value**: the node keeps its old type with a "type differs from template" badge, and the item applies automatically at a later sync once the value is empty. "Adopt and clear" is removed. The same table applies to project-only nodes and ProjectFields.

### Project fields
- **systemKey only on `customer` and `projectType`** (Portfolio filters). End user, Site / country, Product, Quantity and Notes are ordinary fields with stable keys. DROPDOWN↔MULTIPLE retypes are allowed for all fields, including system ones, via `convertValue`; filters accept both shapes.
- **Import and reset never break project-field values.** Project-field choices merge by id (missing → archived, never removed; renames keep the id). Never change the fieldType of a field that has non-empty values. `reset:template` leaves existing ProjectFields alone and only creates missing seed fields. Test: add a choice → import the seed → the project value still resolves.
- FILE is not offered as a project-field type in Phase 1. Archived user-added project fields get an Archive tab; `project_field.created/updated/archived/restored` events.

### Sync
- **Pending changes are computed, not inferred from revision.** `planSync` is pure and cheap (~64 nodes), so the project header, Projects table and Portfolio compute it and show "n template changes pending". Deliberate declines are stored in `Project.syncDismissed` (`{itemId: changeHash}`) and come back if the change itself changes. Revision remains a fast path only.
- **Sync all active projects** (default items only) on `/template`, with a summary and one correlationId per project. This is a small addition beyond the brief; flagged to the user.
- **Item ids carry a hash** of the planned change (`updateChoices:<M.id>:<hash>`). If any selected id is missing from the fresh plan at apply time, apply aborts and the preview reopens.
- `updateDefinition` compares config too. `applySync` always refreshes sortOrder and config silently.
- **Snapshot consistency.** `buildProjectSnapshot` copies all choices including archived ones (with their flag), so a fresh project never shows spurious choice items. Test: create, then plan → empty.
- **Promoted project-only steps.** When an active project-only node matches a new milestone by normalised name and compatible type, planSync offers "Link existing step" (checked) instead of addNode; it sets milestoneId and keeps value, notes and history.
- **Closed projects** hide the banner; Portfolio shows missing-node cells as a plain "—". Sync stays in the ⋯ menu with a warning that progress will change.

### Projects
- **Codes** are unique, editable (logged as `project.code_changed`; old codes kept in history for Phase 2 mapping) and match `^[A-Z0-9][A-Z0-9-]{1,19}$`, so suffixes like `C0822-SP1` work. Optional "Related project" field.
- **#64 Project closed vs Status.** When #64 gets a date on or before today, offer a one-click "Set status to Closed?"; never change status automatically.

### Canvas readability
- **Value line stays in the compact zoom tier** (threshold 0.45): drop indicators and icon, name on one line, both lines larger. Overview tier below ~0.3 only.
- **Wrapped layout fits the viewport:** `ranksPerRow = floor(canvasWidth / (0.55 × (nodeW + ranksep)))`. Consider 184×56 cards with ranksep 40.
- **Acceptance check:** a Playwright screenshot of the seed project at Fit on 1440×900 shows name, value and colour for every node.
- Template minimap is neutral (or coloured by field type); state colours only on project canvases.

### Attachments
- Stored as `data/uploads/<projectId>/<attachmentId>` with no user-derived name; the original name lives only in the DB (avoids APFS 255-byte and NFC/NFD problems).
- `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<encoded>`; the same for the Excel export filename.
- Inline only for a server-sniffed allowlist (pdf, png, jpeg, gif, webp); never svg, html or xml. `Content-Security-Policy: sandbox` and `nosniff` on every download. Tests with a Chinese filename and a 300-byte name.

### Portfolio payload
- Each cell carries only state code, a short value (≤ 24 chars), nodeId and a current flag. Tooltip details (latest note, last changed) load lazily after a 150 ms hover.

### Build order adjustments
- `wouldCreateCycle`, bridging, `restoreBatch` and their tests move into Step 3 (Library archive with Undo needs them).


## 13. Open questions as proposed to the user (defaults)

1. **Should template changes reach existing projects only when you press 'Sync from template' on each project, with a preview first?**
   Default: Yes. Each project is its own copy. A banner says 'Template changed since last sync', and Sync shows a preview with checkboxes. Nothing applies automatically, and there is no 'sync all projects' in Phase 1.

2. **Inside a project, may you rename, retype or delete a milestone that came from the template?**
   Default: No. Name, type and choices come from the Library via Sync, and deleting offers 'Mark Not applicable' instead. Project-only milestones can be fully edited and archived.

3. **Under your mapping, Date, Number and Text milestones (e.g. FAT date, ETA) can never show amber or red. Should every milestone get a small 'Waiting / Blocked' flag?**
   Default: Yes: a per-node Flag (None / Waiting / Blocked, reason saved as a note). It overrides the value colour; only Not applicable ranks above it. Every change is logged.

4. **A planned date turns green on the day it passes, even if the event did not happen. Is that OK?**
   Default: Follow your rule, but mark these nodes with a small clock icon ('turned green because the date passed') when the date was entered in advance. Separate planned vs actual dates can come later.

5. **For 'current milestones', does a Not applicable step count as done?**
   Default: N/A steps are see-through. A step becomes current only when the nearest real steps before it, looking through any N/A ones, are Done.

6. **How should field types your mapping doesn't cover get a colour?**
   Default: Plain Number: any number entered = Done. Long text and Link: work like Text. File: at least one file or link attached = Done. Date range: grey when empty; blue once a date is set; green when the end date is today or earlier (same rule as Date).

7. **What exactly goes into 'My open items'?**
   Default: In progress + Blocked nodes in Active projects (follows the Portfolio filters), oldest first by last change. Chips: '+ Waiting' (off) and 'Include planned dates' (off), so future dates that show blue don't flood the list.

8. **What does reordering in the Milestone Library do now that arrows define the flow?**
   Default: It changes only the list order, and the tie-break between parallel steps. It never moves arrows; you change arrows on the Template Flow canvas. Lists, Excel and Portfolio columns follow the arrows.

9. **Which project details are fixed and which configurable? Is Product one item or several?**
   Default: Fixed: Code (unique), Name, Status (Active / On hold / Closed). Configurable via the Library's 'Project fields' tab:
   - Customer: list, add new ones inline
   - End user: text
   - Site / country: text
   - Product: single choice (AFL, AFL-Compact, ImmSec, ABCS)
   - Quantity: number
   - Project type: list
   - Notes: long text
   
   Customer and Project type can be renamed and their choices edited, but not deleted, because the filters use them.

10. **Archive vs Closed for projects, and project codes?**
   Default: 'Closed' is a status, and the project stays visible under the Status filter. 'Archive' is the only kind of delete: it hides the project everywhere, it can be restored, and its code stays reserved.

11. **During Sync, what happens to arrows and to a template type change?**
   Default: Arrows:
   - touching newly added milestones (and replacing a direct arrow a new step was inserted into): added, ticked by default
   - template re-routing between milestones the project already has: offered, unticked
   - arrows you removed or drew yourself: never changed
   
   Type change: if the node already has a value, it is listed as a conflict and applied only if you tick it. The old value is kept in history and copied into a note.

12. **What does 'reset the seed' mean?**
   Default: Two commands, both back up first:
   - `npm run reset:template` puts the Library and Template Flow back to the seed and keeps your projects.
   - `npm run reset:all` wipes everything and reseeds, after you type RESET.

13. **Can notes be edited or deleted?**
   Default: Yes. Edits are logged as old → new text, and deletes archive the note. The original always stays in the history.

14. **Spare orders, Adhoc and Warranty jobs need far fewer steps. Should they get their own shorter template?**
   Default: Not in Phase 1. There is one template for all projects, and you mark unused steps N/A in bulk from the List view. The data model already allows a template per project type later.

15. **Template import from JSON: merge or replace?**
   Default: Replace, with a preview and an automatic backup first:
   - matching milestones (by their fixed key) are updated
   - new ones are added
   - milestones missing from the file are archived, so you can restore them
   - arrows and positions come from the file
   
   Projects change only when you Sync them.

16. **Time zone and date entry?**
   Default: 'Today' is Singapore time, so date colours flip at Singapore midnight; this can be changed in Settings. Dates are typed day-first (12/11/2026 = 12 Nov 2026), with shortcuts like 'today', '+3d', '+2w'. They always display as '12 Nov 2026'.

17. **Attachments: limits and where they live?**
   Default: Any file type up to 50 MB each, stored in the app's data/uploads folder and included in backups. SharePoint / OneDrive items are stored as links that open in a new tab.

