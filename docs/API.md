# Business layer API (for screens)

> Generated from the services verifier report (2026-10-25). Source of truth is the code in src/server/services and src/server/queries.

## Exported API
Every service takes `ctx` first and throws `AppError(code, message, details?)`.

**Steps.** Write results are `StepWriteResult = {step: StoredStep, project: {progress, cells}, changed, flagCleared?, suggestClose?}`.
- `setStepValue(ctx, {stepId, value: unknown, expectedRev: number})`
- `setStepNotApplicable(ctx, {stepId, notApplicable, expectedRev})`
- `setStepFlag(ctx, {stepId, flag: NodeFlag | null, reason?, expectedRev?})`, which also returns `noteId?`
- `confirmStepDate(ctx, stepId, expectedRev?)`
- `bulkSetNotApplicable(ctx, {projectId, stepIds (at most 16), notApplicable}) → {changedIds, project}`
- `addProjectStep(ctx, {projectId, name, fieldType, description?, choices?, config?, afterStepId?, position?})`
- `updateStepDefinition(ctx, stepId, {name?, description?, fieldType?, choices?, config?}, {expectedRev?, clearValue?}?)`
- `archiveProjectStep(ctx, stepId, {reconnect?}?) → {batchId, project}`
- `restoreProjectBatch(ctx, projectId, batchId) → {restoredIds, skippedEdgeIds, project}`
- `moveProjectNodes(ctx, projectId, positions)`, `addProjectEdge(ctx, projectId, from, to) → FlowEdge`, `archiveProjectEdge(ctx, projectId, edgeId)`, `layoutProject(ctx, projectId, {wrap?, viewportWidth?}?) → Flow`

**Library**
- `getTemplate(repo)`, `templateFlowOrder(template)`
- `createMilestone(ctx, {name, fieldType, description?, choices?, config?, afterMilestoneId?, position?}) → Milestone`
- `updateMilestone(ctx, id, {name?, description?, fieldType?, choices?, config?}) → Milestone`
- `applyChoicesTo(ctx, sourceId, targetIds) → {updatedIds}`
- `reorderMilestone(ctx, id, {beforeId?, afterId?}) → {milestone, effective}`
- `archiveMilestone(ctx, id, {reconnect?}?) → {batchId, archivedEdgeIds, bridgeEdgeIds}`
- `restoreBatch(ctx, batchId) → {restoredIds, restoredEdgeIds, skippedEdgeIds}`
- `restoreMilestone(ctx, id) → {restoredIds, skippedEdgeIds}`
- `moveTemplateNodes(ctx, positions)`, `addTemplateEdge(ctx, from, to) → FlowEdge`, `archiveTemplateEdge(ctx, edgeId)`, `layoutTemplate(ctx, {wrap?, viewportWidth?}?) → Flow`

**Project fields**
- `listProjectFields(repo, {includeArchived?}?)`
- `createProjectField(ctx, {label, fieldType, choices?, config?, showInSummary?})`
- `updateProjectField(ctx, id, {label?, fieldType?, choices?, config?, showInSummary?, order?})`. A blocked type change throws VALIDATION with `details.blocking`.
- `addProjectFieldChoice(ctx, fieldId, label) → {field, choiceId}`
- `archiveProjectField(ctx, id)` (FORBIDDEN for system fields), `restoreProjectField(ctx, id)`

**Projects**
- `startCreateProject(ctx, {code, name, status?, details?}) → {projectId, total}`
- `continueCreateProject(ctx, opId) → {done, message, fraction, total, doneCount, projectId, created}`
- `updateProject(ctx, id, {code?, name?, status?, details?}) → {project, changes}`
- `archiveProject(ctx, id)`, `restoreProject(ctx, id)`, `reconcileProject(ctx, projectId) → {changed}`

**Notes and attachments**
- `addNote(ctx, {projectId, stepId?, body})`, `editNote(ctx, {projectId, noteId, body})`, `archiveNote(ctx, {projectId, noteId})`, `restoreNote(ctx, {projectId, noteId})`, all returning `Note`
- `addLink(ctx, {projectId, stepId?, name?, url})`, `addFile(ctx, {projectId, stepId?, name, contentType, size, data: Blob})`, `archiveAttachment(ctx, id)`, `restoreAttachment(ctx, id)`, all returning `{attachment, project}`
- `openAttachment(repo, id) → FileDownload`

**Sync**
- `previewSync(ctx, projectId) → {projectId, items: (SyncItem & {dismissed})[], warnings, templateRevision, projectRevision, pendingCount}`
- `startSync(ctx, {projectId, selectedIds, dismissUnselected? = true}) → {total}`
- `continueSync(ctx, opId) → JobStepResult & {projectId, appliedItemIds?}`
- `startSyncDefaults(ctx, projectId) → {total, itemCount}`, `listSyncTargets(repo)`

**Template file**
- `exportTemplate(repo, exportedAt?)`
- `previewImport(ctx, json, {reason?}?) → summary`
- `startImport(ctx, json, {reason: 'import' | 'seed' | 'reset'}) → {total, summary}`
- `startSeed(ctx)`, `startResetTemplate(ctx)`, `continueImport(ctx, opId) → JobStepResult`

**Settings and maintenance**
- `getAppSettings(repo)`, `setTimeZone(ctx, tz)`, `setDisplayName(ctx, name)`, `recordBackup(ctx) → Iso`
- `exportBackupPage(admin, database, cursor)`
- `verifyHistoryPage(ctx, cursor, limit = 100) → {checked, mismatches, unhashed, nextCursor}`
- `listProjectIdsForRepair(repo)`, `repairMirrorsBatch(ctx, ids (at most 5)) → {checked, repaired}`
- `startOver(admin, "RESET")`

**Jobs and context**
- `listOpenJobs(repo)`, `getJobStatus(repo, opId)`
- `makeCtx(repo, {actor?, opId?, source?, now?, timeZone?, today?, correlationId?, externalRef?})`, `makeCtxFromSettings(repo, opts)`, `isAppError(err)`

**Queries** (`@/server/queries`; only `cached.ts` imports `next/*`)
- `getLibraryView()`, `getTemplateView()`
- `getProjectsList({includeArchived?}?)`, `getProjectPageData(id) → ProjectPageData | null`, `scheduleReconcile(projectId)`
- `getPortfolioData(filters?)` with filters `{status?, customer?, projectType?, q?, includeWaiting?, includeDateDriven?}`
- `getArchiveData({projectId?}?)`, `getCellDetails(stepId)`
- `getStepHistory(stepId, cursor?, limit?)`, `getProjectHistory(projectId, {type?, source?}?, cursor?, limit?)`, `getAllHistory(filters?, cursor?, limit?)`, `getTemplateSnapshots(cursor?)`
- `getSetupStatus()`, `getSettingsData()`, `getDay(now?)`, `getActionCtx({opId, source?, correlationId?, externalRef?})`
- `TAGS = {library: 'library', projectFields: 'project-fields', settings: 'settings'}`

What changed for the UI: none of the signatures above changed. The batch id returned by an archive now equals the action's opId (keep using the returned value for Undo). A new arrow's id is `e:<opId>`. Use one opId per call. An invalid `position` or a `viewportWidth` outside 200–20,000 is ignored rather than stored.


## Residual risks
- **The browser must retry with the same opId.** With History written first, a failed action that is never retried leaves a row for a change that didn't land. The UI's write queue must retry failed writes with the original opId.
- **Server Actions must catch `AppError`.** In production, Next masks errors thrown from Server Actions, so the actions need to catch it and return `{code, message, details}`.
- **Notion query lag.** All retry checks (`hasOp`, stepKey, `findByCode`, orphan adoption) read through Notion queries, which can lag a fresh write by a few seconds. A very fast retry could still duplicate.
- **Step writes after a crash.** A crash between the step write and the History append still gives a `resumed` row without the old value.
- **Orphan adoption is a heuristic.** It looks back 15 minutes and at the newest 100 History rows of that type.
- **Settings growth and size.** Finished-job records pile up in Settings. Job plans and template snapshots are bounded by Notion's ~200 KB text limit, so importing a file near the 1 MB maximum would fail to save its job.
- **Import replaces the template flow.** Template edits made while an import job is paused are lost when it finishes.
- **No lock.** Two tabs editing the same project can lose a cell update until reconcile runs, and two sync jobs on one project aren't locked (values, choices and flow are now protected).
- **Revision bumps.** A retried action can bump the template revision twice; this is harmless.