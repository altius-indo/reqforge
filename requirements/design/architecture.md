---
title: Architecture
realises:
  - REQ-0026
  - REQ-0027
  - REQ-0028
  - REQ-0029
  - REQ-0036
  - REQ-0046
  - REQ-0047
---

# Architecture

reqforge is a requirements-engineering tool that stores requirements, epics, stories, tasks
and components as JSON files in a git repository (optionally backed by GitHub) and exposes
them through several front ends. This document describes how the system is actually built:
one Rust binary that contains the record store, the analysis engines, a REST API with an
embedded React web UI, a stdio MCP server, a CLI and an interactive console, plus a Claude
Code plugin wrapper. All AI behaviour runs through the locally installed Claude Code CLI; the
binary itself never calls a model API.

## Realised requirements

| Id | Title | How / where realised |
|----|-------|----------------------|
| REQ-0026 | REST API | `server/src/api.rs`: a single axum fallback handler `dispatch` serves `/api/*` (routed by `route` and `projects_route`) and the embedded UI at `/` via `static_file`. |
| REQ-0027 | MCP server | `server/src/mcp.rs`: `main` reads newline-delimited JSON-RPC 2.0 on stdin; `handle` implements `initialize`, `ping`, `tools/list`, `tools/call`, and returns `-32601` for unknown methods. `tools()` lists store, analysis, changeset, verification and project tools; there is no delete-project tool. |
| REQ-0028 | Command-line interface | `server/src/cli.rs`: clap `Cli` / `Cmd` with global `--repo`, `-P/--project`, `--workspace`; `run` dispatches every subcommand; `--gate` flags return exit code 1, errors return 2 (`main`). |
| REQ-0029 | Interactive console | `server/src/console.rs`: `Console::onecmd` / `exec` implement `ls`, `show`, `set`, `new`, `bulk` (with `_` = ids of the last listing), `rm`, `lint`, `trace`, `sync`. |
| REQ-0036 | Claude Code plugin packaging | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` -> `${CLAUDE_PLUGIN_ROOT}/bin/reqforge mcp`, `agents/*.md`, `skills/*/SKILL.md`, `bin/reqforge`. Contract-tested in `server/tests/plugin.rs`. |
| REQ-0046 | Single Rust binary with embedded UI | `server/Cargo.toml` feature `ui` (default) pulls in `rust-embed`; `api.rs` `Assets` embeds `../web/dist`; `server/build.rs` writes a placeholder if the UI was not built. External processes are only `git`, `gh`, `claude` (plus `sh`/`kill` for eval runs and agent cancellation). |
| REQ-0047 | Claude Code as the agent runtime | `server/src/chat.rs` `ChatRunner::stream` and `server/src/agent.rs` `AgentRunner::run` spawn `claude -p --output-format stream-json` with `--plugin-dir` and explicit `--allowedTools` / `--disallowedTools`. No HTTP client crate is a dependency. |

## System overview

```
                         +---------------------------+
   Browser (React UI) -->|  GET /            static   |
                         |  /api/*, /api/p/{key}/*    |      Claude Code (user session)
                         |  api.rs  dispatch/route    |        |  plugin: agents/, skills/
                         +-------------+-------------+        |  .mcp.json -> bin/reqforge mcp
   Terminal:                           |                      v
   reqforge <cmd> ----> cli.rs ---+    |              +---------------+
   reqforge console --> console.rs+    |              | mcp.rs (stdio)|
                                  |    |              +-------+-------+
                                  v    v                      |
                         +------------------------------------+-------+
                         | workspace.rs  Workspace / resolve()         |
                         |   reqforge-workspace.json -> project stores |
                         +--------------------+------------------------+
                                              v
                         +---------------------------------------------+
                         | store.rs  Store (JSON file per record)      |
                         | model.rs  kinds, taxonomy, schemas          |
                         | analysis: lint, trace, query, changes,      |
                         |   evals, cicd, codetrace, evidence, verify, |
                         |   impact, taskflow, queue                   |
                         +-----+------------------------------+--------+
                               |                              |
                               v                              v
                     git / gh (subprocess)        chat.rs / agent.rs spawn
                     commit, pull --rebase,       `claude -p ...` (Claude Code CLI)
                     push, gh repo create/delete  which calls back into
                                                  bin/reqforge mcp
```

Every front end is a thin adapter: it parses its own input format, resolves which project
store to act on, and calls the same `Store` methods (`search`, `get`, `create`, `update`,
`bulk_update`, `upsert_many`, `delete`, `sync`) and analysis functions (`lint::lint`,
`trace::evaluate`, `verify::report`, `impact::impact`, `changes::*`). Business rules
(validation, versioning, autocommit) therefore live in one place.

## Module map

`server/src/lib.rs` declares the modules below; `server/src/main.rs` is a one-liner that exits
with `reqforge::cli::main()`.

| Module | Role |
|--------|------|
| `main.rs` | Process entry; delegates to `cli::main`. |
| `cli.rs` | clap CLI, subcommand dispatch (`run`), `serve`, `console`, `mcp` entry points. |
| `api.rs` | axum REST API, SSE streams for chat and agent runs, CSRF/token guard, embedded static UI, agent-queue scheduler. |
| `mcp.rs` | stdio MCP server (JSON-RPC 2.0): tool catalogue and tool dispatch. |
| `console.rs` | Line-oriented REPL over a `Store`. |
| `workspace.rs` | Multi-project registry (`reqforge-workspace.json`), project create/import/rename/default/delete, `resolve` of the target store. |
| `store.rs` | File-backed record store, one JSON file per record; `git` submodule for commit/sync/remote creation. |
| `model.rs` | Record kinds (`KINDS`: requirements, epics, stories, tasks, components), taxonomy, schemas, enums, validation. |
| `query.rs` | Paging, sorting, facets, category tree, paged lint. |
| `lint.rs` | MECE and quality lint. |
| `trace.rs` | Deterministic traceability evaluation (CI gate). |
| `changes.rs` | Changesets: simulate, propose, apply, reject; record context. |
| `csvio.rs` | CSV export/import (upsert by id). |
| `evals.rs` | Eval registry and stage runner (runs commands with `sh`). |
| `cicd.rs` | GitHub Actions pipeline generator. |
| `codetrace.rs` | Trace-tag scanner producing `code/<component>.json`. |
| `evidence.rs` | Ingest of JUnit XML, libtest logs and eval reports as evidence. |
| `verify.rs` | Per-criterion verification status and gate. |
| `impact.rs` | Requirements/tests/evals affected by a code diff (`git diff`). |
| `taskflow.rs` | Task start and readiness rules. |
| `chat.rs` | Web chat bridge to `claude -p`; tool policy (`allowed`, `denied`). |
| `agent.rs` | Sandboxed coding-agent runs in git worktrees via `claude -p`. |
| `queue.rs` | Per-project agent queue that auto-starts eligible tasks. |

## Front ends over one store

### REST API and web UI (REQ-0026)

- `api::router_for` builds an axum `Router` with a single fallback handler, `dispatch`. Paths
  not starting with `/api` are served by `static_file` (GET only); everything else is JSON.
- Project management lives under `/api/projects` (`projects_route`). All other routes are
  either project-scoped (`/api/p/{key}/...`) or default to the workspace default project
  (`AppState::project`).
- `route` covers meta, config, lint, trace, evals registry, sync, chat status/cancel, context,
  verification (+history), code index and scan, evidence, impact, changesets, sessions, tasks
  and generic `{kind}` CRUD, bulk, import, `export.csv` and facets. Optimistic concurrency uses
  `_version` or `If-Match`. Long-running chat (`POST /api/chat`) and agent runs
  (`POST /api/tasks/{id}/agent`) stream Server-Sent Events (`chat_sse`, `agent_sse`).
- Blocking store work runs on `tokio::task::spawn_blocking`.
- Security (REQ-0040): `same_origin` refuses non-loopback Host (unless a token is set),
  mismatched Origin and non-JSON/CSV write bodies; `authorized` checks
  `Authorization: Bearer $REQFORGE_TOKEN` in constant time.
- `api::serve` (single repo) and `api::serve_workspace` (multi-project) bind the listener and
  start `spawn_scheduler` for the agent queue (REQ-0053). `reqforge serve` defaults to
  `127.0.0.1:8787`.

The web UI is a React 19 + Vite + Tailwind single-page app in `web/src` (`App.tsx`,
`main.tsx`). `vite build` emits `web/dist`; in development `vite.config.ts` proxies `/api` to
`REQFORGE_API` (default `http://127.0.0.1:8787`) and strips `Origin` to pass the CSRF guard.

### MCP server (REQ-0027)

- Started by `reqforge mcp` (`Cmd::Mcp` -> `mcp::main`). Transport is newline-delimited
  JSON-RPC 2.0 on stdin/stdout; notifications get no reply.
- `initialize` negotiates one of `2025-06-18`, `2025-03-26`, `2024-11-05` (falls back to the
  newest) and advertises `tools` capability; unknown methods return error `-32601`.
- `tools()` publishes 28 tools: taxonomy, search, get, create, upsert_many, update,
  bulk_update, delete, lint, trace, eval_registry, save_session, config, sync, context, the six
  changeset tools, verification, impact, scan_code, ingest_evidence, list_projects,
  create_project, init_repo. Every project-level tool gains an optional `project` argument.
  There is deliberately no project-delete tool.
- `call` resolves the store per call through `workspace::resolve`; tool failures come back as
  `isError: true` content rather than protocol errors.

### CLI (REQ-0028)

Subcommands in `cli::Cmd`: `init`, `list`, `show`, `add`, `edit`, `rm`, `bulk`, `import`,
`export`, `lint`, `trace`, `evals list|run`, `cicd`, `config`, `sync`, `taxonomy`, `serve`,
`scan`, `evidence ingest|list`, `verify`, `impact` (with `--select-tests`), `project
list|create|import|rename|default|delete`, `console`, `mcp`.

Exit codes from `cli::run` / `cli::main`:

```
0  success
1  gate failed (lint --gate, trace --gate, verify --gate), eval run not ok, sync not ok
2  error (message and details printed to stderr)
```

`bulk` refuses to run without a selection (`--ids`, `-q` or `-w`).

### Interactive console (REQ-0029)

`reqforge console` calls `console::run`, which prints an intro, shows a
`reqforge[KEY]>` prompt and feeds each line to `Console::onecmd`. `ls`/`find` record the ids
of the listing in `Console::last`; `bulk KIND _ -- f=v +list=v -list=v [--dry]` applies the
update to that last listing. `set ID f=v ...` patches a record. Assignments reuse
`cli::parse_assignments`, so value syntax matches the CLI.

## Workspace and projects

`server/src/workspace.rs` defines the `Workspace` (a directory containing
`reqforge-workspace.json`, default `~/.reqforge`) and its `Registry` of `Entry {key, name,
path, created}`. Each project is an independent git repository, by default at
`<workspace>/<KEY>/`. Keys must match `^[A-Z][A-Z0-9_-]{1,15}$` (`valid_key`).

`resolve(repo, project, workspace)` decides which store a CLI or MCP call targets:

1. explicit `--repo` path;
2. explicit project key (`-P` or `REQFORGE_PROJECT`) in the workspace;
3. `REQFORGE_REPO` or a `reqforge.json` / `.reqforge-repo` pointer found above the cwd
   (`Store::discover`);
4. the workspace default project.

`reqforge serve` runs in single-project mode (`Workspace::single`, read-only registry) when a
repo is given or discovered and no workspace is present, otherwise in workspace mode.
Project deletion (`Workspace::delete`) requires the key as confirmation and only deletes the
GitHub repo (`gh repo delete`) when `delete_remote` is set (REQ-0019).

## Persistence and runtime dependencies

`store.rs` writes one JSON file per record and commits every mutation through
`store::git::commit_all`, scoped to the repository folder (REQ-0035). `git::sync` commits,
runs `pull --rebase --autostash` and `push -u origin`. `git::create_remote` attaches a URL
directly or uses `gh repo view` / `gh repo create`; without `gh` it just adds a
`git@github.com:` remote.

| External program | Required | Used by |
|------------------|----------|---------|
| `git` | yes | `store.rs` (`git` module), `workspace.rs` `remote_url`, `codetrace.rs`, `impact.rs`, `agent.rs` (worktrees, snapshots) |
| `gh` | optional | `store.rs` `git::create_remote`, `workspace.rs` `delete` (remote deletion) |
| `claude` | optional | `chat.rs` and `agent.rs`; found via `REQFORGE_CLAUDE_BIN` or `PATH` (`chat::claude_bin`) |
| `sh` | for eval runs | `evals.rs` stage runner |
| `cargo` | plugin first run only | `bin/reqforge` builds the binary when absent or stale |

## Single binary with embedded UI (REQ-0046)

- `server/Cargo.toml`: `[features] default = ["ui"]`, `ui = ["dep:rust-embed"]`. Release
  profile strips symbols.
- `api.rs` declares `#[derive(rust_embed::RustEmbed)] #[folder = "../web/dist"] struct Assets`
  under `#[cfg(feature = "ui")]`. `static_file` serves an asset by path, falls back to
  `index.html` for extension-less paths (SPA routing), and sets immutable caching on
  `assets/*`. `REQFORGE_UI_DIR` overrides with an on-disk build for development.
- `server/build.rs` creates a placeholder `web/dist/index.html` ("UI not built") so the crate
  always compiles, and re-runs when `web/dist` changes.
- Built with `--no-default-features` (as the generated CI pipeline does, see `cicd.rs`), the
  binary has no UI and `/` returns 404 with a hint.

## Plugin packaging (REQ-0036)

```
.claude-plugin/plugin.json        name "reqforge", version 0.3.0
.claude-plugin/marketplace.json   "reqforge-marketplace", plugin source "./"
.mcp.json                         reqforge -> ${CLAUDE_PLUGIN_ROOT}/bin/reqforge mcp
agents/*.md                       8 subagents (standards-researcher, requirements-analyst,
                                  mece-reviewer, requirements-classifier, delivery-planner,
                                  eval-designer, traceability-evaluator, cicd-engineer)
skills/*/SKILL.md                 cicd, elicit, evaluate, init, plan, run, ui, verify
bin/reqforge                      bash launcher
```

`bin/reqforge` runs `$REQFORGE_BIN` if set, otherwise `server/target/release/reqforge`,
rebuilding with `cargo build --release` when the binary is missing or older than
`server/src`, `server/Cargo.toml` or `web/dist`. Build output goes to stderr so stdout stays
clean for MCP. Installation uses the local marketplace (`/plugin marketplace add <path>`,
`/plugin install reqforge@reqforge-marketplace`) or `claude --plugin-dir`.

`server/tests/plugin.rs` checks the manifests and wiring (`manifest_and_mcp_wiring`) and that
every MCP tool is either allowed or denied for the chat agent
(`chat_tool_policy_names_real_mcp_tools`).

## Claude Code as the agent runtime (REQ-0047)

Two server features need an LLM; both shell out to Claude Code:

- **Chat** (`chat.rs`, REQ-0015, REQ-0041): `ChatRunner::command_args` builds
  `claude -p --output-format stream-json --verbose --append-system-prompt <chat_prompt.md>
  --allowedTools <read tools> --disallowedTools <write tools> [--plugin-dir] [--add-dir per
  component] [--model $REQFORGE_CHAT_MODEL] [--resume <session>]`. `stream` spawns it in the
  project root with `REQFORGE_REPO` set (and `REQFORGE_PROJECT` removed) so the agent's MCP
  calls hit the same project, writes the prompt to stdin and translates stream-json into UI
  events (`translate`). Write tools (`create`, `update`, `delete`, `bulk_update`,
  `upsert_many`, `apply_changeset`, `Bash`, `Write`, `Edit`, ...) are denied; the agent can only
  simulate and propose changesets.
- **Coding agent** (`agent.rs`, REQ-0051, REQ-0052): `AgentRunner::run` prepares a worktree on
  branch `reqforge/TASK-NNNN` under `~/.reqforge/worktrees` (`worktrees_root`), then spawns
  `claude -p ... --permission-mode acceptEdits` with its own allow/deny lists (no reqforge
  write tools, no `git push`/`checkout`/`reset`, no web access), and snapshots git state
  before and after to detect violations.

`chat::plugin_root` finds the plugin directory from `REQFORGE_PLUGIN_DIR`, the executable's
ancestors, or the source tree. If `claude` is not found, the UI receives an error event and
`GET /api/chat/status` reports `available: false`. The crate has no HTTP client dependency
and no model API endpoint appears in `server/src`.

## Open questions and gaps

- REQ-0046 says only git (plus optional gh and claude) is needed at run time. In practice the
  plugin launcher `bin/reqforge` needs a Rust toolchain (`cargo`) on first use unless
  `REQFORGE_BIN` points at a prebuilt binary; no prebuilt release artefact is shipped. Eval runs
  also require `sh`.
- REQ-0046 AC1 assumes the default build embeds the real UI, but `build.rs` silently embeds a
  placeholder page when `web/dist` was not built first. The repository CI (`test.yml`) builds
  the server without building the web UI, so the binary it produces has only the placeholder.
- REQ-0026 says "every capability" is exposed over REST. `evals run` and `cicd` generation are
  CLI-only, `init_repo` is CLI/MCP-only; there is no REST equivalent.
- REQ-0027: malformed JSON lines are silently skipped instead of returning a JSON-RPC `-32700`
  parse error, and JSON-RPC batch arrays are not supported. The MCP `kind` enum lists four
  kinds and omits `components`, although `model::KINDS` has five.
- REQ-0036 AC2 is met by tests rather than by construction: the allow/deny lists in `chat.rs`
  and `agent.rs` are hand-maintained, and only `server/tests/plugin.rs` and
  `server/tests/agent_sandbox.rs` catch a new MCP tool that was added to neither list.
