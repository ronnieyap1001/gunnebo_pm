import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cellState } from "@/domain/cells";
import { EV } from "@/server/services/context";
import { addNote, archiveNote, editNote, restoreNote } from "@/server/services/notes";
import { addFile, addLink, archiveAttachment, openAttachment, restoreAttachment, MAX_FILE_BYTES } from "@/server/services/attachments";
import { addProjectStep } from "@/server/services/steps";
import { createProject, expectAppError, historyOfType, NOW, seedLibrary, stepByKey, TODAY, world, type World } from "./_helpers";

let w: World;
let projectId: string;
beforeEach(async () => {
  w = world();
  await seedLibrary(w);
  projectId = await createProject(w);
});

const day = { today: TODAY, timeZone: "Asia/Singapore" };

describe("notes", () => {
  it("add, edit, delete and restore write History rows; the original text stays in History", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const note = await addNote(w.ctx(), { projectId, stepId: bom.id, body: "  Waiting for PE to release the BOM revision  " });
    expect(note).toMatchObject({ body: "Waiting for PE to release the BOM revision", author: "Me", stepId: bom.id, archived: false });
    const added = (await historyOfType(w, EV.noteAdded))[0];
    expect(added).toMatchObject({ stepId: bom.id, milestoneKey: "bom" });
    expect(added.summary).toBe('C0822 · Note on BOM: "Waiting for PE to release the BOM revisi…"');
    expect(added.data).toMatchObject({ body: "Waiting for PE to release the BOM revision" });

    const edited = await editNote(w.ctx(), { projectId, noteId: note.id, body: "PE released rev B" });
    expect(edited).toMatchObject({ body: "PE released rev B", editedAt: NOW });
    expect((await historyOfType(w, EV.noteEdited))[0].data).toMatchObject({
      oldBody: "Waiting for PE to release the BOM revision",
      newBody: "PE released rev B",
    });

    await archiveNote(w.ctx(), { projectId, noteId: note.id });
    expect(await w.repo.notes.listByProject(projectId)).toHaveLength(0);
    await expectAppError(editNote(w.ctx(), { projectId, noteId: note.id, body: "x" }), "VALIDATION");
    await restoreNote(w.ctx(), { projectId, noteId: note.id });
    expect(await w.repo.notes.listByProject(projectId)).toHaveLength(1);
    expect(await historyOfType(w, EV.noteArchived)).toHaveLength(1);
    expect(await historyOfType(w, EV.noteRestored)).toHaveLength(1);
    // The step's history shows the note rows.
    expect((await w.repo.history.listByStep(bom.id)).items.length).toBe(4);
  });

  it("project-level notes, empty bodies, and retries", async () => {
    const opId = randomUUID();
    const a = await addNote(w.ctx({ opId }), { projectId, body: "Kick-off moved to Monday" });
    const b = await addNote(w.ctx({ opId }), { projectId, body: "Kick-off moved to Monday" });
    expect(b.id).toBe(a.id);
    expect(await w.repo.notes.listByProject(projectId)).toHaveLength(1);
    expect((await historyOfType(w, EV.noteAdded))[0].summary).toBe('C0822 · Note: "Kick-off moved to Monday"');
    await expectAppError(addNote(w.ctx(), { projectId, body: "   " }), "VALIDATION");
    await expectAppError(addNote(w.ctx(), { projectId, stepId: "nope", body: "x" }), "NOT_FOUND");
  });
});

describe("attachments", () => {
  it("links: http/https only, name defaults to the host, History rows", async () => {
    const bom = await stepByKey(w, projectId, "bom");
    const r = await addLink(w.ctx(), { projectId, stepId: bom.id, url: "https://www.gunnebo.sharepoint.com/sites/x/BOM.xlsx" });
    expect(r.attachment).toMatchObject({ kind: "LINK", name: "gunnebo.sharepoint.com", stepId: bom.id });
    await expectAppError(addLink(w.ctx(), { projectId, url: "javascript:alert(1)" }), "VALIDATION");
    await expectAppError(addLink(w.ctx(), { projectId, url: "ftp://x.com/a" }), "VALIDATION");
    expect((await historyOfType(w, EV.attachmentAdded))[0].summary).toBe('C0822 · Link "gunnebo.sharepoint.com" added on BOM');
    // Non-FILE steps still carry the count (tooltips), and their state doesn't change.
    const p = (await w.repo.projects.get(projectId))!;
    expect(p.cells[bom.id].fc).toBe(1);
    expect(cellState(p.cells[bom.id], day).state).toBe("NOT_STARTED");
  });

  it("a FILE-type step's state follows its attachments", async () => {
    const { step } = await addProjectStep(w.ctx(), { projectId, name: "FAT photos", fieldType: "FILE" });
    const cell = async () => (await w.repo.projects.get(projectId))!.cells[step.id];
    expect(cellState(await cell(), day).state).toBe("NOT_STARTED");

    const file = await addFile(w.ctx({ now: "2026-10-25T03:00:00.000Z" }), {
      projectId,
      stepId: step.id,
      name: "photo 1.jpg",
      contentType: "image/jpeg",
      size: 3,
      data: new Blob([new Uint8Array([1, 2, 3])]),
    });
    expect(cellState(await cell(), day)).toEqual({ state: "DONE", reason: "FILES" });
    expect((await w.repo.steps.get(step.id))!.stateChangedAt).toBe("2026-10-25T03:00:00.000Z");
    expect(file.project.progress).toBe(1);

    const link = await addLink(w.ctx(), { projectId, stepId: step.id, url: "https://onedrive.live.com/x", name: "More photos" });
    expect((await cell()).fc).toBe(2);

    await archiveAttachment(w.ctx(), file.attachment.id);
    expect(cellState(await cell(), day).state).toBe("DONE");
    await archiveAttachment(w.ctx({ now: "2026-10-25T04:00:00.000Z" }), link.attachment.id);
    expect(cellState(await cell(), day).state).toBe("NOT_STARTED");
    expect((await cell()).fc).toBeUndefined();
    expect((await w.repo.steps.get(step.id))!.stateChangedAt).toBe("2026-10-25T04:00:00.000Z");
    await restoreAttachment(w.ctx(), link.attachment.id);
    expect(cellState(await cell(), day).state).toBe("DONE");

    expect(await historyOfType(w, EV.attachmentAdded)).toHaveLength(2);
    expect(await historyOfType(w, EV.attachmentArchived)).toHaveLength(2);
    expect(await historyOfType(w, EV.attachmentRestored)).toHaveLength(1);

    const dl = await openAttachment(w.repo, file.attachment.id);
    expect(dl.url).toBe("data:image/jpeg;base64,AQID");
    await expectAppError(openAttachment(w.repo, link.attachment.id), "NOT_FOUND");
  });

  it("refuses files over 4 MB", async () => {
    await expectAppError(
      addFile(w.ctx(), { projectId, name: "big.zip", contentType: "application/zip", size: MAX_FILE_BYTES + 1, data: new Blob([]) }),
      "VALIDATION",
      /4 MB/,
    );
  });
});
