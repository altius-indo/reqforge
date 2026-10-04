---
title: Agents and security
realises:
  - REQ-0015
  - REQ-0040
  - REQ-0041
  - REQ-0047
  - REQ-0051
  - REQ-0052
---

# Agents and security

## Purpose

reqforge runs two kinds of Claude Code agent from its local web server. The **chat agent**
helps a product owner review requirements. It may read, simulate and propose changesets, but
it may not write. The **coding agent** implements one planned task in a git worktree of the
story's component. Both are headless runs of the locally installed `claude` CLI. reqforge does
not call a model API itself. This document explains how both bridges are built and what
bounds each agent. It also covers how the local HTTP server that starts the agents is protected
against cross-site and DNS-rebinding attacks. Everything below was checked against the code in
`server/src`. Section 7 lists controls that are missing or only partly in place.

## Realised requirements

| Id | Title | How / where realised |
|----|-------|----------------------|
| REQ-0015 | Chat bridge to Claude Code | `ChatRunner::stream` in `server/src/chat.rs` spawns `claude -p --output-format stream-json`. `translate` maps its stream to `session`, `tool`, `text`, `changeset`, `warning`, `done` events, and `chat_sse` in `server/src/api.rs` sends them as SSE. `ChatRunner::command_args` adds `--resume <session_id>` |
| REQ-0040 | Local server hardening | `same_origin` and `authorized` in `server/src/api.rs`, called first in `dispatch` for every `/api/*` route, including chat and agent SSE. AC3 (path validation) is not implemented, see TASK-0037 |
| REQ-0041 | Chat agent cannot write directly | `allowed()` / `denied()` in `server/src/chat.rs` are passed as `--allowedTools` / `--disallowedTools`. AC2 and AC3 (server-side project pinning and deny list) are open, see TASK-0036 |
| REQ-0047 | Claude Code as the agent runtime | `claude_bin`, `plugin_root` in `server/src/chat.rs`. Both runners start the CLI with `--plugin-dir`. No HTTP model client exists in the server |
| REQ-0051 | Start task with coding agent | `plan`, `resolve`, `brief`, `prepare_worktree`, `AgentRunner::run` in `server/src/agent.rs`, `readiness` in `server/src/taskflow.rs`, `agent_sse` in `server/src/api.rs` |
| REQ-0052 | Coding agent sandbox | `allowed_tools`, `denied_tools`, `command_args`, `snapshot`, `violations`, and the run log in `AgentRunner::run` (`server/src/agent.rs`) |

## 1. Agent runtime (REQ-0047)

- `claude_bin()` uses `REQFORGE_CLAUDE_BIN` if it is set. Otherwise it takes the first `claude` file on `PATH`. If none is found, the turn or run ends with an `error` event telling the user to install Claude Code. `GET /api/chat/status` reports whether the CLI is available.
- `plugin_root()` finds the reqforge plugin from `REQFORGE_PLUGIN_DIR`, from an ancestor of the executable that has `.claude-plugin/`, or from the crate's parent directory. It is passed as `--plugin-dir`, so the agent reaches the requirements store only through the plugin's `reqforge` MCP server (`server/src/mcp.rs`).
- `REQFORGE_CHAT_MODEL` and `REQFORGE_AGENT_MODEL` can set `--model`. Otherwise the CLI default is used.
- Each child process is started with `kill_on_drop(true)`, piped stdin/stdout/stderr, and the prompt (chat) or brief (agent) written to stdin.

## 2. Chat bridge (REQ-0015, REQ-0041)

### 2.1 Process and arguments

`ChatRunner::command_args(session_id)` builds:

```
claude -p --output-format stream-json --verbose
       --append-system-prompt <chat_prompt.md>
       --allowedTools  <allowed()>  --disallowedTools <denied()>
       [--plugin-dir <plugin>] [--add-dir <component>]... [--model M]
       [--resume <session_id>]
```

- The working directory is the project's requirements repo (`ChatRunner.root`). The child gets `REQFORGE_REPO=<root>` and has `REQFORGE_PROJECT` removed, so by default its MCP calls resolve to this project (`workspace::resolve`, step 3).
- Each configured component path that exists is canonicalised in `ChatRunner::new` and passed with `--add-dir`, so the agent can Read/Grep/Glob code to assess impact.
- `context_preamble` puts a `[UI context]` block (current view filters and selected record ids) in front of the user message.

### 2.2 Tool policy

| List | Contents (`server/src/chat.rs`) |
|------|----------------------------------|
| `READ_TOOLS` (allowed, MCP) | taxonomy, search, get, context, lint, trace, eval_registry, simulate_changeset, propose_changeset, get_changeset, list_changesets, save_session, verification, impact, list_projects |
| Allowed built-ins | Read, Grep, Glob, WebSearch, WebFetch, Agent, Task, TodoWrite |
| `WRITE_TOOLS` (denied, MCP) | create, update, delete, bulk_update, upsert_many, apply_changeset, reject_changeset, config, sync, init_repo, scan_code, ingest_evidence, create_project |
| Denied built-ins | Bash, Write, Edit, NotebookEdit |

`chat_prompt.md` tells the agent to follow a review, simulate, propose loop and never to claim
that a change is applied. A changeset is applied only through the UI's Apply action, which is a
REST route outside the agent's reach. The `changeset` UI event is produced in `translate` only
when the tool result belongs to a `propose_changeset` call.

### 2.3 Stream translation and SSE

`translate(msg, tool_names)` handles these stream-json message types:

| stream-json message | UI event |
|---------------------|----------|
| `system/init` | `session {session_id}`, plus `warning` if the reqforge MCP server is not `connected` |
| `assistant` text (top level only, not sub-agent) | `text` |
| `assistant` tool_use | `tool {name, sub, text}`. The tool id is recorded in `tool_names` |
| `user` tool_result of `propose_changeset` | `changeset {id}` (parsed from `changeset_id`) |
| `result` | `done {session_id, cost, turns, is_error, result}` |

`chat_sse` in `server/src/api.rs` reads `chat_id`, `message`, `session_id` and `context` from
the JSON body. It starts `stream` on a task and sends each event as `data: <json>\n\n` over a
64-slot channel with `Content-Type: text/event-stream`.

### 2.4 Session resume and cancellation

- The browser keeps the `session_id` from the `session` / `done` events and sends it back on the next turn. `command_args` then adds `--resume <id>`. There is one `ChatRunner` per project (`AppState::chat`), and conversations are told apart by `chat_id`.
- `ChatRunner.cancels` maps `chat_id` to a `Notify`. `POST /api/chat/cancel` triggers it. The loop then kills the child and sends `error: cancelled`. If the SSE client disconnects, the next send fails and the child is killed too. When a project is deleted, `cancel_all` stops every turn.
- If the process exits non-zero without a `result` message, the last 1500 characters of stderr are sent as an `error`.

### 2.5 Chat turn sequence

```
Browser            api.rs dispatch        ChatRunner::stream          claude -p            reqforge MCP
   |  POST /api/chat  |                         |                         |                      |
   |----------------->| same_origin, authorized |                         |                      |
   |                  | chat_sse -> spawn ----->| command_args(+--resume) |                      |
   |                  |                         | spawn(cwd=req repo,     |                      |
   |                  |                         |   REQFORGE_REPO=root) ->|                      |
   |                  |                         | stdin: preamble+message |                      |
   |                  |                         |<-- system/init ---------|-- start plugin MCP ->|
   |<== data: session ========================  |                         |                      |
   |                  |                         |<-- tool_use search -----|-- search ----------->|
   |<== data: tool =====================================                  |<---------------------|
   |                  |                         |<-- tool_use propose ----|-- propose_changeset->|
   |                  |                         |<-- tool_result id ------|<-- changeset_id -----|
   |<== data: changeset ================================                  |                      |
   |<== data: text / done (session_id) =================                  | exit                 |
   | user clicks Apply -> separate REST call (not reachable by the agent) |                      |
```

## 3. Coding agent runs (REQ-0051, REQ-0052)

### 3.1 Readiness and confirmation

- `taskflow::readiness` returns `can_start_agent` and `agent_reasons`. A run is blocked when the story has no component, the component is undefined or has no `path`, a `depends_on` task is not `done`, or the task is already `done` (REQ-0051#AC6).
- `GET /api/tasks/{id}/agent` calls `agent::plan`. It returns readiness, the component path, the worktree, the branch `reqforge/TASK-NNNN` and the full brief for the confirmation dialog (REQ-0051#AC1). `POST /api/tasks/{id}/agent` starts the run. The server does not check for a confirmation token. Confirmation happens in the UI only (see section 7).
- `AgentRunner::run` checks readiness again before doing anything.

### 3.2 Brief contents (REQ-0051#AC3)

`agent::brief` builds a Markdown document that is written to the agent's stdin. It contains:

1. The task id, title, kind, description ("What to do") and `done_when`.
2. The story id, title, narrative and story acceptance criteria.
3. The story evals (id, kind, command, covered criteria) under "Evals that must pass".
4. Each linked requirement's statement and its criteria as `REQ-NNNN#ACn`.
5. Conventions: trace tags (`implements` / `verifies`), and "work only in this directory, on the current branch ... do not push, switch branches or edit anything outside this worktree".

`agent_prompt.md` is appended as the system prompt. It repeats these rules, says requirements
are read-only, asks for commits that start with the task id, and tells the agent not to claim
the task is done.

### 3.3 Worktree and branch (REQ-0051#AC2)

- `resolve` canonicalises the component root. The branch is `branch_for(task) = reqforge/<TASK-ID>`. The worktree is `worktrees_root()/<project key>/<TASK-ID>`, where `worktrees_root()` is `REQFORGE_WORKTREES` or `~/.reqforge/worktrees`.
- `prepare_worktree` requires the component to be a git checkout. If the worktree already exists it must be on the task branch, otherwise the run fails. If not, it runs `git worktree add` with the existing branch, or with `-b <branch>` from the current `HEAD`. It returns the base commit (`merge-base` when the branch already exists).
- If the task is `todo`, `taskflow::start` moves it to `in-progress`. Nothing ever sets it to `done` (REQ-0051#AC5).

### 3.4 Permissions

`agent::command_args`:

```
claude -p --output-format stream-json --verbose
       --append-system-prompt <agent_prompt.md>
       --permission-mode acceptEdits
       --allowedTools <allowed_tools()> --disallowedTools <denied_tools()>
       [--plugin-dir <plugin>] [--model M]
```

| Category | Allowed | Denied |
|----------|---------|--------|
| File tools | Read, Edit, MultiEdit, Write, Glob, Grep, TodoWrite | NotebookEdit |
| Bash prefixes | cargo, npm, npx, node, python3, pytest, go, make, git status/diff/log/show/add/commit | git push, git checkout, git switch, git reset, git rebase, git merge, git worktree, rm -rf, curl, wget |
| reqforge MCP | taxonomy, search, get, context, verification, eval_registry, lint, trace, impact, list_projects, get_changeset, list_changesets | create, update, delete, bulk_update, upsert_many, propose/apply/reject/simulate_changeset, config, sync, init_repo, scan_code, ingest_evidence, create_project, save_session |
| Network | none | WebFetch, WebSearch |

The process runs with `current_dir = worktree`, `REQFORGE_REPO=<requirements root>`,
`REQFORGE_TASK=<id>`, and `REQFORGE_PROJECT` removed. It runs in its own process group
(`process_group(0)`). On cancel, `kill -TERM -<pgid>` stops the agent and every child it started
(REQ-0051#AC4).

### 3.5 Detecting escapes (REQ-0052#AC1, AC2)

Nothing at the OS level stops writes. Containment relies on the CLI permission rules above,
followed by a before/after check:

- Before the run, `snapshot` records the `HEAD` of the component's main checkout, `git status --porcelain` of that checkout (leaving out the requirements folder if it is inside), and `git status --porcelain` of the requirements repo. The task worktree is a separate directory, so its edits do not appear in the main checkout's status.
- After the run, `violations` compares the two snapshots. It reports "checked-out branch moved", "files changed in the component checkout outside the task worktree" and "files changed in the requirements repository". These go into the run log and the `result` event. Nothing is reverted automatically. A human reviews the result.
- `commits_since(worktree, base)` lists the commits the run made on the task branch.

### 3.6 Run log (REQ-0052#AC4) and progress

When a run finishes, `AgentRunner::run` writes `agent-runs/RUN-<task>-<timestamp>.json` to the
requirements repo under the store lock and commits it. The log records run_id, task, story,
component, branch, worktree, base, user, started, ended, exit_status (exit code, `cancelled` or
`killed`), commits, violations and the last 200 events. For queued runs, `user` is
`"<changed_by> (queue)"`, which is how the log shows that a run was queued. Manual runs record
`$USER`. `GET /api/tasks/{id}/runs` lists the logs without their events. Live progress is
buffered per task (the newest 500 events) and polled through `GET .../agent/live?since=n`.
Changeset events are dropped from the agent stream.

### 3.7 Queue and concurrency

- `AgentRunner.cancels` allows one run per task. A second start gets `an agent is already running`. The `Reservation` guard frees the slot however the run ends.
- `queue::set` needs `confirm: true` to turn the queue on or off and accepts a limit from 1 to 8 (default 2). It stores `changed_by` and `changed_at` in the config. That user is recorded as the authoriser of queued runs (REQ-0051#AC1).
- `spawn_scheduler` calls `queue::tick` every `REQFORGE_QUEUE_TICK_MS`, 5000 by default. It starts at most `limit - running_tasks()` eligible tasks, using `reserve` to avoid double starts. Eligible means: a `todo` task, every story requirement `approved`, dependencies done, a component with a path, and no earlier run (failed runs are never retried).
- Manual runs count toward the queue's limit but are not capped by it. There is no global cap across projects.

### 3.8 Agent run sequence

```
UI drawer           api.rs                    AgentRunner::run                 git / claude
  | GET .../agent     |                              |                              |
  |------------------>| agent::plan (readiness,      |                              |
  |<-- plan + brief --|   path, branch, brief)       |                              |
  | user confirms     |                              |                              |
  | POST .../agent    | same_origin, authorized      |                              |
  |------------------>| agent_sse -> spawn --------->| reserve slot (cancels)       |
  |                   |                              | readiness again, claude_bin  |
  |                   |                              | prepare_worktree ----------->| worktree add -b reqforge/TASK-N
  |                   |                              | taskflow::start (todo->ip)   |
  |                   |                              | before = snapshot()          |
  |<== data: run =====================================                              |
  |                   |                              | spawn claude (cwd=worktree,  |
  |                   |                              |   own pgid), stdin=brief --->| edits, tests, git commit
  |<== data: tool/text (also live buffer) ============|<-- stream-json -------------|
  |  [cancel] POST .../agent/cancel -> notify ------->| kill -TERM -pgid            |
  |                   |                              | after = snapshot(); violations|
  |                   |                              | commits_since(base)          |
  |                   |                              | write+commit agent-runs/RUN-*|
  |<== data: result {exit_status, branch, commits, violations, task_status} ======   |
```

## 4. Local server hardening (REQ-0040)

`dispatch` serves non-`/api` GETs as static UI files. For every `/api/*` request, including
`POST /api/chat`, `POST /api/tasks/{id}/agent` and `/api/projects/*`, it runs two checks in
order:

1. `same_origin(headers, method, body_len, token)`. Failure returns **403** `cross-origin or non-JSON request refused`.
   - **Loopback Host.** If no token is set, the Host name must be `localhost`, `127.0.0.1`, `[::1]` or end with `.localhost`. This blocks DNS rebinding.
   - **Origin.** If an `Origin` header is present, its host:port must equal `Host`.
   - **Content type.** For POST/PATCH/PUT/DELETE with a non-empty body, the type must be `application/json` or `text/csv`. Neither is a CORS "simple" type, so a cross-site page needs a preflight, and the server never answers one.
2. `authorized(headers, token)`. If `REQFORGE_TOKEN` is set, the request needs `Authorization: Bearer <token>`. The check compares lengths and then uses `subtle::ConstantTimeEq`. Failure returns **401**.

The server binds to `127.0.0.1` by default (`server/src/cli.rs`, `--host`).

## 5. Threat / control table

| # | Threat | Control | Code location |
|---|--------|---------|---------------|
| T1 | Chat agent writes records without user approval | MCP write tools and Bash/Write/Edit/NotebookEdit are disallowed. Only propose is possible, and Apply is a user REST action | `chat::allowed`, `chat::denied`, `ChatRunner::command_args` |
| T2 | Chat agent acts on another project | `REQFORGE_REPO` is pinned and `REQFORGE_PROJECT` removed. An explicit `project` argument is still accepted (gap) | `ChatRunner::stream`, `workspace::resolve` |
| T3 | Client-side deny list bypassed | None in the MCP server today (gap, TASK-0036) | `mcp::call` |
| T4 | Coding agent commits to the default branch or pushes | Branch-switching and push git commands are denied. The agent works in its own worktree on `reqforge/TASK-N`. A `HEAD` change in the main checkout is flagged | `agent::denied_tools`, `prepare_worktree`, `snapshot`, `violations` |
| T5 | Coding agent writes outside its worktree | cwd is the worktree and the prompt and brief forbid it. Main checkout and requirements repo are checked with git status before and after (detection only) | `AgentRunner::run`, `snapshot`, `violations` |
| T6 | Coding agent changes requirements | MCP write and changeset tools are denied, and requirements-repo status is checked | `agent::WRITE_TOOLS`, `violations` |
| T7 | Data exfiltration by the coding agent | WebFetch, WebSearch, curl and wget are denied | `agent::denied_tools` |
| T8 | Runaway or orphaned agent processes | Own process group with group kill on cancel. `kill_on_drop`. One run per task. Queue limit 1 to 8 | `AgentRunner::run`, `Reservation`, `queue::tick` |
| T9 | Unattended mass runs | The queue needs `confirm` to toggle, records `changed_by`, and never retries | `queue::set`, `queue::eligible` |
| T10 | Agent marks its own work done | The server never sets `done`. The prompt forbids claiming done | `AgentRunner::run`, `agent_prompt.md` |
| T11 | Cross-site request (CSRF) starts runs or writes | Origin must equal Host. JSON or CSV content type is required for bodies | `api::same_origin` |
| T12 | DNS rebinding | Loopback Host is required when no token is set | `api::same_origin` |
| T13 | Remote / unauthenticated access | Optional bearer token on all `/api/*` routes, compared in constant time. Default bind is 127.0.0.1 | `api::authorized`, `cli.rs` |
| T14 | Unaudited agent activity | A run log is committed to `agent-runs/` for every run | `AgentRunner::run` |
| T15 | Client-chosen filesystem paths read | None (gap, TASK-0037) | `api::projects_route` (`import`), `api::route` (`code/scan`, `impact`) |

## 6. Configuration surface

| Variable | Effect |
|----------|--------|
| `REQFORGE_TOKEN` | Turns on bearer auth and turns off the loopback-Host requirement |
| `REQFORGE_CLAUDE_BIN`, `REQFORGE_PLUGIN_DIR` | CLI binary and plugin location |
| `REQFORGE_CHAT_MODEL`, `REQFORGE_AGENT_MODEL` | `--model` overrides |
| `REQFORGE_WORKTREES` | Root for task worktrees (default `~/.reqforge/worktrees`) |
| `REQFORGE_QUEUE_TICK_MS` | Scheduler interval (default 5000) |

## 7. Open questions and gaps

Confirmed by reading the code:

1. **Project pinning and server-side deny list (TASK-0036, REQ-0041#AC2, AC3).** `mcp::tools` adds an optional `project` argument to every tool. `mcp::call` passes it to `workspace::resolve`, where an explicit key takes precedence over `REQFORGE_REPO`. So a chat or coding agent can read, or propose into, another workspace project. The MCP server has no role or deny list. The write-tool restrictions for both agents are enforced only by the CLI's `--disallowedTools`.
2. **Path validation (TASK-0037, REQ-0040#AC3).** `POST /api/projects/import {path}`, `POST /api/code/scan {root}` and `GET /api/impact?root=` take client paths without canonicalising or checking them. The chat agent's allowed `impact` MCP tool also accepts a `root` argument.
3. **Containment of the coding agent is policy plus detection, not a sandbox (REQ-0052#AC1, AC2).** Allowed Bash prefixes such as `node`, `npx`, `python3`, `make` and `cargo` can run arbitrary code, including network access and file writes anywhere the user can write. `snapshot` only sees the component's main checkout and the requirements repo. Writes elsewhere (home directory, other repos) are not detected. Violations are recorded but not reverted. The `HEAD` check covers whatever branch the main checkout has checked out, which may not be the default branch. Other refs, such as `git -C <top> branch -f main`, are not compared.
4. **Confirmation is enforced only by the UI (REQ-0051#AC1).** `POST /api/tasks/{id}/agent` starts a run with no confirmation flag. Anyone who passes `same_origin` and `authorized` can start one.
5. **Run log `queued` field (REQ-0052#AC4).** Whether a run was queued is shown only by the `" (queue)"` suffix on `user`. There is no separate boolean. Manual runs record the server's `$USER`, not an authenticated identity.
6. **Chat tool list.** `save_session` is in the chat's allowed list and writes a session file to the requirements repo. It does not change records, but it is still a write. Chat also allows WebFetch, Agent and Task. Sub-agents inherit the same CLI policy. WebFetch is a possible prompt-injection and exfiltration channel.
7. **Content-type rule skips empty bodies.** Bodiless POSTs (for example agent start and cancel) skip the content-type rule and rely on the Origin check. A request without an `Origin` header (non-browser client) passes when no token is set.
8. **Concurrency.** Only queued runs are limited (`limit` 1 to 8, per project). Manual agent runs and chat turns have no global cap.
