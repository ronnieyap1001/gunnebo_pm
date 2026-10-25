/**
 * Local development only: prepares the FAKE Notion with the database schema, the 64 seed milestones and
 * (with --demo) four realistic demo projects. Never runs against real Notion.
 *
 *   npx tsx --conditions=react-server scripts/dev-seed.ts [--file data/fake-notion.json] [--demo]
 *
 * ('react-server' makes the 'server-only' import a no-op outside Next.js.)
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const file = fileArg >= 0 ? args[fileArg + 1] : process.env.FAKE_NOTION_FILE ?? "data/fake-notion.json";
if (process.env.NOTION_TOKEN || process.env.VERCEL) {
  console.error("dev-seed only runs against the local fake Notion (unset NOTION_TOKEN).");
  process.exit(1);
}
process.env.FAKE_NOTION_FILE = path.resolve(file);
const demo = args.includes("--demo");

type Values = Record<string, unknown>;

interface DemoProject {
  code: string;
  name: string;
  status?: "ACTIVE" | "ON_HOLD" | "CLOSED";
  details: Record<string, unknown>;
  values: Values;
  na?: string[];
  flags?: Record<string, "WAITING" | "BLOCKED">;
  notes?: Record<string, string>;
  links?: Record<string, { name: string; url: string }>;
}

const DEMO: DemoProject[] = [
  {
    code: "C0822",
    name: "Heathrow T5 eGates",
    details: { customer: "sita", "end-user": "Heathrow Airport Ltd", "site-country": "London, UK", product: "afl-compact", quantity: 24, "project-type": "project" },
    values: {
      "enquiry-rfq-received": "2026-06-02",
      "pm-assigned": "2026-06-05",
      "customer-requirements": "complete",
      "technical-qa": "all-answered",
      "factory-lead-time-costing": "received",
      "proposal-offer": "accepted",
      "customer-po-loi": "full-po",
      "po-check-acknowledgement": "acknowledged",
      "sales-pm-handover": "closed",
      "project-number-setup": "issued-set-up",
      "customer-account-part-numbers": "ready",
      "order-form": "final",
      "new-order-customer-service": "accepted",
      "o2f-shipment-requirements": "waiting-for-customer",
      "sales-order-confirmation": "sent-to-customer",
      "factory-po-soc": "soc-received",
      "kick-off-baseline": "schedule-baselined",
      "invoice-milestones-obl": "set",
      "engineering-job-request": "in-progress",
      "specification-freeze": "frozen",
      bom: "requested",
      "customer-drawings-approval": "sent-to-customer",
      "peripherals-long-lead-parts": "at-risk",
      "factory-ready-date": "2026-12-05",
      "fat-date": "2027-01-12",
      "advance-invoice": "paid",
      "pre-delivery-invoice": "not-due",
    },
    na: ["pre-po-approval", "intercompany-po", "colour-finish-sample"],
    notes: {
      "peripherals-long-lead-parts": "Passport readers: supplier confirms 14-week lead time. Chasing alternatives.",
      bom: "PE promised BOM release by end of next week.",
    },
    links: { "customer-po-loi": { name: "PO 4500123 on SharePoint", url: "https://gunnebo.sharepoint.com/sites/projects/C0822/PO-4500123.pdf" } },
  },
  {
    code: "C0815",
    name: "Changi T4 ABCS",
    details: { customer: "idemia", "end-user": "Changi Airport Group", "site-country": "Singapore", product: "abcs", quantity: 16, "project-type": "project" },
    values: {
      "enquiry-rfq-received": "2026-03-10",
      "pm-assigned": "2026-03-12",
      "customer-requirements": "complete",
      "technical-qa": "all-answered",
      "factory-lead-time-costing": "received",
      "proposal-offer": "accepted",
      "customer-po-loi": "full-po",
      "po-check-acknowledgement": "acknowledged",
      "sales-pm-handover": "closed",
      "project-number-setup": "issued-set-up",
      "order-form": "final",
      "new-order-customer-service": "accepted",
      "o2f-shipment-requirements": "submitted",
      "sales-order-confirmation": "sent-to-customer",
      "factory-po-soc": "soc-received",
      "kick-off-baseline": "schedule-baselined",
      "invoice-milestones-obl": "set",
      "engineering-job-request": "done",
      "specification-freeze": "frozen",
      bom: "released",
      "customer-drawings-approval": "approved",
      "colour-finish-sample": "approved",
      "peripherals-long-lead-parts": "secured",
      "factory-ready-date": "2026-10-08",
      "production-status": "completed",
      "fat-mode": "witnessed-at-factory",
      "fat-date": "2026-10-14",
      "fat-report-acceptance": "punch-list-open",
      "delivery-split": "single-shipment",
      "packing-list": "estimated",
      "shipping-documents": ["packing-list", "commercial-invoice", "certificate-of-origin"],
      "freight-quotation-approval": "quoted",
      "advance-invoice": "paid",
      "pre-delivery-invoice": "invoiceable",
    },
    na: ["pre-po-approval", "customer-account-part-numbers", "intercompany-po", "quality-issues-ncn", "change-requests", "spare-parts-list"],
    notes: { "fat-report-acceptance": "Punch list: 3 cosmetic items on lanes 7-9. Kunshan fixing this week." },
  },
  {
    code: "C0809",
    name: "Narita immigration gates",
    details: { customer: "nec", "end-user": "Narita International Airport", "site-country": "Narita, Japan", product: "immsec", quantity: 12, "project-type": "project" },
    values: {
      "enquiry-rfq-received": "2026-09-15",
      "pm-assigned": "2026-09-18",
      "customer-requirements": "partial",
      "technical-qa": "questions-open",
      "factory-lead-time-costing": "requested",
      "proposal-offer": "drafting",
    },
    flags: { "factory-lead-time-costing": "BLOCKED" },
  },
  {
    code: "C0790-SP1",
    name: "Spare parts for Dubai T3",
    details: { customer: "collins-aerospace", "end-user": "Dubai Airports", "site-country": "Dubai, UAE", product: "afl", quantity: 4, "project-type": "spare-order" },
    values: {
      "enquiry-rfq-received": "2026-10-01",
      "pm-assigned": "2026-10-01",
      "customer-requirements": "complete",
      "proposal-offer": "sent",
      "customer-po-loi": "awaiting",
    },
  },
];

async function main() {
  const { getRepo, getStorageAdmin } = await import("../src/server/repo");
  const services = await import("../src/server/services");
  const admin = getStorageAdmin();
  const repo = getRepo();

  console.log(`Fake Notion file: ${process.env.FAKE_NOTION_FILE}`);
  for (let i = 0; i < 50; i++) {
    const r = await admin.runSchemaStep();
    console.log(`  schema: ${r.message}`);
    if (r.done) break;
  }

  const ctxFor = (opId = randomUUID()) => services.makeCtxFromSettings(repo, { opId });

  if (!(await repo.settings.get("seed.appliedAt"))) {
    const ctx = await ctxFor();
    await services.startSeed(ctx);
    for (let i = 0; i < 200; i++) {
      const r = await services.continueImport(ctx, ctx.opId);
      if (r.done) break;
    }
    console.log("  seed: 64 milestones loaded");
  } else {
    console.log("  seed: already loaded");
  }

  if (!demo) return;

  for (const p of DEMO) {
    if (await repo.projects.findByCode(p.code)) {
      console.log(`  demo: ${p.code} exists, skipped`);
      continue;
    }
    const ctx = await ctxFor();
    const { projectId } = await services.startCreateProject(ctx, { code: p.code, name: p.name, status: p.status ?? "ACTIVE", details: p.details });
    for (let i = 0; i < 100; i++) {
      const r = await services.continueCreateProject(ctx, ctx.opId);
      if (r.done) break;
    }
    const steps = await repo.steps.listByProject(projectId);
    const byKey = new Map(steps.map((s) => [s.milestoneKey, s]));
    for (const [key, value] of Object.entries(p.values)) {
      const step = byKey.get(key);
      if (!step) throw new Error(`demo: no step ${key}`);
      const fresh = await repo.steps.get(step.id);
      await services.setStepValue(await ctxFor(), { stepId: step.id, value, expectedRev: fresh!.rev });
    }
    for (const key of p.na ?? []) {
      const step = byKey.get(key)!;
      const fresh = await repo.steps.get(step.id);
      await services.setStepNotApplicable(await ctxFor(), { stepId: step.id, notApplicable: true, expectedRev: fresh!.rev });
    }
    for (const [key, flag] of Object.entries(p.flags ?? {})) {
      const step = byKey.get(key)!;
      await services.setStepFlag(await ctxFor(), { stepId: step.id, flag, reason: "Factory has not answered after two reminders." });
    }
    for (const [key, body] of Object.entries(p.notes ?? {})) {
      await services.addNote(await ctxFor(), { projectId, stepId: byKey.get(key)!.id, body });
    }
    for (const [key, link] of Object.entries(p.links ?? {})) {
      await services.addLink(await ctxFor(), { projectId, stepId: byKey.get(key)!.id, ...link });
    }
    console.log(`  demo: ${p.code} ${p.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
