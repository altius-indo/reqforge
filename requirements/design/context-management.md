---
title: Context management
realises:
  - REQ-0057
  - REQ-0058
  - REQ-0059
---

# Context management design

Design for STORY-0017 (REQ-0057 project snapshot, REQ-0058 snapshot in agent context) and the parts of REQ-0059 (next action per task) that shape session context: AC3 (shown first) and AC4 (when the chat agent is asked for next actions). TASK-0041. REQ-0059 AC1-AC2 (the field and the `NEXT:` proposal) are designed with their own tasks; this document only assumes them.

The snapshot is a short, human-approved statement of where the project is: what is happening now, the one next thing, and what to watch. Every chat and coding-agent session starts from it, and gets it back after Claude Code compacts the conversation. The task's next action is the per-task counterpart: the one concrete cue for resuming that task.

## Context layout

Every session that is about a task gets three blocks, in this order:

1. **Task next action** (REQ-0059#AC3): the task's `next_action` and the date it was set.
2. **Task section**: the task's title, kind, description and done-when.
3. **Project snapshot** (REQ-0058#AC1, AC2): the full text of `state/HOT.md`, marked as project state.

A session that is not about a task (most chat sessions) gets only block 3. The rest of the context (story, requirements, conventions for the agent; UI context and the user's message for chat) follows these blocks.

Everything that injects the snapshot calls `snapshot::context_block(content)`, so the text is identical everywhere:

```
<project-state source="state/HOT.md" last-reconciled="YYYY-MM-DD">
<file content, verbatim, unmodified>
</project-state>
```

The tag says the content is project state and carries the content itself, not a pointer to the file. Validation forbids the markers inside the content, so the block cannot be broken out of.

The next action is rendered by `taskflow::next_action_block(task) -> Option<String>`:

```
## Next action (set YYYY-MM-DD)
<next_action text>
```

It returns `None` when the task has no `next_action`. It assumes the REQ-0059#AC1 data model: `next_action` (string, at most 280 characters) and `next_action_set` (date), both written together.

## REQ-0057: the snapshot file

### REQ-0057#AC1: format

- Path: `<requirements root>/state/HOT.md`, i.e. `store.root.join("state/HOT.md")`. There is one per project, because each project has its own requirements root. It is committed with the requirements.
- Format:

  ```markdown
  # <anything, optional>

  ## Now
  <free text and lists>

  ## Next
  - <exactly one item>

  ## Watch
  <free text and lists>

  Last reconciled: 2026-10-04
  ```

- Rules, checked by `snapshot::validate(content) -> Vec<String>` (empty = valid):
  1. **Size.** At most 8,192 bytes (`content.len()`, UTF-8 bytes, as stored).
  2. **Headings.** The level-2 headings `## Now`, `## Next` and `## Watch` each appear exactly once, in that order. Other `##` headings are allowed between or after them; they end the preceding section.
  3. **Next.** The Next section holds exactly 1 item. An item is a line starting at column 0 with `- `, `* ` or `<n>. `. Indented lines and continuation text belong to that item. 0 items or 2+ items is an error.
  4. **Date.** Exactly one line matches `^Last reconciled: (\d{4}-\d{2}-\d{2})$`, and it parses as a real date (`chrono::NaiveDate`). It may sit anywhere, but by convention it goes last.
  5. **Markers.** The content must not contain `<project-state` or `</project-state>`, the delimiters used when it is injected.

  Error strings name the rule, e.g. `snapshot: 9,310 bytes, limit is 8,192`, `snapshot: missing heading '## Watch'`, `snapshot: headings out of order (expected Now, Next, Watch)`, `snapshot: Next has 2 items, must have exactly 1`.
- All snapshot code lives in a new module `server/src/snapshot.rs`, which owns the path constant `pub const PATH: &str = "state/HOT.md"`. It contains `read(root) -> Option<String>`, `validate`, `last_reconciled(content) -> Option<NaiveDate>`, `line_diff(old, new)`, `context_block(content)`, `write_unlocked(root, content)`, `today()` and `hook_output(root)`.

### REQ-0057#AC2: the snapshot changeset op

#### Op shape

```json
{"op": "snapshot", "content": "<full new HOT.md>", "reason": "…"}
```

- The op always carries the full content, never a patch, so what the reviewer sees is exactly what gets written.
- A changeset may hold at most one snapshot op. A second one is a validation error.
- A changeset may mix it with record ops (for example, task `next_action` updates, see REQ-0059#AC4 below). They are applied and committed together.
- The `changes.rs` module doc gains the new op, and `unknown op` errors list it among the expected ops.

#### Materialize and simulate

- `View` gains `snapshot: Option<String>`. `base_view` fills it from `snapshot::read(store.root)`.
- `materialize` handles `"snapshot"`:
  - it requires `content` to be a string;
  - it runs `snapshot::validate` and pushes each message to `errors` as `op {i} (snapshot): …`, which makes `valid: false` (REQ-0057#AC3);
  - it sets `view.snapshot = Some(content)`.
- The resolved op is:

  ```json
  {"i": i, "op": "snapshot", "kind": "snapshot", "id": "state/HOT.md", "reason": …,
   "bytes": n, "last_reconciled": "YYYY-MM-DD"|null,
   "diff": [{"t": " "|"+"|"-", "line": "…"}, …],
   "base_version": "<sha256 of current file>"|"absent"}
  ```

  `diff` is `snapshot::line_diff(old, new)`, a plain LCS line diff. Both sides are at most 8 KiB, and the old one is treated as empty when absent. The server computes it so the card only renders. `simulate` passes it through unchanged. `touched` and `blast_radius` ignore it, because it links to no record.
- `Source` gains `fn snapshot(&self) -> Option<String> { None }`, which `Store` and `View` implement. This lets lint see the post-change snapshot during simulate.

#### Propose and Apply

- **Propose.** `base_versions["state/HOT.md"]` is the op's `base_version`.
- **Apply.**
  - Under the store lock, the staleness loop special-cases `state/HOT.md`: it compares the sha256 (`sha2`, already a dependency) of the current file, or `"absent"`, with the recorded value. A mismatch makes the changeset `stale` like any record change.
  - If the snapshot op is not excluded, `materialize` re-validates it. Apply then writes `view.snapshot` with `snapshot::write_unlocked`, which creates `state/` and uses a temp file plus rename, like `Store::write_unlocked`.
  - This happens before the single `store.commit("CS-NNNN: apply — …")`, so the file and the records land in one commit. `written` includes `"state/HOT.md"`.
- **Excluding the op.** Excluding it via `exclude` skips the write, as for any op.

#### Only path that writes the file

`snapshot::write_unlocked` is `pub(crate)` and its only caller is `changes::apply`. No other path writes the file:
- **REST:** `GET /api/p/{K}/snapshot` is read-only, and there is no PUT or POST.
- **MCP:** there is no snapshot write tool. `get`, `search` and the rest are record-only.
- **CLI:** `reqforge snapshot` only prints.
- **Store and CSV import:** they never write under `state/`, since `Store::path` maps only record kinds.
- **Chat:** chat denies `Write`, `Edit` and `Bash`.
- **Coding agent:** the agent runs in a worktree, and any change to the requirements repo is recorded as a sandbox violation (REQ-0052).
- **Compaction hook:** it only reads.

A test asserts this structurally: writes of `"state/HOT.md"` or `snapshot::PATH` appear only in `snapshot.rs` and the apply branch of `changes.rs` ("0 other paths").

#### Changeset card (web)

- `ChangesetCard.tsx` renders `op === "snapshot"` as a row labelled `snapshot` with the id `state/HOT.md`, the byte count and the Last reconciled date.
- Below that row it shows the diff as a monospace block (`data-testid="cs-snapshot-diff"`):
  - `+` lines are green and `-` lines red;
  - unchanged runs longer than 6 lines collapse to `…`, which can be expanded.
- Validation errors show in the existing errors list. Apply and Reject behave as for any changeset.

### REQ-0057#AC3: simulate errors

`simulate` reports `valid: false` with the `snapshot::validate` messages for each of: content over 8,192 bytes, a missing or out-of-order `## Now`/`## Next`/`## Watch` heading, and a Next section with 0 or 2+ items. `propose` stores the changeset with its errors, as for any invalid changeset, and `apply` refuses it because `materialize` re-validates.

### REQ-0057#AC4: lint

- `lint::lint` reads `src.snapshot()`.
- If the snapshot exists and `today - last_reconciled > 21 days`, it adds:

  ```json
  {"severity": "warning", "rule": "snapshot-stale", "ids": [], "message": "state/HOT.md last reconciled YYYY-MM-DD (N days ago, limit 21)"}
  ```

  `today` is `snapshot::today()`: `chrono::Local::now().date_naive()`, overridable in tests with `REQFORGE_TODAY=YYYY-MM-DD`, which nothing else reads.
- A missing snapshot gives no finding: REQ-0058#AC4 treats it as a normal state.
- An existing file that fails `validate` (hand-edited outside reqforge) gets one `warning` with `rule: "snapshot-invalid"` and the first error.
- Because simulate diffs lint before and after, a changeset that refreshes the date shows `snapshot-stale` as resolved.

## REQ-0058: the snapshot in agent context

### REQ-0058#AC1: chat, first turn

- In `ChatRunner::stream`, when `session_id` is `None` (the first turn of a session), the prompt becomes:

  ```
  [next action block + "\n\n" + task section + "\n\n"]   (only when the chat is about a task)
  snapshot block + "\n\n"
  context_preamble + message
  ```

  The chat is about a task when the UI context names exactly one task: `view.tab == "tasks"` with a single selected id, or an open task drawer (`view.task`). The task section is `agent::task_section(task)`, the same function the brief uses (title, kind, What to do, Done when).
- The blocks go into the first user turn, not `--append-system-prompt`. The system prompt then stays static and cacheable, and the session history records which snapshot it started from. (The compaction fallback below may add a second copy to the system prompt; the first-turn copy stays either way.)
- Resumed turns (`--resume`) don't repeat it. It is already in the conversation, and compaction is covered below.
- No file means no snapshot block (REQ-0058#AC4).
- `chat_prompt.md` gains a "Project state" section:
  - the `<project-state>` block is the approved snapshot; use it as the starting point and verify details with the tools;
  - to change it, propose a changeset with one `{"op":"snapshot","content":…}` op holding the full new file in the format above. Keep it under 8 KiB with exactly one Next item, and set `Last reconciled` to today;
  - never write `state/HOT.md` directly;
  - when asked to draft one, build it from `search`/`context`/`trace`, in-progress tasks and recent changesets, simulate it, then propose it.

### REQ-0058#AC2: coding-agent brief

`agent::brief` is split so its first part is `task_section(task)` and becomes:

```
# Task TASK-NNNN: <title>

## Next action (set YYYY-MM-DD)        <- only when next_action is set (REQ-0059#AC3)
<next_action>

Kind: <kind>

## What to do
…

## Done when
…

## Project snapshot
<project-state …>…</project-state>

## Story STORY-NNNN: …
…
```

- The snapshot section comes right after the task section (after `## Done when`, before `## Story`).
- With no file, the section reads `(none: this project has no state/HOT.md yet)`, and the run starts normally (REQ-0058#AC4).
- `agent_prompt.md` gains one line: the brief's `<project-state>` block is read-only project context; don't edit `state/HOT.md`.

### REQ-0058#AC3: after compaction

#### Primary: plugin SessionStart hook

New file `hooks/hooks.json` at the plugin root (Claude Code loads plugin hooks from there):

```json
{"hooks": {"SessionStart": [{"matcher": "compact",
  "hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/reqforge snapshot --hook", "timeout": 10}]}]}}
```

- Claude Code runs `SessionStart` hooks with `source: "compact"` after it compacts a session, whether automatically or by `/compact`, and adds the hook's `additionalContext` to the context before the next model turn.
- Chat (`ChatRunner::command_args`) and agent runs (`agent::command_args`) both pass `--plugin-dir <plugin root>`, so both load the hook.
- The `startup` and `resume` sources are deliberately not matched. Startup is covered by the first turn and the brief; every chat turn after the first is a `resume`, and matching it would inject the snapshot on every turn.
- `reqforge snapshot --hook` (in `cli.rs`):
  1. It reads and ignores the hook JSON on stdin.
  2. It resolves the requirements root from `REQFORGE_REPO` only. `ChatRunner::mcp_env` and the agent runner already set it to the session's project. If it is unset, the command exits 0 with no output, so the plugin installed in an unrelated interactive session does nothing.
  3. If `state/HOT.md` exists, it prints `snapshot::hook_output(root)`:

     ```json
     {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<context_block(content)>"}}
     ```

     For an agent run it also prepends the task's next action block (the runner sets `REQFORGE_TASK`), so the agent gets back the same cue it started with.
  4. If the file doesn't exist, it prints nothing.
  5. It always exits 0, so a hook failure never blocks a session.
- The hook re-reads the file at compaction time, so a snapshot applied mid-session reaches the agent at the next compaction.
- `reqforge snapshot` without `--hook` prints the file content to stdout, or exits 1 with `no project snapshot`. It resolves the project the usual way.

#### Verification in headless mode

Both session shapes reqforge uses are headless and differ from the interactive case the hook is documented for:

- **chat:** one `claude -p` process per user turn, joined by `--resume <session_id>`. Compaction may happen inside any turn's process.
- **agent run:** one long `claude -p` process; compaction happens automatically mid-run, with no further user turn.

`scripts/check-compact-hook.sh` checks both. It builds a throwaway plugin whose only hook is SessionStart/`compact` and returns a nonce as `additionalContext`, then:

- chat: turn 1 `Reply OK.`, turn 2 `/compact` (`--resume`), turn 3 asks for the codeword (`--resume`);
- agent: one process with `--input-format stream-json` fed the same three user messages;

and passes a case only if the hook log shows `source: "compact"` and the final answer contains the nonce.

#### Test result

| date | Claude Code | chat (`-p --resume`) | agent run (single `-p`) |
|---|---|---|---|
| 2026-10-04 | 2.1.289 | **PASS** (hook fired 1x, codeword in the next turn) | **PASS** (hook fired 1x, codeword in the next turn) |

Run on a developer machine with `scripts/check-compact-hook.sh` (model haiku): the SessionStart `compact` hook fires in both headless shapes and its additional context reaches the next turn, so `hook` is the default. Re-run the check when the supported Claude Code version changes and add a row; if either case fails, switch the default back to `system`.

#### Fallback: re-supply every turn

If the hook does not fire (or does not reach the next model turn) in either shape, the snapshot goes into the system prompt as well, which Claude Code sends with every model request and never summarises:

- **chat:** `ChatRunner::command_args` appends `"\n\n" + context_block(current file)` to the `--append-system-prompt` value on **every** turn, first and resumed. Because each turn is a new process, a snapshot applied mid-session reaches the next turn. The cost is at most 8 KiB per request, and the system prompt stays cacheable until the snapshot changes.
- **agent run:** `agent::command_args` appends the same block (plus the next action block) to `--append-system-prompt`. It is read once at process start, which matches the brief.

The switch is `REQFORGE_SNAPSHOT_RESUPPLY` = `hook` (default) or `system`:
- `system` adds the system-prompt copy; the hook still runs and its copy is harmless duplication.
- `hook` relies on the hook alone. It is the default because the check passed for both shapes on Claude Code 2.1.289 (test result above).

The first-turn and brief copies (REQ-0058#AC1, AC2) are unaffected by the switch.

### REQ-0058#AC4: no snapshot

- `GET /api/p/{K}/snapshot` returns one of:
  - `{exists: false}`;
  - `{exists: true, content, bytes, last_reconciled, age_days, stale, errors}`, where `errors` is the output of `snapshot::validate`.
- With no file, chat starts without the snapshot block, the brief says `(none: …)`, the hook prints nothing and the fallback adds nothing. No session fails because the file is missing.
- `ChatPanel.tsx` loads it with the project, refetching after any changeset is applied. When `exists` is false it shows a banner above the input (`data-testid="snapshot-missing"`):
  - the text "No project snapshot";
  - a button "Ask Claude to draft one" (`data-testid="snapshot-draft"`), which sends this chat message: "Draft a project snapshot (state/HOT.md) from the current requirements, stories, tasks and recent changesets, and propose it as a changeset with a snapshot op."
- Chat itself works normally whether or not the banner is shown.
- When the snapshot exists but is stale, the banner instead says "Project snapshot last reconciled N days ago", with the same button labelled "Ask Claude to reconcile it".

## REQ-0059: next action in session context

### REQ-0059#AC3: next action shown first

- **Brief.** The next action block is the first section after the title line, before Kind and the task section (layout above). It shows the text and the date it was set. With no next action the section is omitted; there is nothing to show first.
- **Chat.** On a task-focused first turn, the next action block precedes the task section and the snapshot (layout above).
- **Task drawer.** The drawer shows the next action at the top, above the description: the text, "set YYYY-MM-DD", and, when an agent run left a pending `NEXT:` proposal (REQ-0059#AC2), the proposal with Accept / Edit / Reject beneath it.

### REQ-0059#AC4: when the chat agent is asked for next actions and a snapshot Next

- The chat state (`web/src/state/chat.tsx`) gains two per-session flags, persisted with the session id in local storage:
  - `applied`: set when a changeset is applied while this session is open (the `ChangesetCard.apply` path that already notifies the session);
  - `wrapUpAsked`: set when the wrap-up message has been sent.
- **Triggers.** When `applied && !wrapUpAsked`:
  - **New chat** (`reset`): send the wrap-up message on the current session first; the new session starts when that turn finishes. The button shows "Wrapping up…" meanwhile.
  - **Closing the chat panel** (`setOpen(false)`): send the wrap-up message on the current session. The turn keeps streaming in the chat provider while the panel is closed; its changeset card is waiting in the log when the panel reopens.
- **Once.** `wrapUpAsked` is set before sending, so each session is asked at most once, however many times the panel is closed. A session with no applied changeset is never asked.
- **Message** (sent with `noCtx`):

  > Before we stop: for each task whose state changed in this session, propose an updated next_action (one concrete step naming a file path, command or record id, at most 280 characters, with next_action_set today). Also propose a snapshot op updating the Next item of state/HOT.md and its Last reconciled date. Put everything in one changeset; simulate it first. If nothing needs to change, say so and propose nothing.

- The result is an ordinary changeset (task `update` ops plus at most one snapshot op), so the user reviews and applies it like any other; nothing changes without Apply.
- The trigger is client-side because only the UI knows when the panel closes or a new chat starts; the server needs no new state.

## Evals

**E1** is `cargo test --manifest-path server/Cargo.toml --test context -- snapshot`, in the new file `server/tests/context.rs`. Every test name starts with `snapshot_`:

| test | covers |
|---|---|
| `snapshot_format_valid_and_invalid` | REQ-0057#AC1: headings in order, one Next item, Last reconciled line |
| `snapshot_op_apply_writes_and_commits` | REQ-0057#AC2: propose, simulate diff present, apply writes `state/HOT.md` in the apply commit; stale on concurrent change |
| `snapshot_single_writer` | REQ-0057#AC2: source scan, only `snapshot.rs` and `changes::apply` write the path |
| `snapshot_simulate_errors` | REQ-0057#AC3: >8,192 bytes, missing heading, 2 Next items each give `valid: false` |
| `snapshot_lint_stale` | REQ-0057#AC4: `REQFORGE_TODAY` 22 days after the date gives `snapshot-stale`, 21 days gives none |
| `snapshot_chat_first_turn` | REQ-0058#AC1: with fake claude (`REQFORGE_CLAUDE_BIN`), the stdin of the first turn has the block verbatim, and a resumed turn's stdin doesn't |
| `snapshot_agent_brief` | REQ-0058#AC2: next action block first, snapshot block after `## Done when`, before `## Story` |
| `snapshot_compact_hook` | REQ-0058#AC3: `hooks/hooks.json` registers SessionStart/compact with `snapshot --hook`; running it with `REQFORGE_REPO` prints the additionalContext JSON, and without `REQFORGE_REPO` or without the file it prints nothing and exits 0 |
| `snapshot_resupply_system_prompt` | REQ-0058#AC3 fallback: with `REQFORGE_SNAPSHOT_RESUPPLY=system`, chat `command_args` for a resumed turn and agent `command_args` carry the block in `--append-system-prompt`; with `hook` they don't |

`scripts/check-compact-hook.sh` is a manual check against the real CLI, not part of E1: it costs model calls and needs a signed-in `claude`.

**E2** is `node web/e2e/run.mjs --suite snapshot`, in the new file `web/e2e/suites/snapshot.js`, with `snapshot` added to `SUITE_NAMES`:
- **REQ-0057#AC2:** propose a snapshot changeset through the API, check that the card shows `cs-snapshot-diff`, click Apply, then check that `GET …/snapshot` returns the new content.
- **REQ-0058#AC4:** in a seeded project without `state/HOT.md`, check that the chat panel shows `snapshot-missing`, and that clicking `snapshot-draft` posts the draft message as a chat turn (with fake claude).

REQ-0059#AC3-AC4 are verified with STORY-0017's next-action work, not by E1/E2; the wrap-up trigger fits an e2e case in the chat suite (apply a changeset, close the panel twice, assert exactly one wrap-up turn).

## Open points

- **Hook verified on one version.** The check passed on Claude Code 2.1.289; re-run it on upgrades, and fall back to `system` if it fails.
- **Stale snapshot in a long chat.** With `REQFORGE_SNAPSHOT_RESUPPLY=hook`, a resumed chat keeps the snapshot from its first turn until the next compaction, even if a newer one is applied. The `system` mode does not have this gap.
- **Next item is free text.** Stories and tasks have no field linking them to the snapshot.
