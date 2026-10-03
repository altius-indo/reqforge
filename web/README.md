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
`dist/` is git-ignored, so run `npm ci && npm run build` before building anything that embeds it.

## Layout

```
src/
  api/types.ts        wire types for every endpoint and SSE event
  api/client.ts       fetch wrapper (auth, JSON/CSV content types, ApiError) + SSE chat stream
  state/app.tsx       view state (tab, filters, query, sort, paging, selection, drawer, tree)
  state/chat.tsx      chat log/session (persisted in localStorage), streaming send, cancel
  state/queries.ts    TanStack Query hooks
  components/         Header, Sidebar, Crumbs, RecordDrawer, ChangesetCard, chat/*, ui/* (shadcn)
  views/              ListView, TraceView, LintView, ChangesView
```

## localStorage keys

`reqforge.token`, `reqforge.tab`, `reqforge.limit`, `reqforge.open` (expanded tree types),
`reqforge.chat.log` (200 entries max), `reqforge.chat.session`, `reqforge.chat.open`.

## Tests

Interactive elements carry stable `data-testid` attributes (`row`, `tree-type`, `tree-cat`,
`facet-chip`, `bulk-*`, `drawer-*`, `changeset-card`, `cs-apply`, `choice-option`, `chat-input`, …)
so a headless-browser script can drive the UI.
