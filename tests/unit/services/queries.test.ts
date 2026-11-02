import { beforeEach, describe, expect, it } from "vitest";
import type { DayContext } from "@/domain/types";
import { getArchiveData } from "@/server/queries/archive";
import { getProjectHistory, getStepHistory, getTemplateSnapshots } from "@/server/queries/history";
import { getLibraryView, getTemplateView } from "@/server/queries/library";
import { getPortfolioData } from "@/server/queries/portfolio";
import { getCellDetails, getProjectPageData, getProjectsList } from "@/server/queries/projects";
import { getSetupStatus } from "@/server/queries/setup";
import { createMilestone, getTemplate, templateFlowOrder } from "@/server/services/library";
import { listProjectFields } from "@/server/services/projectFields";
import { addNote } from "@/server/services/notes";
import { addLink } from "@/server/services/attachments";
import { archiveProject } from "@/server/services/projects";
import { addProjectStep, archiveProjectStep, bulkSetNotApplicable, setStepFlag, setStepValue } from "@/server/services/steps";
import type { StorageAdmin } from "@/server/repo/types";
import { createProject, milestoneByKey, runImport, seedLibrary, stepByKey, TODAY, TZ, world, type World } from "./_helpers";
import { seedTemplateFile } from "@/domain/seed";

const day: DayContext = { today: TODAY, timeZone: TZ };
const at = (d: string) => `${d}T02:00:00.000Z`;

let w: World;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
});

async function fieldIds() {
  const fields = await listProjectFields(w.repo);
  return { customer: fields.find((f) => f.systemKey === "customer")!.id, type: fields.find((f) => f.systemKey === "projectType")!.id };
}

async function set(projectId: string, key: string, value: unknown, when: string) {
  const s = await stepByKey(w, projectId, key);
  return setStepValue(w.ctx({ now: at(when) }), { stepId: s.id, value, expectedRev: s.rev });
}

describe("getPortfolioData", () => {
  let c0822: string;
  let c0823: string;
  let c0824: string;

  beforeEach(async () => {
    const f = await fieldIds();
    c0822 = await createProject(w, { code: "C0822", name: "Heathrow", details: { [f.customer]: "sita", [f.type]: "project" } });
    c0823 = await createProject(w, { code: "C0823", name: "Changi", details: { [f.customer]: "nec", [f.type]: "spare-order" } });
    c0824 = await createProject(w, { code: "C0824", name: "Dubai", status: "ON_HOLD", details: { [f.customer]: "sita" } });

    await set(c0822, "customer-po-loi", "loi-received", "2026-10-10"); // IP
    await set(c0822, "bom", "requested", "2026-10-01"); // W
    const spec = await stepByKey(w, c0822, "specification-freeze");
    await setStepFlag(w.ctx({ now: at("2026-09-20") }), { stepId: spec.id, flag: "BLOCKED" }); // B (oldest)
    await set(c0822, "fat-date", "2026-11-12", "2026-10-02"); // IP, planned
    await set(c0822, "installation-progress", 60, "2026-10-20"); // IP
    await set(c0822, "warranty-period", { start: "2026-10-01", end: "2027-10-01" }, "2026-10-03"); // IP, range running
    await set(c0823, "proposal-offer", "drafting", "2026-09-25"); // IP
    await set(c0824, "proposal-offer", "drafting", "2026-09-01"); // on hold project
  });

  it("columns are the active template milestones in template flow order", async () => {
    const data = await getPortfolioData(w.repo, day);
    const t = await getTemplate(w.repo);
    expect(data.columns.map((c) => c.milestoneId)).toEqual(templateFlowOrder(t));
    expect(data.columns[0]).toMatchObject({ key: "enquiry-rfq-received", seq: 1 });
    expect(data.columns).toHaveLength(64);

    // A milestone inserted after BOM becomes the next column; unsynced projects show a missing (null) cell.
    const bom = await milestoneByKey(w, "bom");
    const audit = await createMilestone(w.ctx(), { name: "Factory audit", fieldType: "DATE", afterMilestoneId: bom.id });
    const after = await getPortfolioData(w.repo, day);
    const i = after.columns.findIndex((c) => c.milestoneId === bom.id);
    expect(after.columns[i + 1].milestoneId).toBe(audit.id);
    expect(after.rows[0].cells[i + 1]).toBeNull();
    expect(after.rows[0].templateChanged).toBe(true);
  });

  it("rows follow the filters (default Active) and cells derive state with today", async () => {
    const data = await getPortfolioData(w.repo, day);
    expect(data.rows.map((r) => r.code)).toEqual(["C0822", "C0823"]);
    const row = data.rows[0];
    expect(row).toMatchObject({ customer: "SITA", projectType: "Project", status: "ACTIVE" });
    const col = (key: string) => data.columns.findIndex((c) => c.key === key);
    expect(row.cells[col("customer-po-loi")]).toMatchObject({ s: "IP", v: "LOI received" });
    expect(row.cells[col("bom")]).toMatchObject({ s: "W" });
    expect(row.cells[col("specification-freeze")]).toMatchObject({ s: "B" });
    expect(row.cells[col("fat-date")]).toMatchObject({ s: "IP", v: "Plan 12 Nov 2026" });
    expect(row.cells[col("enquiry-rfq-received")]).toMatchObject({ s: "NS", cur: true });
    expect(row.cells.every((c) => c !== null)).toBe(true);
    expect(row.cells.every((c) => (c?.v.length ?? 0) <= 24)).toBe(true);

    // Same data on a later day: the planned date has passed.
    const later = await getPortfolioData(w.repo, { today: "2026-11-13", timeZone: TZ });
    expect(later.rows[0].cells[col("fat-date")]).toMatchObject({ s: "D", v: "12 Nov 2026" });

    expect((await getPortfolioData(w.repo, day, { status: ["ON_HOLD"] })).rows.map((r) => r.code)).toEqual(["C0824"]);
    expect((await getPortfolioData(w.repo, day, { customer: ["nec"] })).rows.map((r) => r.code)).toEqual(["C0823"]);
    expect((await getPortfolioData(w.repo, day, { projectType: ["project"] })).rows.map((r) => r.code)).toEqual(["C0822"]);
    expect((await getPortfolioData(w.repo, day, { q: "chan" })).rows.map((r) => r.code)).toEqual(["C0823"]);
    expect(data.filterOptions.customers.map((c) => c.id)).toEqual(["sita", "idemia", "nec", "collins-aerospace"]);
  });

  it("open items: In progress + Blocked by default, date-driven and Waiting behind chips, oldest stateChangedAt first", async () => {
    const data = await getPortfolioData(w.repo, day);
    expect(data.openItems.map((i) => `${i.code} ${i.milestoneKey} ${i.stateCode}`)).toEqual([
      "C0822 specification-freeze B",
      "C0823 proposal-offer IP",
      "C0822 customer-po-loi IP",
      "C0822 installation-progress IP",
    ]);
    expect(data.hidden).toEqual({ waiting: 1, dateDriven: 2 });
    expect(data.openItems[0]).toMatchObject({ since: at("2026-09-20"), ageDays: 35, flag: "BLOCKED", projectName: "Heathrow" });

    const all = await getPortfolioData(w.repo, day, { includeWaiting: true, includeDateDriven: true });
    expect(all.openItems.map((i) => i.milestoneKey)).toEqual([
      "specification-freeze",
      "proposal-offer",
      "bom",
      "fat-date",
      "warranty-period",
      "customer-po-loi",
      "installation-progress",
    ]);
    expect(all.hidden).toEqual({ waiting: 0, dateDriven: 0 });
    // Open items follow the grid filters.
    expect((await getPortfolioData(w.repo, day, { customer: ["nec"] })).openItems.map((i) => i.code)).toEqual(["C0823"]);
  });

  it("the Other column counts project-only steps with their worst state", async () => {
    const { step } = await addProjectStep(w.ctx(), { projectId: c0822, name: "Site survey", fieldType: "DROPDOWN", choices: [{ label: "Stuck", state: "BLOCKED" }] });
    await setStepValue(w.ctx(), { stepId: step.id, value: "stuck", expectedRev: 0 });
    const data = await getPortfolioData(w.repo, day);
    expect(data.rows[0].other).toEqual({ count: 1, worst: "B", stepIds: [step.id] });
    expect(data.rows[1].other).toEqual({ count: 0, worst: null, stepIds: [] });
  });

  it("archived projects and projects still being created are left out", async () => {
    await archiveProject(w.ctx(), c0823);
    expect((await getPortfolioData(w.repo, day)).rows.map((r) => r.code)).toEqual(["C0822"]);
  });
});

describe("getProjectPageData", () => {
  it("returns steps in flow order with state, display, current flags, notes, attachments, progress and sync info", async () => {
    const id = await createProject(w);
    await set(id, "enquiry-rfq-received", "2026-10-01", "2026-10-01");
    await set(id, "pm-assigned", "2026-10-02", "2026-10-02");
    const bom = await stepByKey(w, id, "bom");
    await addNote(w.ctx({ now: at("2026-10-03") }), { projectId: id, stepId: bom.id, body: "first" });
    await addNote(w.ctx({ now: at("2026-10-04") }), { projectId: id, stepId: bom.id, body: "second" });
    await addLink(w.ctx(), { projectId: id, stepId: bom.id, url: "https://example.com/bom" });
    // N/A steps are see-through: mark 3 and 4 N/A -> 5 is current.
    const s3 = await stepByKey(w, id, "customer-requirements");
    const s4 = await stepByKey(w, id, "technical-qa");
    await bulkSetNotApplicable(w.ctx(), { projectId: id, stepIds: [s3.id, s4.id], notApplicable: true });

    const page = (await getProjectPageData(w.repo, day, id))!;
    expect(page.project).toMatchObject({ code: "C0822", status: "ACTIVE", statusLabel: "Active", setup: "READY" });
    expect(page.steps).toHaveLength(64);
    expect(page.steps.map((s) => s.seq)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(page.steps[0]).toMatchObject({ milestoneKey: "enquiry-rfq-received", state: "DONE", stateCode: "D", display: "1 Oct 2026", projectOnly: false });
    expect(page.currentIds).toEqual([(await stepByKey(w, id, "factory-lead-time-costing")).id]);
    expect(page.steps.find((s) => s.isCurrent)!.milestoneKey).toBe("factory-lead-time-costing");
    const b = page.steps.find((s) => s.id === bom.id)!;
    expect(b).toMatchObject({ noteCount: 2, attachmentCount: 1, latestNote: { body: "second" } });
    expect(b.predecessors).toHaveLength(1);
    expect(page.notes.map((n) => n.body)).toEqual(["second", "first"]);
    expect(page.attachments).toHaveLength(1);
    expect(page.progress).toMatchObject({ done: 2, applicable: 62, pct: 3 });
    expect(page.progress.counts.NOT_APPLICABLE).toBe(2);
    expect(page.flow.edges).toHaveLength(63);
    expect(page.sync).toMatchObject({ pendingCount: 0, templateChanged: false });
    expect(page.details.map((d) => d.label)).toEqual(["Customer", "End user", "Site / country", "Product", "Quantity", "Project type", "Notes"]);
    expect(page.suggestClose).toBe(false);
    expect(page.today).toBe(TODAY);

    // A template change shows up as pending.
    await createMilestone(w.ctx(), { name: "Extra", fieldType: "TEXT" });
    const again = (await getProjectPageData(w.repo, day, id))!;
    expect(again.sync).toMatchObject({ pendingCount: 1, templateChanged: true });
    expect(await getProjectPageData(w.repo, day, "missing")).toBeNull();
  });

  it("flags project-only, not-in-template and archived steps", async () => {
    const id = await createProject(w);
    const { step } = await addProjectStep(w.ctx(), { projectId: id, name: "Local", fieldType: "TEXT" });
    const gone = await addProjectStep(w.ctx(), { projectId: id, name: "Gone", fieldType: "TEXT" });
    await archiveProjectStep(w.ctx(), gone.step.id);
    const file = seedTemplateFile();
    await runImport(w, { ...file, milestones: file.milestones.filter((m) => m.key !== "training"), edges: file.edges.filter((e) => e.from !== "training" && e.to !== "training") });
    const page = (await getProjectPageData(w.repo, day, id))!;
    expect(page.steps.find((s) => s.id === step.id)).toMatchObject({ projectOnly: true, notInTemplate: false });
    expect(page.steps.find((s) => s.milestoneKey === "training")).toMatchObject({ notInTemplate: true });
    expect(page.archivedSteps.map((s) => s.name)).toEqual(["Gone"]);
  });

  it("suggests closing when 'Project closed' has a date on or before today", async () => {
    const id = await createProject(w);
    await set(id, "project-closed", "2026-10-20", "2026-10-20");
    expect((await getProjectPageData(w.repo, day, id))!.suggestClose).toBe(true);
  });
});

describe("other read models", () => {
  it("projects list: progress, current milestone, summary, fast-path template flag", async () => {
    const f = await fieldIds();
    const id = await createProject(w, { details: { [f.customer]: "idemia" } });
    await set(id, "enquiry-rfq-received", "2026-10-01", "2026-10-01");
    const rows = await getProjectsList(w.repo, day);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "C0822",
      customer: "IDEMIA",
      firstCurrent: "PM assigned",
      progress: { done: 1, applicable: 64, pct: 1 },
      templateChanged: false,
      summary: [{ label: "Customer", display: "IDEMIA" }],
    });
  });

  it("library view: flow order, usage, identical choice lists, archived milestones", async () => {
    await createProject(w);
    const view = await getLibraryView(w.repo);
    expect(view.milestones).toHaveLength(64);
    expect(view.milestones[0]).toMatchObject({ seq: 1, key: "enquiry-rfq-received", usedIn: 1, fieldTypeLabel: "Date" });
    const adv = view.milestones.find((m) => m.key === "advance-invoice")!;
    expect(adv.sameChoicesAs).toHaveLength(4);
    expect(view.projectFields).toHaveLength(7);
    expect(view.archived).toEqual([]);
    const tv = await getTemplateView(w.repo);
    expect(tv.flow.edges).toHaveLength(63);
    expect(Object.keys(tv.flow.nodes)).toHaveLength(64);
    expect(tv.unconnected).toEqual([]);
    expect(tv.projectCount).toBe(1);
  });

  it("history DTOs: step and project pages; template snapshots hide their payload", async () => {
    const id = await createProject(w);
    const r = await set(id, "bom", "requested", "2026-10-01");
    const page = await getStepHistory(w.repo, r.step.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: "step.value_changed", stepIds: [r.step.id], newDisplay: "Requested" });
    const proj = await getProjectHistory(w.repo, id, { type: "project.created" });
    expect(proj.items).toHaveLength(1);
    await runImport(w, seedTemplateFile());
    const snaps = await getTemplateSnapshots(w.repo);
    expect(snaps.items).toHaveLength(1);
    expect(snaps.items[0].file?.milestones).toHaveLength(64);
  });

  it("cell details load lazily", async () => {
    const id = await createProject(w);
    const r = await set(id, "bom", "requested", "2026-10-01");
    await addNote(w.ctx(), { projectId: id, stepId: r.step.id, body: "ping PE" });
    expect(await getCellDetails(w.repo, day, r.step.id)).toMatchObject({ state: "WAITING", display: "Requested", latestNote: { body: "ping PE" } });
  });

  it("archive data", async () => {
    const id = await createProject(w);
    const { step } = await addProjectStep(w.ctx(), { projectId: id, name: "Temp", fieldType: "TEXT" });
    await archiveProjectStep(w.ctx(), step.id);
    await archiveProject(w.ctx(), id);
    const data = await getArchiveData(w.repo, { projectId: id });
    expect(data.projects.map((p) => p.code)).toEqual(["C0822"]);
    expect(data.project?.steps.map((s) => s.name)).toEqual(["Temp"]);
    expect((await getArchiveData(w.repo)).project).toBeNull();
  });

  it("setup status adds open jobs", async () => {
    const admin = {
      status: async () => ({ mode: "fake", problems: [], databases: [], schemaReady: true, seeded: true }),
    } as unknown as StorageAdmin;
    expect(await getSetupStatus(admin, w.repo)).toMatchObject({ schemaReady: true, openJobs: [] });
  });
});
