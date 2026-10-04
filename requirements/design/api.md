---
title: REST and MCP API
realises:
  - REQ-0013
  - REQ-0014
  - REQ-0020
  - REQ-0026
  - REQ-0027
---

# REST and MCP API

reqforge exposes one set of capabilities through two interfaces: a JSON REST API (axum) that also
serves the embedded web UI, and a stdio MCP server for agents. Both are thin adapters over the
same `Store`, `Workspace` and analysis functions (`lint`, `trace`, `verify`, `impact`,
`codetrace`, `evidence`, `evals`, `changes`). Multi-record edits proposed by agents go through
changesets: they are simulated on an in-memory copy, stored for human review, and applied
atomically as one git commit with a staleness check. This document describes the design as built,
verified against `server/src/api.rs`, `server/src/mcp.rs`, `server/src/changes.rs`,
`server/src/workspace.rs` and `server/src/store.rs`.

## Realised requirements

| ID | Title | How / where realised |
|----|-------|----------------------|
| REQ-0013 | Changeset simulation | `server/src/changes.rs` `materialize` builds an overlay of all records and applies ops in memory; `simulate` reports `valid`, `errors` (validation + dangling refs), lint delta with `mece_ok`, trace delta and `impact` (`blast_radius`). No file or git writes. |
| REQ-0014 | Changeset apply and staleness | `server/src/changes.rs` `apply`: under the store lock, compares `base_versions` with current versions, marks the changeset `stale` and returns 409 on mismatch, otherwise writes all touched records and makes one `store.commit`. |
| REQ-0020 | Project-scoped API | `server/src/api.rs` `dispatch` splits `/api/p/{KEY}/...` from unscoped `/api/...` (default project via `AppState::project`); `projects_route` manages projects; `Workspace::guard_multi` refuses management in single-repo mode. |
| REQ-0026 | REST API | `server/src/api.rs` `router_for` + fallback `dispatch` + `route`; static UI via `static_file` for non-`/api` GET paths. |
| REQ-0027 | MCP server | `server/src/mcp.rs` `main` (newline-delimited JSON-RPC 2.0 on stdin/stdout), `handle` (`initialize`, `ping`, `tools/list`, `tools/call`, -32601 otherwise), `tools`/`base_tools`, `call`. Started by `reqforge mcp` (`server/src/cli.rs` `run`, `Cmd::Mcp`). |

## 1. REST API

### 1.1 Router construction

`server/src/api.rs` builds a router with a single fallback handler rather than declared axum routes:

| Function | Role |
|----------|------|
| `router(store)` / `router_with_token(store, token)` | Wrap one repository in `Workspace::single` (single-project mode). Token from `REQFORGE_TOKEN`. |
| `workspace_router(ws, token)` | Multi-project router over a `Workspace`. |
| `app_state(ws, token)` | `AppState { ws, chats, agents, token }`; per-project `ChatRunner` and `AgentRunner` maps keyed by project key. |
| `router_for(state)` | `Router::new().fallback(dispatch).with_state(state)`. |
| `serve` / `serve_workspace` / `serve_app` | Bind TCP listener, spawn the agent-queue scheduler (`spawn_scheduler`), run `axum::serve`. |

`dispatch` processing order:

1. Path not starting with `/api`: GET serves the UI (`static_file`: embedded `web/dist` via
   `rust_embed`, or `REQFORGE_UI_DIR`; SPA fallback to `index.html` for extension-less paths);
   other methods get 404 JSON.
2. `same_origin` guard (loopback Host unless a token is set, Origin must equal Host, writes with a
   body must be `application/json` or `text/csv`) else 403.
3. `authorized`: when `REQFORGE_TOKEN` is set, `Authorization: Bearer <token>` (constant-time
   compare) else 401.
4. Body parse: `text/csv` kept raw, empty body is `{}`, otherwise JSON or 400.
5. `/api/projects/...` goes to `projects_route` (unscoped, workspace level).
6. `/api/p/{KEY}/rest...` resolves project `KEY`; any other `/api/rest...` resolves the workspace
   default (`AppState::project`; 404 "no projects yet" if there is none).
7. Streaming routes (chat SSE, agent SSE, agent live/cancel, agent-queue) are handled inline; all
   others run in `spawn_blocking` through `route(store, chat, method, rest, ...)`.

### 1.2 Project scoping (REQ-0020)

Every route in sections 1.4 to 1.8 is available both as `/api/p/{KEY}/<route>` and as
`/api/<route>` (default project). Each project is a separate `Store` rooted at its own repository
(`Workspace::store`), so records are isolated per project. In single-project mode
(`Workspace::single`, server started with `--repo`), `create`, `import`, `set_default` and `delete`
call `guard_multi` and fail with 400 "server is in single-project mode".

### 1.3 Projects (unscoped) - `projects_route`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | `ws.list()`: workspace, single flag, default key, projects with artifact counts |
| POST | `/api/projects` | Create project `{key, name, github?, private?}` (201) |
| POST | `/api/projects/import` | Register an existing repository `{path, key?}` (201) |
| GET | `/api/projects/{key}` | Describe one project |
| PATCH/PUT | `/api/projects/{key}` | `{name}` rename; `{default: true}` make default |
| DELETE | `/api/projects/{key}?confirm=KEY[&delete_remote=1]` | Delete project (confirm must equal key); cancels its chats |

### 1.4 Records - generic over `{kind}`

`{kind}` is parsed by `Kind::parse` (`requirements`, `epics`, `stories`, `tasks`, `components`);
an unknown kind is 404.

| Method | Path | Purpose | Implementation |
|--------|------|---------|----------------|
| GET | `/api/{kind}?q=..&field=value` | Search; with `limit/offset/sort/order` returns `{total, items}` | `store.search` / `query::page` |
| GET | `/api/{kind}/facets?q=..` | Facet counts | `query::facets` |
| POST | `/api/{kind}` | Create (201) | `store.create` |
| GET | `/api/{kind}/{id}` | Read | `store.get` |
| PATCH/PUT | `/api/{kind}/{id}` | Update; `_version` in body or `If-Match` for optimistic concurrency | `store.update` |
| DELETE | `/api/{kind}/{id}?force=1` | Delete; refuses if referenced unless forced | `store.delete` |
| POST | `/api/{kind}/bulk` | `{ids|q|where, set, add, remove, dry_run}` all-or-nothing | `store.bulk_update` |
| POST | `/api/{kind}/import` | `{rows:[...]}` or `text/csv` body, upsert by id | `csvio::parse`, `store.upsert_many` |
| GET | `/api/{kind}/export.csv` | CSV export (honours `q`, filters, `covered`) | `csvio::export` |

### 1.5 Metadata, analysis and repository

| Method | Path | Purpose | Implementation |
|--------|------|---------|----------------|
| GET | `/api/meta` | Config, kinds, taxonomy, schemas, enums | `api::meta` |
| PATCH/PUT | `/api/config` | Patch project config | `store.save_config` |
| GET | `/api/lint[?rule&severity&type&category&q&offset&limit]` | Full lint (memoised) or a filtered page | `changes::lint_memo`, `query::lint_page` |
| GET | `/api/trace[?matrix=0]` | Traceability report, optionally without matrix | `changes::trace_memo` |
| GET | `/api/evals?stage=&component=` | Eval registry | `evals::registry` |
| GET | `/api/context/{id}` | Record, references, children, impact, code, lint findings | `changes::context` |
| POST | `/api/sync` | Commit, pull --rebase, push | `store.sync` |
| GET / POST | `/api/sessions` | List / save elicitation session `{title, markdown, id?}` (201) | `store.sessions`, `store.save_session` |
| GET | `/api/sessions/ELI-NNNN` | Session markdown (`text/markdown`) | file read |

### 1.6 Verification, code and evidence

| Method | Path | Purpose | Implementation |
|--------|------|---------|----------------|
| GET | `/api/verification[?req=ID|full=1]` | Summary + statuses, one requirement, or full report | `verify::report`, `verify::summary` |
| GET | `/api/verification/history?limit=30` | Verified-ratio snapshots | `evidence::history` |
| GET | `/api/code` | Components and index summary | `store.records(Components)`, `verify::report` |
| GET | `/api/code/{component}` | Stored code index (404 if not scanned) | `codetrace::load_index` |
| POST | `/api/code/scan` | `{components?, root?}` scan trace tags and commit | `codetrace::scan` |
| GET | `/api/evidence?target=` | Latest evidence, optionally per target | `evidence::load_latest` |
| POST | `/api/evidence` | `{files:[{name, content}], component?, commit?, run?}` | `evidence::ingest` |
| GET | `/api/impact?component=&base=&root=` | Impact of a code change | `impact::impact` |

### 1.7 Changesets

| Method | Path | Purpose | Implementation |
|--------|------|---------|----------------|
| GET | `/api/changesets?status=` | List (newest first) | `changes::list` |
| POST | `/api/changesets` | Propose (201) | `changes::propose` |
| POST | `/api/changesets/simulate` | Dry run, always 200 | `changes::simulate` |
| GET | `/api/changesets/{id}` | Stored changeset with analysis | `changes::get` |
| POST | `/api/changesets/{id}/apply` | `{exclude: [op index]}` | `changes::apply` |
| POST | `/api/changesets/{id}/reject` | `{reason}` | `changes::reject` |

### 1.8 Chat, tasks and agents

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/chat/status` | Chat runner status |
| POST | `/api/chat` | `{chat_id, message, session_id, context}`; SSE stream (`chat_sse`) |
| POST | `/api/chat/cancel` | `{chat_id}` |
| GET | `/api/tasks/{id}/readiness` | `taskflow::readiness` |
| POST | `/api/tasks/{id}/start` | `{_version}` or If-Match; `taskflow::start` |
| GET | `/api/tasks/{id}/agent` | Agent plan + brief (`agent::plan`) |
| POST | `/api/tasks/{id}/agent` | SSE agent run (`agent_sse`) |
| POST | `/api/tasks/{id}/agent/cancel` | Cancel run |
| GET | `/api/tasks/{id}/agent/live?since=n` | Live progress |
| GET | `/api/tasks/{id}/runs` | Agent run logs |
| GET / POST | `/api/agent-queue` | View / set `{enabled, limit, confirm}` (`queue::view`, `queue::set`) |

### 1.9 Error model and status codes

Domain errors are `StoreError { message, status, details }` (`server/src/store.rs`) and are
rendered by `err_resp` as:

```json
{"error": "REQ-0007 was modified (version 4, you had 3); reload and retry", "details": []}
```

| Status | Source |
|--------|--------|
| 200 / 201 | Success; 201 for record create, project create/import, session save, changeset propose |
| 400 | Invalid JSON body, missing argument (`StoreError::bad`), single-project guard, bad project confirm |
| 401 | Token set and bearer missing or wrong |
| 403 | `same_origin` refused (cross-origin, non-loopback Host, simple content type) |
| 404 | Unknown route or kind, record/changeset/session/project not found, no default project |
| 409 | Version conflict on update, delete of a referenced record, duplicate project, changeset not pending, stale changeset |
| 422 | Record validation failure, bulk update rejected, changeset with no ops, changeset no longer applies cleanly |
| 500 | Blocking task panicked (`JoinError`) |

## 2. MCP server (REQ-0027)

### 2.1 Transport and protocol

`reqforge mcp` (`server/src/cli.rs` `run`) calls `mcp::main`, which reads newline-delimited JSON
from stdin and writes one JSON-RPC 2.0 response per line to stdout. Blank or unparseable lines are
skipped. `handle` implements:

| Method | Result |
|--------|--------|
| `initialize` | Echoes the client `protocolVersion` if in `PROTOCOLS` (`2025-06-18`, `2025-03-26`, `2024-11-05`), else the newest; `capabilities.tools.listChanged=false`; `serverInfo {name: "reqforge", version}` |
| `ping` | `{}` |
| `tools/list` | `{tools: tools()}` |
| `tools/call` | `{content:[{type:"text", text:<pretty JSON>}]}`; tool failures return `isError: true` with `{error, details}` text |
| other, with id | JSON-RPC error `-32601 method not found` |
| any notification (no id) | no response |

### 2.2 Tools

All tools except `init_repo`, `list_projects` and `create_project` get an optional `project`
property added by `tools()`. `call` resolves the store with `workspace::resolve(None, project,
None)` (explicit key, then `REQFORGE_PROJECT`, then a repository above the cwd, then the workspace
default).

| Tool | Maps to |
|------|---------|
| `taxonomy` | `api::meta` (same as `GET /api/meta`) |
| `search` | `store.search` |
| `get` | `store.get` (kind from id prefix) |
| `create` | `store.create` |
| `upsert_many` | `store.upsert_many` |
| `update` | `store.update` with `version` |
| `bulk_update` | `store.bulk_update` |
| `delete` | `store.delete` with `force` |
| `lint` | `lint::lint` |
| `trace` | `trace::evaluate` |
| `eval_registry` | `evals::registry` |
| `save_session` | `store.save_session` |
| `config` | `store.config_value` / `store.save_config` |
| `sync` | `store.sync` |
| `context` | `changes::context` |
| `simulate_changeset` | `changes::simulate` |
| `propose_changeset` | `changes::propose` |
| `get_changeset` | `changes::get` |
| `list_changesets` | `changes::list` |
| `apply_changeset` | `changes::apply` |
| `reject_changeset` | `changes::reject` |
| `verification` | `verify::report` / `verify::summary` |
| `impact` | `impact::impact` |
| `scan_code` | `codetrace::scan` |
| `ingest_evidence` | `evidence::ingest` (reads files from `paths`) |
| `list_projects` | `Workspace::list` |
| `create_project` | `Workspace::create` |
| `init_repo` | `Store::init` |

There is deliberately no project delete, rename or import tool; project deletion is only reachable
through REST `DELETE /api/projects/{key}` with a typed confirmation. Each MCP call is synchronous
and opens the store fresh, so writes go through the same validation, versioning and commit path as
REST.

## 3. Changesets (REQ-0013, REQ-0014)

### 3.1 Proposal format

A changeset is `{title, summary, rationale, ops, impact}`. Ops (`server/src/changes.rs` header):

| op | Fields | Semantics |
|----|--------|-----------|
| `create` | `kind`, `ref?`, `data`, `reason?` | Next free id per kind is assigned; `ref` binds a name to it |
| `update` | `id`, `patch?`, `add?`, `remove?`, `reason?` | `patch` replaces fields; `add`/`remove` edit list fields |
| `delete` | `id`, `reason?` | Removes the record |

`$name` tokens anywhere in later ops (ids, values, inside strings) are replaced with the id
assigned to the earlier `create` with `ref: name` (`resolve`, `REF_RE`).

```json
{
  "title": "Split export requirement",
  "summary": "Add a CSV export requirement and a story for it; retarget STORY-0012",
  "rationale": "Export was implicit in REQ-0026",
  "ops": [
    {"op": "create", "kind": "requirements", "ref": "csv",
     "data": {"title": "CSV export", "statement": "The system shall export any record list as CSV.",
              "type": "functional", "category": "api", "priority": "should"}},
    {"op": "create", "kind": "stories", "ref": "s1",
     "data": {"title": "Export records as CSV", "epic": "EPIC-0003", "requirements": ["$csv"]}},
    {"op": "update", "id": "STORY-0012", "remove": {"requirements": ["REQ-0031"]},
     "add": {"requirements": ["$csv"]}, "reason": "remap before delete"},
    {"op": "delete", "id": "REQ-0031"}
  ],
  "impact": {"note": "CSV stories only"}
}
```

### 3.2 Simulate - `materialize` and `simulate`

1. `base_view` snapshots every kind into a `View` (implements `Source`, so `lint` and `trace` run
   on it unchanged). `materialize` clones it and applies ops in order, coercing values with
   `model::coerce` and stamping version/created/updated.
2. Per-op failures (unknown op, missing kind/id, non-existent target) become `op N (kind): ...`
   errors. Every created/updated record is then checked with `model::validate`
   (reference existence against the overlay), `component_key_clash` and `task_dependency_errors`.
3. Dangling references: `dangling` lists every Ref/RefList field pointing at a missing record;
   only those new relative to the base are reported as errors, so pre-existing breakage does not
   block a changeset.
4. MECE delta: non-info lint findings before (memoised) and after are diffed by
   `rule|ids|message` into `new` and `resolved`. `mece_ok` is false if any new finding is an
   error, an `overlap` or a `coverage-gap`. Gap counts before/after are reported.
5. Traceability delta: per trace check, failures before vs after give `new_failures` and `fixed`;
   `ok_before`, `ok_after` and metrics are included.
6. Blast radius: `blast_radius(&[base, view], touched)` returns touched requirements, child
   requirements, linked stories, their tasks, evals covering touched requirements, components and
   `in_progress_work` (tasks/stories in-progress or done).

Output: `{valid, errors, ops, refmap, lint, trace, impact}`. Nothing is written; simulate takes no
lock and does no commit.

### 3.3 Propose

`propose` rejects empty `ops` (422), runs `simulate`, takes the store lock, allocates `CS-NNNN`,
records `base_versions` (current version of every updated or deleted record), stores
`changesets/CS-NNNN.json` with `status: pending` and the full analysis, and commits
`CS-NNNN: proposed`. It returns a compact summary (`changeset_id`, `valid`, `errors`, `mece_ok`,
counts). Records are untouched.

### 3.4 Apply - atomicity and staleness

`apply(store, id, exclude)` under `store.lock()`:

1. Status must be `pending`, else 409.
2. For every `base_versions` entry, the record must still exist with the same version. Otherwise
   the changeset is saved as `stale` with `stale_reasons`, committed (`CS-NNNN: stale`) and a 409
   is returned with the reasons in `details`.
3. Ops minus `exclude` indexes are re-materialized against the current store; any error is 422
   "no longer applies cleanly".
4. Each touched record is written (`write_unlocked`) or its file removed; the changeset is marked
   `applied` with `applied_at`, `excluded_ops` and `assigned_ids`; then a single
   `store.commit("CS-NNNN: apply - <title>")` commits records and changeset together.
5. Post-apply `trace::evaluate` and `lint::lint` results are returned (`trace_ok`, failing checks).

`reject` sets `rejected` with reason and time (409 if not pending).

## Open questions and gaps

- Atomicity is at the git-commit level only. Files are written one by one before the commit; an
  I/O error mid-loop leaves partial working-tree changes with no rollback. With config
  `autocommit: false`, `store.commit` is a no-op, so "one commit" is not produced (REQ-0014).
- Staleness only covers records that existed at proposal time (updated/deleted). Created ids are
  re-assigned at apply time, so they can differ from the ids shown in the simulation if other
  records were created in between; that is not reported as stale.
- `Workspace::rename` does not call `guard_multi`, so `PATCH /api/projects/{key} {name}` is
  allowed in single-project mode, which is arguably project management (REQ-0020 AC2).
- REQ-0026 says "every capability" is on REST; `init_repo` (initialise a repository at an
  arbitrary path) is MCP/CLI-only, and evidence ingestion over REST takes file contents rather
  than paths.
- The MCP `kind` enum lists four kinds and omits `components`, although `Kind::parse` and REST
  accept it. Unparseable input lines are silently dropped instead of returning JSON-RPC `-32700`;
  unknown tools return an `isError` tool result rather than a protocol error (REQ-0027).
- Simulate always returns 200; an invalid changeset is signalled only by `valid: false`.
