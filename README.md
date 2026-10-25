# Gunnebo PM

A web app for running Gunnebo Entrance Control projects from enquiry to close-out. Each project's lifecycle is an
interactive flow chart: every box is a milestone, coloured by its state, and you update it by clicking.

- **Where it runs:** on Vercel, at your own web address. You sign in with a password.
- **Where the data lives:** in your Notion workspace, inside a page called **Gunnebo PM**. You can browse it in Notion,
  but make changes in the app so the history and colours stay correct.
- **Where the code lives:** this GitHub repository. Every change merged into `main` goes live automatically.

---

## One-time setup (about 15 minutes)

You only do this once. Nothing here needs a terminal.

### 1. Notion: create the connection

1. Open <https://www.notion.so/profile/integrations> and click **New integration**.
2. Name it **Gunnebo PM app**, pick your workspace (**Ron Yap's Notion**) and keep the type **Internal**.
3. Click **Save**, then on the next screen click **Show** next to **Internal Integration Secret** and copy it.
   Keep it somewhere safe for step 2. It starts with `ntn_`.
4. In Notion, create two empty pages at the top level of your sidebar, named exactly:
   - **Gunnebo PM** (your real data)
   - **Gunnebo PM (Preview)** (test data for preview versions while the app is being built)
5. On each of those two pages, click **•••** at the top right, then **Connections**, then add **Gunnebo PM app**.

> Your workspace must have only one member (you), or be on a paid Notion plan. Notion limits free workspaces with
> several members to 1,000 blocks created by apps, which this app would use up after about ten projects.

### 2. Vercel: put the app online

1. Sign in at <https://vercel.com> with your GitHub account.
2. Click **Add New…**, then **Project**, find **gunnebo_pm** and click **Import**.
   If it isn't listed, click **Configure GitHub App** and give Vercel access to the repository.
3. Open **Environment Variables** on the import screen and add these two. Tick all environments (Production,
   Preview and Development):

   | Name | Value |
   |---|---|
   | `NOTION_TOKEN` | the secret you copied in step 1 |
   | `APP_PASSWORD` | the password you will sign in with: at least 16 characters, for example four random words |

4. Click **Deploy** and wait about two minutes.
5. **Strongly recommended:** in the project, open **Settings**, then **Deployment Protection**, set
   **Vercel Authentication** to **All Deployments** and save. Then only someone signed in to your Vercel account can
   even see the sign-in page. It's free.

### 3. First visit

1. Open the address Vercel shows (for example `https://gunnebo-pm.vercel.app`) and sign in with your password.
2. The **Setup** page opens. Click **Create databases**, then **Load the 64 milestones**. Each takes under a minute.
3. You land on the Portfolio. Create your first project from **Projects**.

---

## Everyday use

| I want to… | Go to |
|---|---|
| See all active projects at a glance | **Portfolio** (coloured grid, plus "My open items") |
| Work on one project | **Projects**, then click the project. Click a box to set its value, add a note, a link or a file |
| See a project as a table | On the project page, choose **List** |
| Change the master list of milestones or their choices | **Milestone Library** |
| Change the standard flow (arrows, branches) | **Template Flow** |
| Bring template changes into a project | On the project, **⋯ → Sync from template**, or **Template Flow → Sync all projects** |
| Restore something you deleted | **Archive** |
| Export a project to Excel | On the project, **⋯ → Export to Excel** |

Colours: grey = not started, blue = in progress, amber = waiting on others, red = blocked, green = done,
faded and dashed = not applicable.

Press **?** anywhere to see keyboard shortcuts. **Ctrl+K** (or **⌘K** on a Mac) opens quick search.

## Backups

- **Settings → Download full backup** saves everything (all projects, milestones and history) as one file on your
  computer. Do this weekly. The sidebar reminds you after seven days.
- Notion also keeps its own copy: in Notion, **Settings → General → Export all workspace content**.
- Files you attach are stored in Notion. Keep important documents in SharePoint as well and add them as links.

## Starting again

- **Settings → Reset template to seed** puts the Milestone Library and Template Flow back to the original 64
  milestones. Your projects are kept.
- **Settings → Start over** moves all the app's Notion databases to Notion's trash (recoverable there for 30 days)
  and runs Setup again. You must type RESET to confirm.

## Limits to know

- **Files:** up to 4 MB each. For bigger drawings or Outlook messages, paste a SharePoint or OneDrive link instead.
- **Speed:** Notion answers in a fraction of a second per request, and allows about three requests a second.
  Everyday clicks feel instant. Creating a project copies 64 milestones and takes about 20–30 seconds.
- **History** is fingerprinted. **Settings → Verify history** shows if a history row was changed directly in Notion.
- **Vercel plan:** Vercel's free Hobby plan is meant for personal, non-commercial use. For work use Vercel expects
  the Pro plan. The app works the same on both.
- **Company policy:** check that Gunnebo allows customer project data in your Notion workspace and on Vercel.

## If something goes wrong

| You see | Do this |
|---|---|
| "Gunnebo PM needs one more setting" | Add the missing variable in Vercel (Settings → Environment Variables), then **Deployments → ⋯ → Redeploy** |
| Setup says the Notion page isn't connected | In Notion, open **Gunnebo PM**, **••• → Connections**, add **Gunnebo PM app**, then click **Check again** |
| "Notion is busy" | Wait a minute. The app resumes by itself |
| You forgot the password | Change `APP_PASSWORD` in Vercel and redeploy |
| You think someone else has your password | Change `APP_PASSWORD`, then in Notion regenerate the integration secret and update `NOTION_TOKEN`. Redeploy |

---

## For developers

```bash
npm install
npm run dev        # http://localhost:3000, uses a local fake Notion (data/fake-notion.json) unless NOTION_TOKEN is set
npm test           # unit tests
npm run typecheck
npm run test:e2e   # Playwright end-to-end tests against the fake Notion
```

Local development needs `APP_PASSWORD` in `.env.local` (16+ characters). Design documents are in `docs/`:
`BRIEF.md` (requirements), `ONLINE-ARCHITECTURE.md` (Notion + Vercel), `DESIGN.md` (domain logic), `SERVICES.md`, `UI.md`.
