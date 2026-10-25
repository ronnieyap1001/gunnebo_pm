# Original brief (from the project owner)

> Kept verbatim as the source of truth for requirements. Later change from the owner (2026-10-25):
> **"Build an online app, host on GitHub, use Vercel and Notion as database."** See `ONLINE-ARCHITECTURE.md`.

I am a Technical Project Manager at Gunnebo Entrance Control (airport and transit gates: AFL, AFL-Compact, ImmSec, ABCS). Customers include SITA, IDEMIA, NEC and Collins Aerospace, and gates are built at our Kunshan plant. I run each project from enquiry to close-out. I am not a developer, so keep setup to one or two commands and explain anything I must do in plain words.

## WHY
I tried Notion. Its interface is too clumsy for complicated projects. I need a clean, fast app where each project's lifecycle is an interactive PROCESS FLOW CHART that I can read at a glance and update by clicking.

## PHASE 1 SCOPE (build this now)
1. Milestone Library — the master list of milestones/tasks (seed data below). Each milestone has: name, field type, choices (for Dropdown / Multiple), and an optional description. I must be able to add, rename, reorder, delete and edit every milestone, its field type and its choices.
2. Template Flow Editor — the milestones shown as a flow chart (nodes = milestones, arrows = "comes after"). I must be able to:
   - drag nodes to rearrange;
   - draw and delete arrows, so I can create parallel branches (e.g. engineering running alongside order admin) and merge them again;
   - add a new milestone node from the canvas, or delete one;
   - click a node to edit name, field type and choices in a side panel;
   - zoom, pan, use a minimap, and press "auto-layout" (left-to-right, dagre or elk).
   The seed flow is the list below as one straight chain (1 → 2 → … → 64). I will reshape it myself.
3. Projects — create, edit and archive projects. Basic details: Project code (e.g. C0822), Name, Customer, End user, Site / country, Product, Quantity, Project type (Project / Spare order / Adhoc / Warranty replacement), Status (Active / On hold / Closed), Notes. Make these detail fields configurable too, using the same field-type system as milestones.
4. Project Flow View (the main screen) — opening a project shows its flow chart. Each node:
   - shows the milestone name and its current value (e.g. "Awaiting", "12 Nov 2026", "60 %");
   - is coloured by state: grey = not started, blue = in progress, amber = waiting on others, red = blocked or problem, green = done, faded/dashed = not applicable;
   - when clicked, opens a side panel to set the value with the right input (dropdown, multi-select chips, date picker, number, text, checkbox), add a note, add links or attachments, and see the node's history (who/what changed, old → new value, timestamp).
   Above the chart: project header with key details, a progress bar (% of applicable milestones done), and the "current" milestones, i.e. open nodes whose predecessors are all done.
5. List View — the same project as a table in flow order (one row per milestone: name, value, state, last updated, latest note), with inline editing. Toggle between Flow and List.
6. Portfolio View — all active projects as rows and milestones as columns. Each cell is coloured by state and shows the value on hover; click a cell to open that project's node. Filter by customer, type and status. Include a "my open items" list: nodes in progress or blocked across all projects, oldest first.

## STATE MAPPING (important)
Node colour comes from the value:
- Each Dropdown choice is tagged in the Milestone Library with a state: Not started / In progress / Waiting / Blocked / Done / Not applicable. Seed tags are given below.
- Date: empty = Not started; date in the future = In progress (planned); date today or in the past = Done.
- Number (%): 0 or empty = Not started; 1–99 = In progress; 100 = Done.
- Text / Checkbox / Multiple: empty = Not started; filled or ticked = Done.
I can change any state tag in the library.

## TEMPLATE vs PROJECT
- A new project copies the current template flow, nodes and arrows.
- On a project I can mark nodes Not applicable, add project-only nodes, and re-route arrows without touching the template.
- When I change the template, offer a "sync from template" action per project that adds new milestones and updated choices but never deletes project data or values.

## DATA AND HISTORY
- Every value change, note and attachment is stored with a timestamp in an append-only change log per project. Nothing is hard-deleted: deleted milestones and projects go to an archive I can restore from.
- Attachments: store files locally, and allow a plain link (SharePoint / OneDrive URL) as an alternative.
- Export: a project to Excel (.xlsx) and the template to JSON. Import: template from JSON.

## TECH (original suggestion; superseded for hosting/storage by the 2026-10-25 change)
- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui.
- React Flow (@xyflow/react) for the flow charts, with dagre or elkjs for auto-layout.
- (Originally) Prisma ORM with SQLite. (Now) Notion as the database, hosted on Vercel.
- Single user for now (me). (Now online, so a login is required.)
- Seed script that loads the milestone list below.

## DESIGN
Clean, professional and dense (it is a work tool): light theme with dark mode, a left sidebar (Portfolio, Projects, Milestone Library, Template Flow), keyboard-friendly, fast. Nodes must stay readable at 60+ nodes: use compact node cards, a clear state colour, and a value line under the name.

## LATER PHASES (do NOT build now, but don't block them)
- Phase 2: read my Outlook mail (Microsoft Graph) daily, map each email to project + milestone, propose or apply value changes, and log the email in the node's history.
- Phase 3: file email attachments into the project's SharePoint folders; per-project folder settings per document category.
- Phase 4: commercial tracking (POs, invoices, payments, contract value) and a daily brief.
So: keep a clean data model with an "events" table (source = manual / email / system), and an id on every milestone and project that external processes can reference.

## HOW TO WORK
1. First show a short plan. 2. Build in small steps; after each step, say how to see it in the browser. 3. Basic tests for the state mapping and for template → project copy and sync. 4. Commit after each working step with clear messages. Never commit secrets or project data files.

## SEED — MILESTONE LIBRARY (in flow order; the state tag for each choice is in brackets)
State codes: NS = Not started, IP = In progress, W = Waiting, B = Blocked, D = Done, NA = Not applicable.

1. Enquiry / RFQ received — Date
2. PM assigned — Date
3. Customer requirements & specification — Dropdown: Not received [NS] · Partial [IP] · Complete [D]
4. Technical Q&A with customer — Dropdown: Not started [NS] · Questions open [W] · All answered [D]
5. Factory lead time & costing — Dropdown: Not requested [NS] · Requested [W] · Received [D]
6. Proposal / offer — Dropdown: Drafting [IP] · Sent [W] · Revising [IP] · Accepted [D] · Lost [B]
7. Pre-PO work approval (engineering at risk, samples, advance production) — Dropdown: Not needed [NA] · Requested [W] · Approved [D] · Rejected [B]
8. Customer PO / LOI — Dropdown: Awaiting [W] · LOI received [IP] · Partial PO [IP] · Full PO [D] · Revised PO [D]
9. PO check & acknowledgement — Dropdown: Not checked [NS] · Issues raised [B] · Acknowledged [D]
10. Sales-to-PM handover — Dropdown: Not held [NS] · Scheduled [IP] · Held – open items [IP] · Closed [D]
11. Project number & set-up — Dropdown: Not requested [NS] · Requested [W] · Issued & set up [D]
12. Customer account & part numbers — Dropdown: Not needed [NA] · Requested [W] · Ready [D] · Blocked [B]
13. Order form (Order Document) — Dropdown: Drafting [IP] · Under review [W] · Final [D] · Revised [D]
14. New order to Customer Service — Dropdown: Not sent [NS] · Sent [W] · Queries open [B] · Accepted [D]
15. O2F shipment requirements form — Dropdown: Not started [NS] · Waiting for customer [W] · Submitted [D]
16. Intercompany PO from Gunnebo entity — Dropdown: Not applicable [NA] · Requested [W] · Received without values [B] · Received [D]
17. Sales order confirmation — Dropdown: Pending [W] · Issued [IP] · Sent to customer [D] · Revised [D]
18. Factory PO & confirmation (SOC) — Dropdown: Pending [W] · PO issued [IP] · SOC received [D] · Revised [D]
19. Kick-off & baseline schedule — Dropdown: Not started [NS] · Kick-off held [IP] · Schedule baselined [D] · Re-planned [D]
20. Invoice milestones & OBL month — Dropdown: Not set [NS] · Set [D] · Changed [D]
21. Engineering job request (SRG) — Dropdown: Not needed [NA] · Raised [W] · In progress [IP] · Done [D]
22. Specification freeze — Dropdown: Open [IP] · Frozen [D] · Changed after freeze [B]
23. BOM — Dropdown: Not started [NS] · Requested [W] · Released [D] · Revised [D]
24. Customer drawings & approval — Dropdown: Not required [NA] · Requested from PE [W] · Sent to customer [W] · Comments received [IP] · Approved [D]
25. Colour / finish sample — Dropdown: Not required [NA] · In production [IP] · Sent [W] · Approved [D] · Rejected [B]
26. Peripherals & long-lead parts (PC, readers, printers) — Dropdown: Not applicable [NA] · Open [IP] · At risk [B] · Shortage [B] · Secured [D]
27. Spare parts list — Dropdown: Not required [NA] · Draft [IP] · Agreed [IP] · Quoted [W] · Ordered [D]
28. Change requests — Dropdown: None [NA] · Open [IP] · Approved [D] · Rejected [D]
29. Factory ready date — Date
30. Production status — Dropdown: Not started [NS] · In production [IP] · Delayed [B] · Completed [D]
31. Quality issues / NCN — Dropdown: None [NA] · Open [B] · Closed [D]
32. FAT mode — Dropdown: Remote [D] · Witnessed at factory [D] · Internal only [D] · Not required [NA]
33. FAT date — Date
34. FAT report & customer acceptance — Dropdown: Waiting for report [W] · Report sent [W] · Punch list open [B] · Accepted [D] · Failed [B]
35. Delivery split — Dropdown: Single shipment [D] · Split proposed [W] · Split agreed [D]
36. Packing list — Dropdown: Not requested [NS] · Estimated [IP] · Official [IP] · Sent to customer [D]
37. Shipping documents required — Multiple: Packing list · Commercial invoice · MSDS · Battery cert (UN38.3) · Certificate of Origin · Form E · CE DoC · FAT report · Packing photos
38. Freight quotation & approval — Dropdown: Not required [NA] · Requested [W] · Quoted [W] · Approved [D]
39. Ready for collection — Date
40. Storage at factory — Dropdown: Not needed [NA] · Charging [B] · Cost agreed [D]
41. Picked up / ETD — Date
42. ETA — Date
43. Import clearance & permits — Dropdown: Not applicable [NA] · Pending [W] · Cleared [D]
44. Delivered (proof of delivery) — Date
45. Signed delivery order / Deed of Ownership — Dropdown: Not required [NA] · Pending [W] · Signed [D]
46. Site readiness & access (induction, visas) — Dropdown: Not ready [W] · Ready – access pending [W] · Ready [D]
47. Installer (quote → PO) — Dropdown: Not required [NA] · RFQ sent [W] · Quote selected [IP] · PO issued [D]
48. Installation start — Date
49. Installation progress — Number (%)
50. Training — Dropdown: Not required [NA] · Planned [IP] · Done [D]
51. SAT / commissioning — Dropdown: Not started [NS] · Scheduled [IP] · Passed [D] · Passed with punch list [IP] · Failed [B]
52. Handover documents — Dropdown: Not sent [NS] · Sent [W] · Accepted [D]
53. Customer acceptance certificate — Dropdown: Not requested [NS] · Requested [W] · Signed [D]
54. Advance invoice — Dropdown: Not applicable [NA] · Not due [NS] · Invoiceable [IP] · Raised [IP] · Sent [W] · Disputed [B] · Overdue [B] · Paid [D]
55. Pre-delivery invoice — Dropdown: same choices as 54
56. Arrival / delivery invoice — Dropdown: same choices as 54
57. Installation invoice — Dropdown: same choices as 54
58. Acceptance / retention invoice — Dropdown: same choices as 54
59. Credit notes / invoice disputes — Dropdown: None [NA] · Open [B] · Credit note issued [D]
60. Warranty period — Date range (start → end)
61. Warranty claims — Dropdown: None [NA] · Open [B] · Closed [D]
62. Spares & maintenance (AMC) handover — Dropdown: Not applicable [NA] · Pending [W] · Done [D]
63. Lessons learned — Text
64. Project closed — Date

Supported field types: Text, Long text, Number, Number (%), Date, Date range, Dropdown (single), Multiple (multi-select), Checkbox, Link (URL), File.

## Defaults accepted with the plan (from the plan message of 2026-10-24)
1. Template changes reach a project only via Sync (preview, untick items; never changes or deletes values). Plus "Sync all active projects".
2. Every step has a Waiting / Blocked flag. N/A > flag > value. A value write that produces Done or N/A clears the flag.
3. N/A steps are see-through for "current milestones" and excluded from progress.
4. My open items: In progress + Blocked, sorted by time in that state (stateChangedAt), oldest first. Date-driven items (planned dates, upcoming or running date ranges) behind a toggle; Waiting behind a toggle.
5. Planned dates turn green when they pass; a clock mark shows until confirmed.
6. Unmapped types: Number filled = Done; Long text / Link like Text; File = Done with ≥1 file or link; Date range grey when empty, blue until end date, green after.
7. One template for all project types; bulk N/A in List view.
8. Template-derived steps can't be renamed/deleted in a project (mark N/A). Project-only steps fully editable.
9. Customer and Project type: renamable, choices editable, not deletable. Customer seeded: SITA, IDEMIA, NEC, Collins Aerospace. Product: AFL, AFL-Compact, ImmSec, ABCS (Dropdown, convertible to Multiple).
10. Invoices 55–58 are separate copies of 54's choices; editor offers "apply to all five".
11. Closed is a status; Archive hides. A date in "Project closed" prompts "Set status to Closed?".
12. Project codes unique, editable, suffixes allowed (C0822-SP1).
13. Dropdowns start empty.
14. Dates show as "12 Nov 2026", typed day-first; "today" = Asia/Singapore.
15. Files: max size per upload limited by hosting (see ONLINE-ARCHITECTURE.md); SharePoint/OneDrive as links.
16. Two resets (template only; everything), both back up first.
17. Notes editable/deletable; originals stay in history.
18. Library reorder changes list order/tie-break only; arrows decide flow.
19. Template import shows a preview and backs up first; missing milestones archived, not deleted.
