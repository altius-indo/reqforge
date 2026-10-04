---
title: Web UI
realises:
  - REQ-0030
  - REQ-0031
  - REQ-0032
  - REQ-0033
  - REQ-0034
  - REQ-0045
  - REQ-0048
  - REQ-0050
  - REQ-0053
---

# Web UI design

The reqforge web UI is a single-page React application (`web/src`) served by the Rust server. It lets a user
browse, filter, edit and bulk-update thousands of requirement records across projects, inspect traceability,
lint and verification, talk to Claude in a chat panel that proposes changesets, and start tasks by hand or with
a coding agent. This document describes how the UI is actually built, reverse-engineered from the code.
All server interaction goes through the REST/SSE API under `/api/projects` and `/api/p/{KEY}/...`.

## Realised requirements

| id | title | how / where realised |
|----|-------|----------------------|
| REQ-0030 | Web UI lists at scale | `ListView` (server-side paging, sorting, search, bulk bar), `Sidebar` (category tree, facet chips), `Crumbs` (breadcrumbs, removable pills), `LintView` (paged, scoped to tree), `TraceView` |
| REQ-0031 | Record drawer | `RecordDrawer`: schema-generated `DetailsForm`, `LinksPanel` (Links & impact), `CodeEvidencePanel` (Code & evidence) |
| REQ-0032 | Chat panel | `state/chat.tsx` (SSE stream via `streamChat`), `chat/ChatPanel`, `chat/ChatMessage` (`choices` blocks), `ChangesetCard` (Apply, follow-up turn) |
| REQ-0033 | Projects UI | `state/project.tsx` (hash routing `#/p/KEY`), `ProjectSwitcher`, `ProjectDialogs` (create/import, rename, delete with typed key), `ProjectsView` |
| REQ-0034 | Verification UI | `VerifBadge` column + verification facet chips, `VerificationView` (gate, counts, components, Scan now, `IngestDialog`, `ImpactPanel`), `VerifiedTrend` |
| REQ-0045 | Keyboard and theme support | Esc listener in `App.tsx` `ProjectApp`; `main.tsx` toggles `.dark` from `prefers-color-scheme`; dark tokens in `index.css` |
| REQ-0048 | In-app help and how-to panel | `state/help.tsx` `HelpProvider`, `help/HelpButton`, `help/HelpPanel`, `help/guides.ts` (Markdown in `web/help/*.md`) |
| REQ-0050 | Start task action | `TaskStart` `StartButton` in the tasks list `_start` column and the drawer `TaskActions` |
| REQ-0053 | Agent run queue | `AgentQueuePanel` in the Tasks tab (UI side: toggle with confirmation, limit, state, running and waiting lists) |

## Stack

From `web/package.json`:

| concern | choice |
|---------|--------|
| framework | React 19 (`react`, `react-dom`), TypeScript ~6, Vite 8 (`@vitejs/plugin-react`) |
| server state | `@tanstack/react-query` 5 |
| styling | Tailwind CSS 4 (`@tailwindcss/vite`), `tw-animate-css`, `class-variance-authority`, `clsx`, `tailwind-merge` |
| components | shadcn/ui on `radix-ui` (`web/src/components/ui/*`: sheet, dialog, tabs, dropdown-menu, collapsible, tooltip, ...) |
| icons, toasts, font | `lucide-react`, `sonner`, `@fontsource-variable/inter` |
| Markdown | `react-markdown` + `remark-gfm` (chat messages and help guides, `chat/Markdown.tsx`) |
| quality | `tsc -b` typecheck, `oxlint src`, e2e via `node e2e/run.mjs` |

There is no client-side router library and no global state library: routing is the URL hash and state lives in
React contexts.

## Application shell

`web/src/main.tsx` creates a `QueryClient` (no refetch on focus, `retry: 1`, `staleTime` 15 s), wraps the app in
`TooltipProvider`, `ProjectProvider` and a `sonner` `Toaster`, and applies the colour scheme (see Theme).

`web/src/App.tsx` decides what to render from `useProjects()`:

- project list not loaded: `Shell` with loading or `projects-error`;
- route `#/projects`: `Shell` + lazily loaded `ProjectsView`;
- no active project: `Shell` + `Onboarding`;
- otherwise `<AppProvider key={active}><ChatProvider><ProjectApp/></ChatProvider></AppProvider>`. Keying by
  project remounts view state, chat and drawer on every switch (REQ-0033 AC4).

`ProjectApp` lays out `Header`, a CSS grid of `Sidebar` (270 px), `main` and, when open, `ChatPanel` (410 px),
plus the `RecordDrawer`. `MainView` picks the view from `view.tab`; `VerificationView`, `ProjectsView`,
`Onboarding` and `CreateProjectDialog` are code-split with `lazy()`. `HelpProvider` wraps everything, so help is
available on project-less pages too.

`components/Header.tsx`:
- `TopBar` (shared by `Header` and `ProjectsHeader`): brand, `ProjectSwitcher`, `HelpButton`.
- `Header`: tab nav (`requirements`, `epics`, `stories`, `tasks`, `components`, `trace`, `verification`,
  `lint`, `changes`) with a pending-changesets badge (`usePendingCount`, polled every 60 s), `TokenForm` shown
  after a 401, Sync button (`POST /sync`), chat toggle, and a hamburger that opens the sidebar `Sheet` on small
  screens.

`components/Sidebar.tsx` renders `SidebarBody` both as a fixed `aside` (lg+) and inside a left `Sheet` (mobile).
`components/Crumbs.tsx` renders `All <kind> > type > category (> children of X)` plus removable filter pills and
a search pill.

## State and data fetching

| module | responsibility |
|--------|----------------|
| `state/project.tsx` `ProjectProvider` | project list (`["projects"]`, stale 30 s), hash routing (`#/p/<KEY>`, `#/projects`) via `useSyncExternalStore`, active-project resolution (hash, last used `reqforge.project`, server default, first), canonical-hash rewrite, `forget()` after delete, create-dialog mode, token prompt; `useApi()` returns `projectApi(key)` |
| `state/app.tsx` `AppProvider` | per-project `ViewState` (`tab`, `q`, `filters`, `sort`, `order`, `offset`, `limit`, `lint`), selection (`sel`, `selAll`), tree expansion, drawer state, `goto()`, `refreshAll()`; `meta` (schemas, taxonomy) cached forever |
| `state/chat.tsx` `ChatProvider` | chat log, session, streaming, context payload |
| `state/help.tsx` `HelpProvider` | help sheet open state, context, search, focus return |
| `state/queries.ts` | react-query hooks; every project-scoped key starts with `["p", KEY, ...]` |
| `api/client.ts` | `request()` (JSON, bearer token, 401 listeners, `ApiError` with `status` and `details`), `projectsApi`, `projectApi(key)`, `streamSse()`, `streamChat()`, `streamAgent()` |
| `lib/storage.ts` | `ls` localStorage wrapper; `pkey(name, project)` per-project keys; legacy migration and per-project clearing |

Mutating requests always carry a JSON (or `text/csv`) content type, which the server uses as a CSRF guard.
Writes call `refreshAll()`, which invalidates every `["p", KEY, ...]` query except `meta`, plus `["projects"]`.
Page size (`reqforge.limit`, one of 50/100/250/500, default 100) and last tab (per project) persist in
localStorage.

## Views

### ListView (`views/ListView.tsx`) - REQ-0030

One component for the five record kinds, keyed by tab. Columns per kind come from `COLS` (requirements: title +
statement, type/category, priority, status, `_verification`, `_stories`, `_children`, tags; tasks include
`_start`). Features:

- **Paging**: `Pager` shows `from-to of total` (top, and bottom when needed), a page-size select and Prev/Next;
  `useListPage` passes `offset`/`limit` to `GET /api/p/KEY/{kind}` with `keepPreviousData`. First page = 100 rows.
- **Sorting**: clicking a `Th` toggles `sort`/`order` server-side (`aria-sort`); `_verification` and `_start`
  are not sortable.
- **Search**: free text or `field:value` syntax, applied on Enter.
- **Filters and facets**: sidebar facet chips (`SIDE_FACETS` per kind) toggle `|`-joined values; requirements
  also have Traceability (`covered=yes|no`) and Verification chips; stories have an epic list. Active filters
  appear as removable pills in `Crumbs`.
- **Drill-down**: requirements `Tree` (type > category) with counts, story-coverage bars, lint health dots,
  verified counts, `gap` / `waived` markers; selecting a node sets `type`/`category` filters. The `_children`
  cell filters by `parent`.
- **Bulk edit**: row and page checkboxes; `BulkBar` offers "Select all N matching", field / mode (`set`, `add`,
  `remove` for list fields) / value, Dry run and Apply via `POST {kind}/bulk` with either `ids` or `q` + `where`.
  Bulk-by-filter refuses the `covered` and `verification` filters (client-side toast).
- **Other**: New (empty drawer), Export CSV (`export.csv` URL with current filters), Import CSV, "Ask Claude
  about this view". On the Tasks tab, `AgentQueuePanel` sits above the table.

### TraceView (`views/TraceView.tsx`)

Stat cards from `GET trace?matrix=0`: gate PASS/FAIL and score, requirement and criteria coverage (the
requirement card jumps to `covered=no`), counts; a checks table with collapsible failures (first 200, IDs
linkified); "Ask Claude to fix gaps".

### LintView (`views/LintView.tsx`)

`GET lint` with `rule`, `severity`, the tree's `type`/`category`, `q`, `offset`, `limit=100`. Cards for
errors/warnings/info and taxonomy gaps, rule chips, severity select, a summary line with the scope and range,
Prev/Next paging. The sidebar shows the requirements tree, so lint is scoped to the tree selection.

### ChangesView (`views/ChangesView.tsx`)

Table of all changesets (`id`, `title`, `ops`, `status`, `created`); clicking a row renders its `ChangesetCard`.

### VerificationView (`views/VerificationView.tsx`) - REQ-0034

- Cards: verification gate PASS/FAIL with failing-check count, verified-criteria ratio, requirements with tagged
  code, evidence results.
- `VerifiedTrend`: inline SVG area chart of `GET verification/history?limit=30` on a fixed 0-100% scale with
  hover tooltip, delta vs previous ingest and an `aria-label` text alternative.
- Criteria and requirements status bars with per-status buttons that `goto("requirements", {verification})`.
- Scan now (`POST code/scan`), per-component Scan, "Ingest results" (`IngestDialog`: JUnit XML / eval JSON
  files, optional component, commit, CI run URL; posts `POST evidence`, shows cases/matched/unmatched/passed/
  failed, then `refreshAll()`), Ask-Claude shortcuts for untested and failing/suspect criteria.
- Components table (commit, scanned time, tagged files, implements, verifies); empty state links to Components.
- `ImpactPanel`: component + base ref, `GET impact`; lists changed files (untraced flagged), requirements
  touched (with via file:line), tests to re-run, evals, criteria at risk and untraced changes with an
  Ask-Claude action.
- Gate checks table.

`components/verification.tsx` holds `VERIF` (label, colour, help per status: verified, pending, untested,
suspect, failing), `VerifBadge` (label always shown, never colour alone), `CodeLoc`, `TagHelp`.

### ProjectsView (`views/ProjectsView.tsx`) - REQ-0033

Workspace path, table of projects with key, default/active/unavailable badges, path, GitHub/remote, artifact
counts and created date; actions Open, Rename, Make default, Delete. In single-repository mode (`--repo`) a
notice replaces the management actions. `Onboarding` is the empty state with Create and Import.

## RecordDrawer (`components/RecordDrawer.tsx`) - REQ-0031, REQ-0045

A non-modal right `Sheet` (600 px, outside clicks ignored), keyed by `kind-id-nonce`. Header shows `ID - vN`
and title, Ask Claude, and close. Tabs:

| tab | content |
|-----|---------|
| Details | `DetailsForm`: one `Field` per entry of `meta.schemas[kind]`. Enum fields use a select, `text` a textarea, `objlist` JSON textarea, lists comma-separated, `int` a number input; special inputs for requirement `category` (taxonomy datalist), story `component` (`ComponentKeyInput`, warns on unknown keys) and task `depends_on` (`TaskIdsInput`, picker + status chips + unknown-id warning). Save sends `PATCH` with `_version` (409 conflict message) or `POST` on create; Delete needs a second click. |
| Links & impact | `LinksPanel` from `GET context/{id}`: for requirements, stat cards (stories, tasks, evals, components), parent/children, realising stories, tasks, "Acceptance criteria -> evals" (evals whose `covers` include `REQ#AC`, uncovered flagged), lint findings; for other kinds, referenced-by and references. |
| Code & evidence | requirements only: `CodeEvidencePanel` (`components/CodeEvidence.tsx`): overall status, implementing code locations (`CodeLoc`, links to the repo blob), per criterion tagged tests, covering evals, latest evidence (status, commit, CI run link), suspect changed files, tagging help. Falls back to `GET verification?req=` for older servers. |
| Agent | tasks only: `AgentRunView` + `RunsList` (see TaskAgent). |

For tasks, `TaskActions` above the tabs shows status, `StartButton` (drawer layout) and "Start with agent".

**Esc closes the drawer**: `ProjectApp` adds a `document` `keydown` listener calling `closeDrawer()` on
`Escape`. `HelpProvider` installs a capture-phase window listener while help is open, so Esc closes only the
help panel in that case.

## Chat panel (`components/chat`, `state/chat.tsx`) - REQ-0032

- **Transport**: `send()` posts to `POST /api/p/KEY/chat` and reads `text/event-stream` with `streamSse()`
  (fetch + `ReadableStream`, `data:` lines split on blank lines). Events: `session`, `tool` (grouped into a live
  collapsible `ToolGroup`), `text`, `changeset`, `warning`, `error`, `done` (session id, cost). Stop calls
  `POST chat/cancel` with the turn's `chat_id`; unmount aborts the stream and drops late events.
- **Context**: optional "include view & selection" sends tab, filters, query, up to 200 selected ids and the
  selected total.
- **Multiple-choice questions**: `ChatMessage` splits assistant text on fenced `choices` JSON blocks
  (`{question, options, multi}`); single choice renders buttons, multi renders checkboxes + Send. Answering sends
  `"<question> -> <option>"` and marks that block answered (disabled).
- **ChangesetCard** (`components/ChangesetCard.tsx`): status, summary, verdicts (valid, MECE, trace before ->
  after, gaps, lint errors), operations with per-op include checkbox and field diffs, new lint findings,
  traceability delta, impact (stories, tasks, evals, components, in-progress work), impact notes and risks.
  Apply (`POST changesets/{id}/apply` with `exclude`) is disabled unless valid; afterwards, if a session exists,
  it sends a follow-up turn with the apply result (assigned ids, lint, trace) without view context. Reject and
  "Ask to revise" are also offered; stale changesets show reasons.
- **Persistence**: log (last 200 entries) and session id are stored per project
  (`pkey("chat.log", KEY)`, `pkey("chat.session", KEY)`); panel open state is global. `ChatPanel` shows CLI
  availability from `GET chat/status`, last-turn cost, New, help, Enter-to-send.

## Projects: switch, create, delete - REQ-0033

- `ProjectSwitcher`: header dropdown listing every project with key, name, default badge, unavailable icon and
  requirement count; refreshes on open; selecting calls `open(key)` which sets `#/p/KEY`. Also "New project..."
  and "Manage projects" (`#/projects`). Unknown hash keys produce a toast and the hash is rewritten.
- `CreateProjectDialog`: Create tab validates the key live against `KEY_RE` (`^[A-Z][A-Z0-9_-]{1,15}$`, input
  upper-cased) and existing keys with specific hints, name required, optional GitHub `owner/name` + private;
  Import tab takes an absolute path and optional key. On success it refreshes and switches to the new project.
- `DeleteProjectDialog`: destructive alert with artifact counts and path, optional "also delete the GitHub
  repository", focus goes to the confirmation input, and Delete is enabled only when the typed text equals the
  key; calls `DELETE /api/projects/KEY?confirm=KEY`. `forget()` clears that project's storage and query cache.
- Isolation: per-project query keys, per-project localStorage keys and the `key={active}` remount.

## Theme - REQ-0045

`main.tsx` reads `matchMedia("(prefers-color-scheme: dark)")`, toggles the `dark` class on `<html>` and listens
for changes. `index.css` defines light tokens and a `.dark` block (including status colours `--ok`, `--err`,
`--warn`, `--info`) consumed through Tailwind (`text-ok`, `bg-err/10`, ...). There is no manual toggle.

## Help panel (`components/help`, `state/help.tsx`) - REQ-0048

- `HelpButton` sits in `TopBar`, so it is on every view including projects and onboarding; `ChatPanel` has its
  own help button (context `chat`). It preloads the guides chunk on hover/focus.
- `HelpProvider` renders a right `Sheet` over the current view without touching view state. Opening moves focus
  to the search box; Esc (capture listener) and the close button close it; focus returns to the trigger.
- `help/guides.ts` bundles `web/help/[0-9]*.md` with `import.meta.glob(..., {query: "?raw"})`, parses front
  matter (`id`, `title`, `tabs`, `keywords`); `sectionFor(context)` picks the section for the active tab and
  `searchGuides()` keeps sections containing every query word. `help/load.ts` lazy-loads and caches the chunk.
- `HelpPanel` shows a contents list (buttons, not hash links) and the sections; a search with no match shows
  `help-no-results`. Seven guides exist: browse and filter, edit and bulk update, chat and changesets, lint and
  traceability, verification and impact, code components, projects.

## Tasks: Start, coding agent, queue

**StartButton** (`components/TaskStart.tsx`, REQ-0050) renders only when `status === "todo"`. It checks
`GET tasks/{id}/readiness` (rows only when `depends_on` is non-empty); with unfinished dependencies it is
disabled, shows a lock, a tooltip and a "waits for ..." list. Click posts `POST tasks/{id}/start` with the loaded
`_version`; success toasts which story/epic also moved; errors (e.g. 409 conflict, refused dependencies) toast
the message and always `refreshAll()` so the row reloads. The single-commit and parent-promotion rules are
server behaviour.

**TaskAgent** (`components/TaskAgent.tsx`, REQ-0051): `useAgentRun` streams `POST tasks/{id}/agent` (SSE) for a
run started in the drawer, otherwise polls `GET tasks/{id}/agent/live` (1.5 s running, 4 s idle) so queue-started
runs appear. `AgentConfirmDialog` shows component path, branch, worktree and the full brief before anything
runs. `AgentRunView` shows the event log, Cancel, and the result (exit, branch, commits, sandbox violations,
"not marked done"). `RunsList` lists past runs.

**AgentQueuePanel** (`components/AgentQueuePanel.tsx`, REQ-0053) polls `GET agent-queue` every 3 s (visible page
only). It shows an on/off switch, state, concurrency select 1-8, "turned on/off by USER - time" (or "off by
default"), running tasks and the numbered waiting (eligible) tasks in start order; items open the task drawer
on the Agent tab. Toggling opens a confirmation stating the number of eligible tasks and the limit (or, for off,
that active runs keep running), then posts `{enabled, confirm: true}`. Eligibility, concurrency and scheduling
are server-side.

## View and component table

| file | component(s) | role | REQ |
|------|--------------|------|-----|
| `web/src/App.tsx` | `App`, `ProjectApp`, `MainView`, `Shell` | routing by project, layout, Esc closes drawer | REQ-0033, REQ-0045 |
| `web/src/components/Header.tsx` | `TopBar`, `Header`, `ProjectsHeader`, `TokenForm` | tabs, sync, chat toggle, help | REQ-0048 |
| `web/src/components/Sidebar.tsx` | `Sidebar`, `Tree`, `FacetChips` | drill-down tree, facets, verification chips | REQ-0030, REQ-0034 |
| `web/src/components/Crumbs.tsx` | `Crumbs`, `Pill` | breadcrumbs, removable pills | REQ-0030 |
| `web/src/views/ListView.tsx` | `ListView`, `Pager`, `BulkBar`, `Cell` | paged list, sort, bulk | REQ-0030, REQ-0034, REQ-0050 |
| `web/src/views/TraceView.tsx` | `TraceView` | trace gate | REQ-0030 |
| `web/src/views/LintView.tsx` | `LintView` | paged, scoped lint | REQ-0030 |
| `web/src/views/ChangesView.tsx` | `ChangesView` | changeset list | REQ-0032 |
| `web/src/views/VerificationView.tsx` | `VerificationView`, `IngestDialog`, `ImpactPanel` | verification dashboard | REQ-0034 |
| `web/src/components/VerifiedTrend.tsx` | `VerifiedTrend` | 30-ingest trend chart | REQ-0034 |
| `web/src/views/ProjectsView.tsx` | `ProjectsView`, `Onboarding` | project management | REQ-0033 |
| `web/src/components/RecordDrawer.tsx` | `RecordDrawer`, `DetailsForm`, `LinksPanel`, `TaskActions` | record drawer | REQ-0031, REQ-0050 |
| `web/src/components/CodeEvidence.tsx` | `CodeEvidencePanel` | code and evidence per criterion | REQ-0031, REQ-0034 |
| `web/src/components/chat/*` | `ChatPanel`, `ChatMessage`, `Choices`, `Markdown` | chat UI | REQ-0032 |
| `web/src/components/ChangesetCard.tsx` | `ChangesetCard` | changeset review and apply | REQ-0032 |
| `web/src/components/ProjectSwitcher.tsx` | `ProjectSwitcher` | switch projects | REQ-0033 |
| `web/src/components/ProjectDialogs.tsx` | `CreateProjectDialog`, `RenameProjectDialog`, `DeleteProjectDialog` | create, rename, delete | REQ-0033 |
| `web/src/components/help/*`, `web/src/state/help.tsx` | `HelpButton`, `HelpProvider`, `HelpPanel` | help panel | REQ-0048 |
| `web/src/components/TaskStart.tsx` | `StartButton` | one-click Start | REQ-0050 |
| `web/src/components/TaskAgent.tsx` | `useAgentRun`, `AgentConfirmDialog`, `AgentRunView`, `RunsList` | coding-agent runs | REQ-0051 |
| `web/src/components/AgentQueuePanel.tsx` | `AgentQueuePanel` | agent queue state and toggle | REQ-0053 |

## End-to-end tests (`web/e2e`)

`web/e2e/run.mjs` (Node 22, no test framework) runs suites `core`, `projects`, `code`, `help`, `help-a11y`,
`theme`, `task-start`, `agent-start`, `agent-queue` (or `all`). For each suite it seeds fresh data with the
repository seeders into a temp directory, copies `web/dist`, injects `lib/prelude.js` and `suites/<suite>.js`
into `index.html`, serves it with the reqforge binary (`REQFORGE_UI_DIR`), opens headless Chrome, and waits for
the page to POST its PASS/FAIL log as a session file. It prints a summary, optionally writes JUnit XML
(`npm run e2e`), and exits 1 on failure. `lib/prelude.js` provides `ok()`, `until()`, test-id selectors, input
setters, Radix pointer helpers and a CDP bridge (used by `theme` to emulate `prefers-color-scheme` and check
WCAG AA contrast). `fake-claude.py` stands in for `claude -p`: it asks a `choices` question, proposes a real
changeset, answers the follow-up, and in agent mode commits in the worktree (`SLOW`/`QWAIT` briefs for cancel and
queue tests). Components expose `data-testid` attributes for these suites.

## Open questions and gaps

1. **REQ-0030 AC6, traceability view**: `TraceView` is neither paged nor scoped to the tree selection. It loads
   the whole `GET trace?matrix=0` report and caps each check's failure list at 200. Only `LintView` is paged and
   scoped.
2. **REQ-0031 AC2**: Links & impact lists stories and tasks per requirement. Only evals are broken down per
   acceptance criterion.
3. **REQ-0032 AC3**: the follow-up after Apply is sent only when a chat session id exists. Applying from the
   Changes tab with no chat session sends no follow-up.
4. **REQ-0032 AC4**: the per-project chat log is in browser localStorage, capped at 200 entries. It is not
   shared across browsers or machines.
5. **REQ-0034 AC1**: bulk update by filter rejects the `verification` filter. Users must select rows instead.
6. **REQ-0045 AC2**: the theme only follows the OS preference; there is no in-app override. Contrast is checked
   by the `theme` e2e suite, not enforced at build time.
7. **REQ-0048 AC3**: the guides cover the six required topics plus code components. No guide covers the task
   Start action, coding-agent runs or the agent queue, and the `edit-and-bulk-update` guide has no `tabs` entry.
8. **REQ-0050 AC2-AC5 and REQ-0053 AC2-AC5**: the single commit, parent promotion, 409 handling, dependency
   refusal, eligibility, concurrency limit and restart rules are enforced by the server. The UI only shows them
   and refreshes after them, so this document cannot confirm them.
9. **REQ-0053 AC1**: changing the concurrency limit applies at once with no confirmation. The AC only requires
   confirmation for on/off, but it is unclear whether limit changes are recorded with user and time.
