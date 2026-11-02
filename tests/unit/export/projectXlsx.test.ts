import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildProjectXlsx, exportFileName, safeSheetName, type ProjectExportInput } from "@/server/export/projectXlsx";

const input: ProjectExportInput = {
  project: {
    code: "C0822",
    name: "Heathrow T5 eGates",
    status: "Active",
    details: [
      { label: "Customer", value: "SITA" },
      { label: "Product", value: "AFL-Compact" },
    ],
    progress: { done: 2, applicable: 3, pct: 66 },
    counts: { NOT_STARTED: 1, IN_PROGRESS: 0, WAITING: 0, BLOCKED: 0, DONE: 2, NOT_APPLICABLE: 1 },
    exportedAt: "25 Oct 2026, 10:30 (Asia/Singapore)",
  },
  steps: [
    { seq: 1, name: "Enquiry / RFQ received", fieldType: "Date", value: "1 Oct 2026", state: "DONE", flag: "", current: false, comesAfter: "", lastChanged: "1 Oct 2026, 09:00", latestNote: "", files: "", projectOnly: false },
    { seq: 2, name: "Customer PO / LOI", fieldType: "Dropdown", value: "Awaiting", state: "WAITING", flag: "", current: true, comesAfter: "Enquiry / RFQ received", lastChanged: "", latestNote: "Chased SITA 中文 note", files: "PO.pdf", projectOnly: false },
  ],
  history: [{ at: "24 Oct 2026, 14:05", step: "Customer PO / LOI", type: "step.value_changed", source: "Manual", actor: "Me", summary: "C0822 · Customer PO / LOI: — → Awaiting", oldValue: "—", newValue: "Awaiting" }],
  files: [{ step: "Customer PO / LOI", kind: "Link", name: "PO on SharePoint", url: "https://gunnebo.sharepoint.com/x", size: "", archived: false }],
};

describe("project Excel export", () => {
  it("produces a valid xlsx with four named sheets and the data", async () => {
    const buf = await buildProjectXlsx(input);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    const files = unzipSync(new Uint8Array(buf));
    const workbook = strFromU8(files["xl/workbook.xml"]);
    for (const name of ["Summary", "Milestones", "History", "Files &amp; links"]) expect(workbook).toContain(`name="${name}"`);
    const shared = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
    const sheets = Object.keys(files)
      .filter((f) => f.startsWith("xl/worksheets/"))
      .map((f) => strFromU8(files[f]))
      .join("");
    const all = shared + sheets;
    expect(all).toContain("Customer PO / LOI");
    expect(all).toContain("Chased SITA 中文 note");
    expect(all).toContain("Waiting");
  });

  it("makes safe sheet and file names", () => {
    expect(safeSheetName("A/B:C*D?[E]")).toBe("A B C D  E ");
    expect(safeSheetName("x".repeat(40))).toHaveLength(31);
    expect(exportFileName("C0822", 'Heathrow: T5 "eGates"', "2026-10-25")).toBe("C0822 Heathrow T5 eGates 2026-10-25.xlsx");
  });
});
