# reqforge web UI

React 19 + TypeScript (strict) + Vite + Tailwind CSS v4 + shadcn/ui (Radix) + TanStack Query.
It talks only to the reqforge JSON API (`/api/*`). The typed contract is in `src/api/types.ts`, and
`src/api/client.ts` is the only place that calls `fetch`.

## Commands

```bash
npm install
npm run dev         # http://localhost:5173, proxies /api -> http://127.0.0.1:8787
                    # (set REQFORGE_API=http://host:port to point elsewhere)
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint (the Vite template's linter)
npm run build       # typecheck, then a production bundle in web/dist/
npm run preview     # serve dist/ locally
```

The dev proxy strips the browser `Origin` header, because the API refuses requests whose Origin
does not match its Host (CSRF guard).

## Serving the build

`dist/` contains `index.html` and hashed files under `dist/assets/`. The favicon is inlined, so there
are no other root-level files. Serve `index.html` at `/` (and for unknown non-API paths, if you want
SPA fallback), `/assets/*` with long-lived caching, and the API under `/api/*` on the same origin.
`dist/` is committed because the Rust server embeds it: run `npm ci && npm run build` and commit `dist/` with any UI
change. (`src/index.css` excludes `dist/` from Tailwind's class scan, so builds are reproducible.)

## Layout

```
src/
  api/types.ts        wire types for every endpoint and SSE event
  api/client.ts       fetch wrapper (auth, JSON/CSV content types, ApiError), projectsApi (workspace),
                      projectApi(key) (every route as /api/p/<KEY>/…) + SSE chat stream
  state/project.tsx   project list, active project + hash routing (#/p/<KEY>, #/projects), useApi()
  state/app.tsx       view state of the active project (tab, filters, query, sort, paging, selection, drawer, tree)
  state/chat.tsx      chat log/session per project (persisted in localStorage), streaming send, cancel
  state/queries.ts    TanStack Query hooks; keys start with ["p", <KEY>, …]
  components/         Header, Sidebar, Crumbs, RecordDrawer, ChangesetCard, CodeEvidence (drawer "Code & evidence"),
                      verification (status badges, code locations, tag snippets), TaskStart (Start button),
                      TaskAgent (Start with agent: confirmation dialog with the parallel-branch warning, streamed/live run view, runs),
                      TaskComplete (Branch tab: agent-branch review, Complete with progress and refusals), AgentQueuePanel
                      (Tasks tab), VerifiedTrend (dashboard sparkline), chat/*, ui/* (shadcn)
  views/              ListView (also Components), TraceView, LintView, ChangesView,
                      VerificationView (gate, scan, ingest, impact; code-split), ProjectsView (+ onboarding; code-split)
```

## Projects

The server hosts a workspace of projects (or one repository with `--repo`: `single: true`, read-only project
management). The active project comes from the URL hash `#/p/<KEY>` (deep links, back/forward), else the last-used
project, else the server default; with no projects the UI shows onboarding. `#/projects` is the projects page
(create, import, rename, make default, delete). The project app (`AppProvider` + `ChatProvider`) is mounted with
`key={project}`, so a switch resets filters, search, selection, paging, drawer and lint state, and aborts an
in-flight chat stream instead of rendering it into the next project.

## localStorage keys

Global: `reqforge.token`, `reqforge.limit`, `reqforge.chat.open`, `reqforge.project` (last-used project).
Per project: `reqforge.tab.<KEY>`, `reqforge.open.<KEY>` (expanded tree types), `reqforge.chat.log.<KEY>`
(200 entries max), `reqforge.chat.session.<KEY>`; deleting a project clears them. The pre-projects unscoped
`reqforge.tab|open|chat.log|chat.session` keys are migrated once to the default project.

## Tests

Interactive elements carry stable `data-testid` attributes (`row`, `tree-type`, `tree-cat`,
`facet-chip`, `verif-badge`, `verif-chip`, `code-panel`, `ac-verif`, `comp-row`, `ingest-*`, `impact-*`, `bulk-*`, `drawer-*`, `changeset-card`, `cs-apply`, `choice-option`, `chat-input`, `start-task`, `agent-*`, `branch-*`, `task-complete`, `complete-*`, `queue-*`, `verif-trend`, …)
so a headless-browser script can drive the UI.
