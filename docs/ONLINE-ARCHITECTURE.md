# Online architecture: GitHub + Vercel + Notion

> Supersedes the storage, hosting, setup, backup and login parts of `DESIGN.md` (sections 1–3, 8, 9, 11 and the
> related amendments in section 12). Everything about the domain (field types, state mapping, graph rules,
> template copy, sync planning, screens, keyboard, tests of pure logic) still applies unchanged.

## 1. Decisions

| Topic | Decision | Why |
|---|---|---|
| Hosting | Vercel, Git-connected to `ronnieyap1001/gunnebo_pm`. `main` = production, every other branch = preview URL | User asked for it; preview URLs let the user see each build step in the browser without installing anything |
| Database | Notion, via an **internal integration** (token in Vercel env `NOTION_TOKEN`) on a parent page "Gunnebo PM" shared with that integration | User asked for it; data stays visible and filterable in Notion |
| Notion API | `@notionhq/client` 5.28.0 with `notionVersion: "2025-09-03"` (data sources) | Current API; databases are containers, rows live in data sources |
| Login | Single password (`APP_PASSWORD` env). Signed, httpOnly, Secure, SameSite=Lax session cookie (jose HS256, 30 days). Key = HKDF(APP_PASSWORD ‖ optional SESSION_SECRET); changing the password signs everyone out | The app is on the public internet with customer data; this is the simplest safe login for one user. Microsoft sign-in can replace it in Phase 2 |
| Local dev | `npm run dev` without `NOTION_TOKEN` uses an in-memory **fake Notion** persisted to `data/fake-notion.json` (gitignored) | Lets the developer (and the user, optionally) run and test everything without a token; e2e tests and screenshots use it |
| Files | Uploaded through a route handler (≤ 4 MB, under Vercel's 4.5 MB request body limit and Notion Free's 5 MiB file limit) into Notion's File Upload API, attached to a `files` property. Bigger files: paste a SharePoint / OneDrive link | Keeps all data in Notion; no extra storage service; no public file URLs |
| Speed | Each Project page row carries a compact **Cells** JSON (state inputs, short value, step id per milestone) and Progress/Current mirrors, rewritten on every step write. Portfolio reads only the Projects data source. Library/template reads cached with tag invalidation | Notion queries are ~150–400 ms each and limited to ~3/s; Portfolio must not query 2,000 step rows |
| Rate limit | One client-side limiter in the server: concurrency 3, 429/529 honoured via `Retry-After` + jittered backoff (max 5 retries), never retry non-idempotent writes on 5xx without re-reading | Notion: 180 req/min per connection (Free/Plus), burstable; query endpoint ~3 rps |
| Long operations | Project creation, sync apply, setup/seed and bulk actions are **client-driven batches**: the browser calls a server action repeatedly with a cursor until done, showing progress | No single function call risks Vercel's duration limit; a dropped call is resumed, not repeated, because each batch is idempotent |
| Append-only history | The app only ever creates History rows. Notion itself cannot prevent a person from editing them; Notion page history covers that. Documented | Honest limit of using Notion as the database |

## 2. Notion layout (created automatically by the Setup screen)

Parent page **Gunnebo PM** (user creates it and connects the integration). Setup creates these databases inside it,
idempotently (found again by title on later runs), then seeds the Library. IDs of databases and data sources are
discovered at runtime (list the parent's child databases, then retrieve each) and cached.

All relation properties are `single_property` except **Steps.Project**, which is `dual_property` (so a project page
in Notion shows its steps).

Large JSON values are stored in a `rich_text` property split into 2,000-character text items (max 100 items ⇒ 200 KB).
Helpers: `jsonToRichText`, `richTextToJson`, `textToRichText`, `richTextToText`.

### Milestones (Library)
| Property | Type | Notes |
|---|---|---|
| Name | title | |
| Key | rich_text | fixed slug for automations, never changed by renames |
| Field type | select | Text, Long text, Number, Number (%), Date, Date range, Dropdown, Multiple, Checkbox, Link, File |
| Choices | rich_text (JSON) | `[{id,label,state?,archived?}]` |
| Choices (readable) | rich_text | "Awaiting [W] · LOI received [IP] …" mirror for people browsing Notion |
| Config | rich_text (JSON) | unit etc. |
| Description | rich_text | |
| Order | number | library order / flow tie-break |
| Archived | checkbox | soft delete |
| Archived at | date | |
| Archive batch | rich_text | |

### Settings
| Property | Type | Notes |
|---|---|---|
| Key | title | `template.flow`, `template.revision`, `app.timezone`, `app.displayName`, `schema.version`, `seed.appliedAt` |
| Value | rich_text (JSON) | |

`template.flow` = `{nodes: {[milestoneId]: {x, y}}, edges: [{id, from, to, createdAt, archivedAt?, archivedReason?, batchId?}]}`.

### Project fields (configurable details)
Label (title), Key, Field type (select), Choices (JSON), Config (JSON), Order (number), Show in summary (checkbox),
System key (rich_text: `customer` | `projectType`), Archived (checkbox).

### Projects
| Property | Type | Notes |
|---|---|---|
| Code | title | unique (app-enforced), upper-cased |
| Name | rich_text | |
| Status | select | Active / On hold / Closed |
| Customer | select | mirror of the Customer detail field (filters in Notion) |
| Project type | select | mirror |
| Summary | rich_text | "SITA · AFL-Compact × 24 · Heathrow T5" mirror |
| Details | rich_text (JSON) | source of truth for configurable field values `{[fieldId]: value}` |
| Flow | rich_text (JSON) | `{nodes:{[stepId]:{x,y}}, edges:[{id, from, to, templateEdgeId?, createdAt, archivedAt?, archivedReason?, batchId?}]}` |
| Cells | rich_text (JSON) | `{[stepId]: {k: milestoneKey?, t: fieldType, s: stateInputs, v: shortValue, c: stateChangedAt}}` |
| Progress | number (percent) | mirror |
| Current | rich_text | mirror: names of current milestones |
| Template revision | number | last synced revision |
| Sync dismissed | rich_text (JSON) | `{itemId: changeHash}` |
| Setup | select | Creating / Ready (project creation is resumable) |
| Archived | checkbox, Archived at (date) | |

### Steps (project nodes)
| Property | Type | Notes |
|---|---|---|
| Name | title | snapshot of milestone name (or project-only name) |
| Project | relation → Projects (dual: "Steps") | |
| Milestone | relation → Milestones | empty ⇒ project-only |
| Milestone key | rich_text | |
| Field type | select | snapshot |
| Choices | rich_text (JSON) | snapshot with stable choice ids |
| Config | rich_text (JSON) | |
| Description | rich_text | |
| Value data | rich_text (JSON) | source of truth, zod-validated |
| Value | rich_text | readable mirror ("Full PO", "12 Nov 2026") |
| Date | date | mirror for Date / Date range (Notion calendar views) |
| State | select | mirror with Notion colours (gray/blue/yellow/red/green/default); app always re-derives |
| Not applicable | checkbox | |
| Flag | select | Waiting / Blocked |
| Order | number | tie-break |
| Value set at, State changed at, Last changed at | date (with time) | |
| Rev | number | optimistic concurrency (read-compare-write; single user) |
| Archived | checkbox, Archived at (date), Archive batch (rich_text) | project-only steps only |

### History (append-only change log)
Summary (title, e.g. "C0822 · Customer PO / LOI: Awaiting → Full PO"), Project (relation), Step (relation),
Milestone key, Type (select), Source (select: Manual / Email / System), Actor, Old value, New value, Data (JSON:
raw old/new, states, payload), Correlation, External ref, Occurred at (date). Recorded = Notion `created_time`.

### Notes
Title (title: first line), Body (rich_text, chunked), Project (relation), Step (relation), Author, Archived, Edited at.

### Files & links
Name (title), Project (relation), Step (relation), Kind (select: File / Link), Link (url), File (files), Size (number),
Content type (rich_text), Archived.

## 3. Request budget per action (cold, no cache)

| Action | Requests |
|---|---|
| Open Portfolio | 1–2 (Projects query; pages of 100) |
| Open a project | 4 in parallel: project page, Steps query, Notes query, Files query |
| Open a step's history | 1 (History query filtered by Step, newest first, 25) |
| Change a value | GET step → PATCH step → in parallel: POST History, (Steps query → PATCH Project cells/progress) ≈ 5 |
| Create a project | 1 project + ~64 steps + 1 Flow/Cells update + 1 History ≈ 67, in client-driven batches of 8 |
| Template node drag / auto-layout | 1 (Settings `template.flow`) |
| Library reorder | 1 (fractional Order) |

## 4. Setup flow (first visit)

1. No `APP_PASSWORD` ⇒ a static page explains which Vercel settings to add. No data is reachable.
2. Login.
3. No `NOTION_TOKEN` (production) ⇒ Setup page explains how to create the integration.
4. Token present ⇒ app searches pages shared with the integration for one titled "Gunnebo PM" (or uses
   `NOTION_PARENT_PAGE_ID`). None ⇒ explain how to connect the page.
5. Databases missing ⇒ "Create databases and load the 64 milestones" button; runs in batches with a progress bar.
6. Done ⇒ Portfolio.

## 5. Security

- `src/proxy.ts`: every route except `/login`, `/api/health`, `/_next/*`, static files requires a valid session.
  Server actions and route handlers also call `requireUser()` (defence in depth).
- Login: constant-time compare, 800 ms delay on failure, password must be ≥ 12 characters or the app refuses to run.
- Secrets only in Vercel env; never in git, never logged, never sent to the browser.
- Downloads stream through `/api/files/[id]` (session-checked) with a 302 to Notion's short-lived signed URL;
  inline only for pdf/png/jpeg/gif/webp; `Content-Disposition` RFC 5987 encoding.
- Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`.

## 6. Code layout

```
src/domain/          pure logic (unchanged from DESIGN.md): fieldTypes, values, state, format, dates, graph,
                     layout, convertValue, snapshot, syncPlan, templateFile, seed
src/server/notion/   client.ts (real + limiter), fake.ts (in-memory + file persistence), schema.ts (database
                     definitions), richtext.ts (chunking), bootstrap.ts (discover/create databases, seed)
src/server/repo/     typed repositories mapping Notion pages <-> domain models
src/server/services/ business operations; every mutation writes History
src/server/auth/     session, requireUser
src/app/             routes (login, portfolio, projects, library, template, archive, settings, setup, api/*)
src/components/      ui (shadcn), flow (canvas, node card), fields (value editors), grid
```

## 7. Later phases

- Phase 2: a Vercel cron (or a manual "Check mail" button) reads Outlook via Microsoft Graph and calls the same
  services with `source: Email` and `externalRef`. Login moves to Microsoft Entra ID at the same time.
- Phase 3: SharePoint filing adds Files rows with Kind = SharePoint.
- Phase 4: commercial records become another Notion database related to Projects.
- If Notion ever becomes too slow, `src/server/repo` can be re-implemented on Postgres without touching screens.

## 8. Review amendments (override sections 1–7 where they differ)

Source: `docs/reviews/2026-10-25-notion-vercel-review.md`.

### Notion workspace and plan
- Requires a **single-member Free** workspace or any paid plan. Free workspaces with more than one member get only 1,000 lifetime
  blocks through internal integrations (403 `restricted_resource`, `additional_data.block_limit = 'block_creation'`). Map that error
  to a plain message on Setup and on every write.
- Notion page history lasts 7 days on Free (30 Plus, 90 Business). It is not a backup.

### Client and rate limits
- `new Client({ auth, notionVersion: '2025-09-03', timeoutMs: 20_000, retry: { maxRetries: 3, initialRetryDelayMs: 500, maxRetryDelayMs: 8_000 } })`.
  The SDK already retries 429/529 (all methods) and 500/503 (GET/DELETE). **No second retry loop.** Add only a per-instance
  concurrency gate (3 in flight). Handle 409 `conflict_error` by re-reading and retrying once. On a 503 for a write, re-read before retrying.
- If a batch hits a long Retry-After, return "Notion is busy, resuming" to the client-driven batch instead of sleeping.
- Export `maxDuration = 60` on pages whose Server Actions run batches (Hobby cap 300).

### Schema registry and discovery
- Setup records, for each database: database id, data source id, and **every property id**. Writes key properties by id; reads map
  page properties through each value's `id`. A user renaming a property in Notion therefore does not break the app.
- Databases carry a marker in their description (`gunnebo-pm:<name>:v1`). Discovery lists the parent page's child databases
  (`blocks.children.list`, `child_database` blocks), retrieves each, and matches by marker (fall back to title). Two matches ⇒ warn.
- The registry is cached with `unstable_cache(['schema', SCHEMA_VERSION], { tags: ['schema'], revalidate: 3600 })`; on
  `object_not_found` drop the cache and rediscover.
- After creating Steps, read `relation.dual_property.synced_property_id` and rename the back-relation on Projects to "Steps".
- Lock every app database's schema in the Notion UI with `databases.update({ is_locked: true })` after setup.
- Pre-create select options with colours for State, Status, Flag, Field type, Kind, Source, Type. Select mirror names are sanitised
  (commas → " ·", max 100 chars). New Customer / Project type choices are added to the mirror select via `dataSources.update` first.
- Parent page: `NOTION_PARENT_PAGE_ID` if set (validated with `pages.retrieve`), else `search` for an exact-title page whose parent is
  the workspace or a page. Production looks for **"Gunnebo PM"**; preview deployments (`VERCEL_ENV=preview`) look for
  **"Gunnebo PM (Preview)"** so test builds never touch real data. Several matches ⇒ ask for `NOTION_PARENT_PAGE_ID`.

### Writes, idempotency and consistency
- Notion has no transactions or idempotency keys. Every user action gets an **opId** (UUID created in the browser, passed through).
  - Steps carry **Step key** = `<projectId>:<milestoneId or tempId>`; creation batches first query existing Step keys and skip them.
  - History rows carry **Op id**; before appending, the service checks (per op, cached in memory for the request) that the op was not
    already logged. Steps carry **Last op**; a repeated write with the same opId is skipped.
- Write order for a value change: GET step → PATCH step → PATCH project cell (read-modify-write of `Cells`, one cell) → POST History.
  The browser serialises all writes **per project** (one in flight), so cells never race within a tab.
- **Reconcile on open:** the project page already loads every Step, so it recomputes Cells, Progress and Current and PATCHes the
  Project when they differ. Settings has a "Repair mirrors" action that does the same for all projects.
- `Rev` is stale-tab detection only (read-compare-write), not a lock.
- Long operations (create project, sync, import, reset) persist a **job** (`Settings` key `job:<opId>`: planned items with hashes and a
  `done` list). Batches apply items from the job, never from a fresh plan, so a resumed batch neither repeats nor skips work.
- Progress is written to Notion as `pct / 100` (the percent format multiplies by 100).

### History
- Extra properties: **Seq** (number: epoch ms × 1000 + counter), **Op id**, **Hash** = sha256 of the canonical row content.
  Order by Seq, never by `created_time` (minute-truncated). Exact instants live in Data JSON and Occurred at.
- Settings → "Verify history" recomputes hashes and reports edited rows. History is **tamper-evident, not tamper-proof**; say so.
- The History database is locked after setup.

### Files
- Max 4 MB per upload (Vercel 4.5 MB request cap; Notion Free 5 MiB). Checked in the browser and again in the route handler
  (Content-Length first). Unsupported types for Notion (e.g. `.msg`, `.eml`) ⇒ suggest zipping or a SharePoint link.
- Downloads: `/api/files/[id]` re-reads the page every time (signed URLs expire after 1 h) and **streams** the bytes with the app's
  own headers (RFC 5987 `Content-Disposition`, inline only for pdf/png/jpeg/gif/webp, `nosniff`, `CSP: sandbox`,
  `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`). Files larger than 4 MB added directly in Notion ⇒ 302.
- Route handlers that change data check `Origin` / `Sec-Fetch-Site: same-origin` (no built-in CSRF check outside Server Actions).

### Backups and reset
- Settings → **Download full backup**: the browser pages through every data source via Server Actions and builds one JSON file
  (handles the 10,000-row query cap). Records `lastBackupAt`; the sidebar warns after 7 days without a backup.
- Before every template import or reset, the current template export is stored as a History row (type `template.snapshot`).
- Settings → **Reset template to seed** (projects kept; runs the seed through the importer as a job).
- Settings → **Start over** (type RESET): download prompt first, then moves the app databases to Notion's trash
  (`in_trash: true`, recoverable for 30 days) and reruns Setup.
- Notion's own workspace export is the second copy (README explains how).

### Login and security
- Session key = HKDF-SHA256(ikm = `SESSION_SECRET` if set, else `NOTION_TOKEN`; salt = sha256(`APP_PASSWORD`);
  info = `gpm-session-v1:<VERCEL_ENV>`). A leaked cookie never becomes an offline password-guessing oracle, and rotating the
  password or the Notion secret signs everyone out (after redeploy). Token = HMAC-SHA256 signed payload via Web Crypto
  (no extra dependency), `{ v: 1, iat, exp, epoch }`, 30-day absolute and 7-day idle limit (sliding refresh).
- Cookie `__Host-gpm_session` (Secure in production, HttpOnly, SameSite=Lax, Path=/).
- `APP_PASSWORD` must be ≥ 16 characters; README recommends 4–5 random words. Recommend turning on **Vercel Authentication →
  All Deployments** (free on Hobby) so only the owner's Vercel login can reach the app at all, plus one WAF rate-limit rule on
  `POST /login` (10 per 10 min per IP).
- Settings → "Sign out everywhere" bumps `auth.epoch` (cached 60 s per instance).
- `src/proxy.ts` matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `robots.txt`, `login`, `api/health`, `api/cron`.
  Requests with a `next-action` header and no session get `401` JSON (the client shows "Session expired, sign in again" and keeps
  the queued change) instead of a redirect.
- `/login?next=` accepts relative paths only. Headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Robots-Tag: noindex`.
- `import 'server-only'` in every `src/server/**` module. Notion errors are mapped to plain messages; request bodies are never echoed.
- The fake Notion is allowed only when `!process.env.VERCEL && !process.env.NOTION_TOKEN`. On Vercel without a token the app
  shows Setup instructions.

### DESIGN.md section 12 bullets that change online
- Removed: the 421 Host check (it would block Vercel), instrumentation-based backups, `npm ci` / doctor / app.lock / migrations.
- Kept: Origin check on non-GET route handlers, hotkey rules, dates boundary, client write queue (now per project), store refresh
  on focus and at midnight, lossless type conversions, sync rules, Undo exactness, attachments header rules (via streaming).

### Region and caching
- `vercel.json` `regions: ["pdx1"]` (Notion's US data is in us-west-2; Hobby allows one region).
- `cacheComponents: false`; pages render per request. Library, project fields, template flow and the schema registry are cached with
  `unstable_cache(..., { tags, revalidate: 60 })`; Server Actions call `updateTag(tag)`, Route Handlers `revalidateTag(tag, { expire: 0 })`.
  A "Reload from Notion" button clears the caches.

### Vercel plan
- Vercel's Hobby plan is for non-commercial personal use. Work use normally needs Pro. The app is designed to Hobby limits so it runs on both;
  the owner decides. The owner should also confirm that Gunnebo allows customer project data in Notion and on Vercel.
