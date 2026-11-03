/**
 * Imports project progress (prepared from emails) into the app through its own services.
 *
 *   npx tsx --conditions=react-server scripts/import-progress.ts <progress.json>            # plan only
 *   npx tsx --conditions=react-server scripts/import-progress.ts <progress.json> --apply    # write
 *   ... --fake data/fake-notion.json   # try it on the local fake Notion instead of real Notion
 *
 * Real Notion needs NOTION_TOKEN (the "Gunnebo PM app" integration secret). It writes to the page "Gunnebo PM"
 * (or NOTION_PARENT_PAGE_ID), never to "Gunnebo PM (Preview)". Safe to run again: see progressImport.ts.
 * The progress file holds customer data: keep it out of git.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--fake");
const apply = args.includes("--apply");
const fakeIdx = args.indexOf("--fake");

if (!fileArg) {
  console.error("Usage: scripts/import-progress.ts <progress.json> [--apply] [--fake <fake-notion.json>]");
  process.exit(2);
}
if (fakeIdx >= 0) {
  delete process.env.NOTION_TOKEN;
  process.env.FAKE_NOTION_FILE = path.resolve(args[fakeIdx + 1] ?? "data/fake-notion.json");
} else if (!process.env.NOTION_TOKEN) {
  console.error("NOTION_TOKEN is not set. Add the Gunnebo PM app integration secret to the environment, or use --fake.");
  process.exit(2);
}
if (process.env.VERCEL_ENV === "preview") {
  console.error("Refusing to run with VERCEL_ENV=preview: this script writes the real project data.");
  process.exit(2);
}

async function main() {
  const { getRepo, getStorageAdmin } = await import("../src/server/repo");
  const { runProgressImport } = await import("../src/server/services/progressImport");
  const { parentTitleFor } = await import("../src/server/notion/registry");

  const status = await getStorageAdmin().status();
  if (status.mode === "unconfigured" || !status.schemaReady || !status.seeded) {
    console.error(`The app is not set up in Notion yet (${status.problems?.join(" ") || "schema or milestones missing"}). Run Setup in the app first.`);
    process.exit(1);
  }
  console.log(`${apply ? "APPLYING to" : "Plan only (add --apply to write) for"} ${fakeIdx >= 0 ? `fake Notion ${process.env.FAKE_NOTION_FILE}` : `Notion page "${process.env.NOTION_PARENT_PAGE_ID ? "NOTION_PARENT_PAGE_ID" : parentTitleFor()}"`}\n`);

  const file = JSON.parse(readFileSync(path.resolve(fileArg!), "utf8"));
  let last = "";
  const report = await runProgressImport(getRepo(), file, {
    apply,
    log: (i) => {
      if (i.code !== last) {
        console.log(`\n${i.code}`);
        last = i.code;
      }
      const mark = { done: "✓", unchanged: "=", skipped: "–", error: "✗", planned: "•" }[i.outcome];
      console.log(`  ${mark} ${i.what}${i.detail ? `  (${i.detail})` : ""}`);
    },
  });
  const c = report.counts;
  console.log(`\n${apply ? `Done: ${c.done} written` : `Planned: ${c.planned} changes`}, ${c.unchanged} already up to date, ${c.skipped} left as is, ${c.error} errors.`);
  if (c.error) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
