/**
 * Single actions: crash at every write, retry with the same opId (as the browser's write queue does), and compare the
 * end state with an uninterrupted run. Every action must end in the same state with exactly one History row.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EV } from "@/server/services/context";
import { addFile, addLink, archiveAttachment, restoreAttachment } from "@/server/services/attachments";
import { setDisplayName, setTimeZone } from "@/server/services/admin";
import {
  addTemplateEdge,
  applyChoicesTo,
  archiveMilestone,
  archiveTemplateEdge,
  createMilestone,
  reorderMilestone,
  restoreBatch,
  updateMilestone,
} from "@/server/services/library";
import { addNote, archiveNote, editNote, restoreNote } from "@/server/services/notes";
import {
  archiveProjectField,
  createProjectField,
  listProjectFields,
  restoreProjectField,
  updateProjectField,
} from "@/server/services/projectFields";
import { archiveProject, restoreProject, updateProject } from "@/server/services/projects";
import {
  addProjectEdge,
  addProjectStep,
  archiveProjectEdge,
  archiveProjectStep,
  restoreProjectBatch,
  setStepFlag,
  setStepNotApplicable,
  setStepValue,
  updateStepDefinition,
} from "@/server/services/steps";
import type { Ctx } from "@/server/services/context";
import { createProject, milestoneByKey, seedLibrary, stepByKey, world, type World } from "./_helpers";

interface Setup {
  w: World;
  projectId: string;
  /** Ids prepared before the action. */
  ids: Record<string, string>;
}

/** A snapshot of everything an action could touch, with ids replaced by stable names. */
async function snapshot(s: Setup) {
  const { w, projectId } = s;
  const steps = await w.repo.steps.listByProject(projectId, { includeArchived: true });
  const ms = await w.repo.milestones.list({ includeArchived: true });
  const name = new Map<string, string>([...steps.map((x) => [x.id, x.milestoneKey ?? x.name] as const), ...ms.map((m) => [m.id, m.key] as const)]);
  const p = (await w.repo.projects.get(projectId))!;
  const flow = (await w.repo.settings.get<{ edges: { from: string; to: string; archivedAt?: string }[] }>("template.flow"))!;
  const fields = await listProjectFields(w.repo, { includeArchived: true });
  const settings = await w.repo.settings.list("app.");
  return {
    settings,
    project: { code: p.code, name: p.name, archived: p.archived, details: Object.values(p.details), progress: p.progress },
    cells: Object.entries(p.cells).map(([id, c]) => `${name.get(id)}:${JSON.stringify({ ...c, c: undefined, vs: undefined, m: c.m ? name.get(c.m) : undefined })}`).sort(),
    edges: p.flow.edges.filter((e) => !e.archivedAt).map((e) => `${name.get(e.from)}->${name.get(e.to)}`).sort(),
    steps: steps
      .map((x) => `${x.milestoneKey ?? x.name}:${x.fieldType}:${JSON.stringify(x.value)}:${x.notApplicable}:${x.flag}:${x.archived}:${x.rev}`)
      .sort(),
    milestones: ms.map((m) => `${m.key}:${m.name}:${m.archived}:${m.order}:${JSON.stringify(m.choices)}`).sort(),
    templateEdges: flow.edges.filter((e) => !e.archivedAt).map((e) => `${name.get(e.from)}->${name.get(e.to)}`).sort(),
    notes: (await w.repo.notes.listByProject(projectId, { includeArchived: true })).map((n) => `${n.body}:${n.archived}`).sort(),
    attachments: (await w.repo.attachments.listByProject(projectId, { includeArchived: true })).map((a) => `${a.name}:${a.archived}`).sort(),
    fields: fields.map((f) => `${f.key}:${f.fieldType}:${f.archived}`),
    history: (await w.repo.history.listAll({ limit: 100 })).items.map((e) => e.type).sort(),
  };
}

async function matrix(
  prepare: (s: Setup) => Promise<void>,
  action: (s: Setup, ctx: Ctx) => Promise<unknown>,
  historyType: string,
): Promise<void> {
  const run = async (k: number | null) => {
    const w = world();
    await seedLibrary(w);
    const s: Setup = { w, projectId: await createProject(w), ids: {} };
    await prepare(s);
    const opId = randomUUID();
    const rowsBefore = (await w.repo.history.listAll({ type: historyType, limit: 100 })).items.length;
    const writesBefore = w.repo.writeCount();
    if (k !== null) {
      let n = 0;
      w.repo.beforeWrite = (op) => {
        if (++n === k) {
          w.repo.beforeWrite = null;
          throw new Error(`crash at write ${k} (${op})`);
        }
      };
    }
    for (let i = 0; i < 5; i++) {
      try {
        await action(s, w.ctx({ opId }));
        break;
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("crash")) throw e;
      }
    }
    w.repo.beforeWrite = null;
    const rows = (await w.repo.history.listAll({ type: historyType, limit: 100 })).items.length - rowsBefore;
    return { state: await snapshot(s), rows, writes: w.repo.writeCount() - writesBefore };
  };
  const clean = await run(null);
  expect(clean.rows).toBe(1);
  for (let k = 1; k <= clean.writes; k++) {
    const r = await run(k);
    expect(r.rows, `History rows after a crash at write ${k}`).toBe(1);
    expect(r.state, `state after a crash at write ${k}`).toEqual(clean.state);
  }
}

const nothing = async () => {};

describe("single actions: crash at every write, retry with the same opId", { timeout: 120_000 }, () => {
  it("setStepValue", () =>
    matrix(nothing, async (s, ctx) => {
      const po = await stepByKey(s.w, s.projectId, "customer-po-loi");
      await setStepValue(ctx, { stepId: po.id, value: "full-po", expectedRev: 0 });
    }, EV.stepValueChanged));

  it("setStepNotApplicable", () =>
    matrix(nothing, async (s, ctx) => {
      const po = await stepByKey(s.w, s.projectId, "customer-po-loi");
      await setStepNotApplicable(ctx, { stepId: po.id, notApplicable: true, expectedRev: 0 });
    }, EV.stepNaChanged));

  it("setStepFlag with a reason", () =>
    matrix(nothing, async (s, ctx) => {
      const bom = await stepByKey(s.w, s.projectId, "bom");
      await setStepFlag(ctx, { stepId: bom.id, flag: "BLOCKED", reason: "PE on leave", expectedRev: 0 });
    }, EV.stepFlagChanged));

  it("addProjectStep after a step", () =>
    matrix(nothing, async (s, ctx) => {
      const bom = await stepByKey(s.w, s.projectId, "bom");
      await addProjectStep(ctx, { projectId: s.projectId, name: "Factory visit", fieldType: "DATE", afterStepId: bom.id });
    }, EV.stepAdded));

  it("updateStepDefinition (lossless type change)", () =>
    matrix(
      async (s) => {
        const { step } = await addProjectStep(s.w.ctx(), { projectId: s.projectId, name: "Remarks", fieldType: "TEXT" });
        await setStepValue(s.w.ctx(), { stepId: step.id, value: "https://example.com", expectedRev: 0 });
        s.ids.step = step.id;
      },
      (s, ctx) => updateStepDefinition(ctx, s.ids.step, { fieldType: "LINK" }),
      EV.stepUpdated,
    ));

  it("archiveProjectStep", () =>
    matrix(
      async (s) => {
        const bom = await stepByKey(s.w, s.projectId, "bom");
        s.ids.step = (await addProjectStep(s.w.ctx(), { projectId: s.projectId, name: "Visit", fieldType: "DATE", afterStepId: bom.id })).step.id;
      },
      (s, ctx) => archiveProjectStep(ctx, s.ids.step),
      EV.stepArchived,
    ));

  it("restoreProjectBatch", () =>
    matrix(
      async (s) => {
        const bom = await stepByKey(s.w, s.projectId, "bom");
        const id = (await addProjectStep(s.w.ctx(), { projectId: s.projectId, name: "Visit", fieldType: "DATE", afterStepId: bom.id })).step.id;
        s.ids.batch = (await archiveProjectStep(s.w.ctx(), id)).batchId;
      },
      (s, ctx) => restoreProjectBatch(ctx, s.projectId, s.ids.batch),
      EV.stepRestored,
    ));

  it("addProjectEdge", () =>
    matrix(nothing, async (s, ctx) => {
      const a = await stepByKey(s.w, s.projectId, "pm-assigned");
      const b = await stepByKey(s.w, s.projectId, "bom");
      await addProjectEdge(ctx, s.projectId, a.id, b.id);
    }, EV.edgeAdded));

  it("archiveMilestone", () => matrix(nothing, async (s, ctx) => archiveMilestone(ctx, (await milestoneByKey(s.w, "bom")).id), EV.milestoneArchived));

  it("restoreBatch", () =>
    matrix(
      async (s) => {
        s.ids.batch = (await archiveMilestone(s.w.ctx(), (await milestoneByKey(s.w, "bom")).id)).batchId;
      },
      (s, ctx) => restoreBatch(ctx, s.ids.batch),
      EV.milestoneRestored,
    ));

  it("updateMilestone", () =>
    matrix(nothing, async (s, ctx) => updateMilestone(ctx, (await milestoneByKey(s.w, "bom")).id, { name: "Bill of materials" }), EV.milestoneUpdated));

  it("updateProject (code)", () => matrix(nothing, (s, ctx) => updateProject(ctx, s.projectId, { code: "C0822-SP1" }), EV.projectCodeChanged));

  it("archiveProject", () => matrix(nothing, (s, ctx) => archiveProject(ctx, s.projectId), EV.projectArchived));

  it("updateProjectField (retype converting values)", () =>
    matrix(
      async (s) => {
        const product = (await listProjectFields(s.w.repo)).find((f) => f.key === "product")!;
        await updateProject(s.w.ctx(), s.projectId, { details: { [product.id]: "afl" } });
        await createProject(s.w, { code: "C2", details: { [product.id]: "abcs" } });
        s.ids.field = product.id;
      },
      (s, ctx) => updateProjectField(ctx, s.ids.field, { fieldType: "MULTIPLE" }),
      EV.projectFieldUpdated,
    ));

  it("editNote", () =>
    matrix(
      async (s) => {
        s.ids.note = (await addNote(s.w.ctx(), { projectId: s.projectId, body: "first" })).id;
      },
      (s, ctx) => editNote(ctx, { projectId: s.projectId, noteId: s.ids.note, body: "second" }),
      EV.noteEdited,
    ));

  it("archiveNote", () =>
    matrix(
      async (s) => {
        s.ids.note = (await addNote(s.w.ctx(), { projectId: s.projectId, body: "first" })).id;
      },
      (s, ctx) => archiveNote(ctx, { projectId: s.projectId, noteId: s.ids.note }),
      EV.noteArchived,
    ));

  it("archiveAttachment on a step", () =>
    matrix(
      async (s) => {
        const bom = await stepByKey(s.w, s.projectId, "bom");
        s.ids.att = (await addLink(s.w.ctx(), { projectId: s.projectId, stepId: bom.id, url: "https://example.com/x" })).attachment.id;
      },
      (s, ctx) => archiveAttachment(ctx, s.ids.att),
      EV.attachmentArchived,
    ));

  it("restoreNote", () =>
    matrix(
      async (s) => {
        s.ids.note = (await addNote(s.w.ctx(), { projectId: s.projectId, body: "first" })).id;
        await archiveNote(s.w.ctx(), { projectId: s.projectId, noteId: s.ids.note });
      },
      (s, ctx) => restoreNote(ctx, { projectId: s.projectId, noteId: s.ids.note }),
      EV.noteRestored,
    ));

  it("restoreAttachment on a FILE step", () =>
    matrix(
      async (s) => {
        const { step } = await addProjectStep(s.w.ctx(), { projectId: s.projectId, name: "Photos", fieldType: "FILE" });
        s.ids.att = (await addLink(s.w.ctx(), { projectId: s.projectId, stepId: step.id, url: "https://example.com/p" })).attachment.id;
        await archiveAttachment(s.w.ctx(), s.ids.att);
      },
      (s, ctx) => restoreAttachment(ctx, s.ids.att),
      EV.attachmentRestored,
    ));

  it("restoreProject", () =>
    matrix(
      async (s) => {
        await archiveProject(s.w.ctx(), s.projectId);
      },
      (s, ctx) => restoreProject(ctx, s.projectId),
      EV.projectRestored,
    ));

  it("archiveProjectEdge", () =>
    matrix(
      async (s) => {
        const a = await stepByKey(s.w, s.projectId, "pm-assigned");
        const b = await stepByKey(s.w, s.projectId, "bom");
        s.ids.edge = (await addProjectEdge(s.w.ctx(), s.projectId, a.id, b.id)).id;
      },
      (s, ctx) => archiveProjectEdge(ctx, s.projectId, s.ids.edge),
      EV.edgeArchived,
    ));

  it("addTemplateEdge", () =>
    matrix(nothing, async (s, ctx) => {
      await addTemplateEdge(ctx, (await milestoneByKey(s.w, "pm-assigned")).id, (await milestoneByKey(s.w, "bom")).id);
    }, EV.templateEdgeAdded));

  it("archiveTemplateEdge", () =>
    matrix(
      async (s) => {
        const e = await addTemplateEdge(s.w.ctx(), (await milestoneByKey(s.w, "pm-assigned")).id, (await milestoneByKey(s.w, "bom")).id);
        s.ids.edge = e.id;
      },
      (s, ctx) => archiveTemplateEdge(ctx, s.ids.edge),
      EV.templateEdgeArchived,
    ));

  it("createMilestone after a milestone", () =>
    matrix(nothing, async (s, ctx) => {
      await createMilestone(ctx, { name: "Factory audit", fieldType: "DATE", afterMilestoneId: (await milestoneByKey(s.w, "bom")).id });
    }, EV.milestoneCreated));

  it("createProjectField", () =>
    matrix(nothing, (s, ctx) => createProjectField(ctx, { label: "Related project", fieldType: "TEXT" }), EV.projectFieldCreated));

  it("addFile on a FILE step", () =>
    matrix(
      async (s) => {
        s.ids.step = (await addProjectStep(s.w.ctx(), { projectId: s.projectId, name: "Photos", fieldType: "FILE" })).step.id;
      },
      (s, ctx) =>
        addFile(ctx, { projectId: s.projectId, stepId: s.ids.step, name: "a.jpg", contentType: "image/jpeg", size: 1, data: new Blob([new Uint8Array([1])]) }),
      EV.attachmentAdded,
    ));

  it("reorderMilestone", () =>
    matrix(nothing, async (s, ctx) => {
      await reorderMilestone(ctx, (await milestoneByKey(s.w, "bom")).id, { afterId: (await milestoneByKey(s.w, "pm-assigned")).id });
    }, EV.milestoneReordered));

  it("applyChoicesTo", () =>
    matrix(
      async (s) => {
        const adv = await milestoneByKey(s.w, "advance-invoice");
        await updateMilestone(s.w.ctx(), adv.id, { choices: [...adv.choices, { label: "On hold", state: "WAITING" }] });
      },
      async (s, ctx) => {
        const ids = await Promise.all(["pre-delivery-invoice", "arrival-delivery-invoice", "installation-invoice"].map((k) => milestoneByKey(s.w, k)));
        await applyChoicesTo(ctx, (await milestoneByKey(s.w, "advance-invoice")).id, ids.map((m) => m.id));
      },
      EV.milestoneUpdated,
    ));

  it("archiveProjectField", () =>
    matrix(nothing, async (s, ctx) => {
      await archiveProjectField(ctx, (await listProjectFields(s.w.repo)).find((f) => f.key === "notes")!.id);
    }, EV.projectFieldArchived));

  it("restoreProjectField", () =>
    matrix(
      async (s) => {
        s.ids.field = (await listProjectFields(s.w.repo)).find((f) => f.key === "notes")!.id;
        await archiveProjectField(s.w.ctx(), s.ids.field);
      },
      (s, ctx) => restoreProjectField(ctx, s.ids.field),
      EV.projectFieldRestored,
    ));

  it("setTimeZone", () => matrix(nothing, (_s, ctx) => setTimeZone(ctx, "Europe/London"), EV.settingsUpdated));

  it("setDisplayName", () => matrix(nothing, (_s, ctx) => setDisplayName(ctx, "Ronnie"), EV.settingsUpdated));

  it("addNote", () => matrix(nothing, (s, ctx) => addNote(ctx, { projectId: s.projectId, body: "hello" }), EV.noteAdded));

  it("adding the same note twice on purpose still creates two notes", async () => {
    const w = world();
    await seedLibrary(w);
    const projectId = await createProject(w);
    await addNote(w.ctx(), { projectId, body: "Called the customer" });
    await addNote(w.ctx(), { projectId, body: "Called the customer" });
    expect(await w.repo.notes.listByProject(projectId)).toHaveLength(2);
    expect((await w.repo.history.listAll({ type: EV.noteAdded })).items).toHaveLength(2);
  });

  it("addLink on a step", () =>
    matrix(nothing, async (s, ctx) => {
      const bom = await stepByKey(s.w, s.projectId, "bom");
      await addLink(ctx, { projectId: s.projectId, stepId: bom.id, url: "https://example.com/y" });
    }, EV.attachmentAdded));
});
