# Context management: the project snapshot

Design for STORY-0017 (REQ-0057 project snapshot, REQ-0058 snapshot in agent context). TASK-0041.

The snapshot is a short, human-approved statement of where the project is: what is happening now, the one next thing, and what to watch. Every chat and coding-agent session starts from it, and gets it back after Claude Code compacts the conversation.

## The file (REQ-0057#AC1)

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
  5. **Markers.** The content must not contain `<project-state` or `</project-state>`, the delimiters used when it is injected (below).

  Error strings name the rule, e.g. `snapshot: 9,310 bytes, limit is 8,192`, `snapshot: missing heading '## Watch'`, `snapshot: headings out of order (expected Now, Next, Watch)`, `snapshot: Next has 2 items, must have exactly 1`.
- All snapshot code lives in a new module `server/src/snapshot.rs`, which owns the path constant `pub const PATH: &str = "state/HOT.md"`. It contains:
  - `read(root) -> Option<String>`;
  - `validate`;
  - `last_reconciled(content) -> Option<NaiveDate>`;
  - `line_diff(old, new)`;
  - `context_block(content)`;
  - `hook_output(root)`.

## The snapshot changeset op (REQ-0057#AC2, AC3)

### Op shape

```json
{"op": "snapshot", "content": "<full new HOT.md>", "reason": "…"}
```

- The op always carries the full content, never a patch, so what the reviewer sees is exactly what gets written.
- A changeset may hold at most one snapshot op. A second one is a validation error.
- A changeset may mix it with record ops. They are applied and committed together.
- The changes.rs module doc gains the new op, and `unknown op` errors list it among the expected ops.

### Materialize and simulate

- `View` gains `snapshot: Option<String>`. `base_view` fills it from `snapshot::read(store.root)`.
- `materialize` handles `"snapshot"`:
  - it requires `content` to be a string;
  - it runs `snapshot::validate` and pushes each message to `errors` as `op {i} (snapshot): …`, which makes `valid: false` (AC3);
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

### Propose and Apply

- **Propose.** `base_versions["state/HOT.md"]` is the op's `base_version`.
- **Apply.**
  - Under the store lock, the staleness loop special-cases `state/HOT.md`: it compares the sha256 (`sha2`, already a dependency) of the current file, or `"absent"`, with the recorded value. A mismatch makes the changeset `stale` like any record change.
  - If the snapshot op is not excluded, `materialize` re-validates it. Apply then writes `view.snapshot` to `state/HOT.md` with `snapshot::write_unlocked`, which creates `state/` and uses a temp file plus rename, like `Store::write_unlocked`.
  - This happens before the single `store.commit("CS-NNNN: apply — …")`, so the file and the records land in one commit. `written` includes `"state/HOT.md"`.
- **Excluding the op.** Excluding it via `exclude` skips the write, as for any op.

### Only path that writes the file

`snapshot::write_unlocked` is `pub(crate)` and its only caller is `changes::apply`. No other path writes the file:
- **REST:** `GET /api/p/{K}/snapshot` is read-only, and there is no PUT or POST.
- **MCP:** there is no snapshot write tool. `get`, `search` and the rest are record-only.
- **CLI:** `reqforge snapshot` only prints.
- **Store and CSV import:** they never write under `state/`, since `Store::path` maps only record kinds.
- **Chat:** chat denies `Write` and `Edit`.
- **Coding agent:** the agent runs in a worktree, and any change to the requirements repo is recorded as a sandbox violation (REQ-0052).

A test asserts this structurally: `"state/HOT.md"` and `snapshot::PATH` writes appear only in `snapshot.rs` and the apply branch of `changes.rs` (AC2, "0 other paths").

### Changeset card (web)

- `ChangesetCard.tsx` renders `op === "snapshot"` as a row labelled `snapshot` with the id `state/HOT.md`, the byte count and the Last reconciled date.
- Below that row it shows the diff as a monospace block (`data-testid="cs-snapshot-diff"`):
  - `+` lines are green and `-` lines red;
  - unchanged runs longer than 6 lines collapse to `…`, which can be expanded.
- Validation errors show in the existing errors list. Apply and Reject behave as for any changeset.

## Lint (REQ-0057#AC4)

- `lint::lint` reads `src.snapshot()`.
- If the snapshot exists and `today - last_reconciled > 21 days`, it adds:

  ```json
  {"severity": "warning", "rule": "snapshot-stale", "ids": [], "message": "state/HOT.md last reconciled YYYY-MM-DD (N days ago, limit 21)"}
  ```

  `today` is `chrono::Local::now().date_naive()`. Tests can override it with `REQFORGE_TODAY=YYYY-MM-DD`, which is read only by `snapshot::today()`.
- A missing snapshot gives no finding: REQ-0058#AC4 treats it as a normal state.
- An existing file that fails `validate` (hand-edited outside reqforge) gets one `warning` with `rule: "snapshot-invalid"` and the first error.
- Because simulate diffs lint before and after, a changeset that refreshes the date shows `snapshot-stale` as resolved.

## Injection points (REQ-0058)

Everything that injects the snapshot calls `snapshot::context_block(content)`, so the text is identical everywhere:

```
<project-state source="state/HOT.md" last-reconciled="YYYY-MM-DD">
<file content, verbatim, unmodified>
</project-state>
```

The tag says the content is project state and carries the content itself, not a pointer to the file. Validation forbids the markers inside the content, so the block cannot be broken out of.

### Chat (AC1)

- In `ChatRunner::stream`, when `session_id` is `None` (the first turn of a session), the prompt becomes:

  ```
  snapshot block + "\n\n" + context_preamble + message
  ```

  It goes into the first user turn, not `--append-system-prompt`. The system prompt then stays static and cacheable, and the session history records which snapshot it started from.
- Resumed turns (`--resume`) don't repeat it. It is already in the conversation, and compaction is covered by the hook.
- No file means no block (AC4).
- `chat_prompt.md` gains a "Project state" section:
  - the `<project-state>` block is the approved snapshot; use it as the starting point and verify details with the tools;
  - to change it, propose a changeset with one `{"op":"snapshot","content":…}` op holding the full new file in the format above. Keep it under 8 KiB with exactly one Next item, and set `Last reconciled` to today;
  - never write `state/HOT.md` directly;
  - when asked to draft one, build it from `search`/`context`/`trace`, in-progress tasks and recent changesets, simulate it, then propose it.

### Coding agent (AC2)

- `agent::brief` inserts this section right after the task section (after `## Done when`, before `## Story`):

  ```
  ## Project snapshot
  <project-state …>…</project-state>
  ```

- With no file, the section reads `(none: this project has no state/HOT.md yet)`, and the run starts normally (AC4).
- `agent_prompt.md` gains one line: the brief's `<project-state>` block is read-only project context; don't edit `state/HOT.md`.

### After compaction (AC3): plugin SessionStart hook

New file `hooks/hooks.json` at the plugin root (Claude Code loads plugin hooks from there):

```json
{"hooks": {"SessionStart": [{"matcher": "compact",
  "hooks": [{"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/reqforge snapshot --hook", "timeout": 10}]}]}}
```

- Claude Code runs `SessionStart` hooks with `source: "compact"` after it compacts a session, whether the compaction was automatic or `/compact`. It adds the hook's `additionalContext` to the context before the next model turn.
- Chat and agent runs both load the plugin with `--plugin-dir`, so both get the hook.
- The `startup` and `resume` sources are deliberately not matched. Startup is covered by the first turn and the brief, and matching it would inject the snapshot twice.
- `reqforge snapshot --hook` (in `cli.rs`):
  1. It reads and ignores the hook JSON on stdin.
  2. It resolves the requirements root from `REQFORGE_REPO` only. Both `ChatRunner::mcp_env` and the agent runner already set it to the session's project. If it is unset, the command exits 0 with no output, so the plugin installed in an unrelated interactive session does nothing.
  3. If `state/HOT.md` exists, it prints:

     ```json
     {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "<context_block(content)>"}}
     ```

  4. If the file doesn't exist, it prints nothing.
  5. It always exits 0, so a hook failure never blocks a session.
- The hook re-reads the file at compaction time, so a snapshot applied mid-session reaches the agent at the next compaction.
- `reqforge snapshot` without `--hook` prints the file content to stdout, or exits 1 with `no project snapshot`. It resolves the project the usual way.

## Chat panel: no snapshot (REQ-0058#AC4)

- `GET /api/p/{K}/snapshot` returns one of:
  - `{exists: false}`;
  - `{exists: true, content, bytes, last_reconciled, age_days, stale, errors}`, where `errors` is the output of `snapshot::validate`.
- `ChatPanel.tsx` loads it with the project, refetching after any changeset is applied. When `exists` is false it shows a banner above the input (`data-testid="snapshot-missing"`):
  - the text "No project snapshot";
  - a button "Ask Claude to draft one" (`data-testid="snapshot-draft"`). The button sends this chat message: "Draft a project snapshot (state/HOT.md) from the current requirements, stories, tasks and recent changesets, and propose it as a changeset with a snapshot op."
- Chat itself works normally whether or not the banner is shown.
- When the snapshot exists but is stale, the banner instead says "Project snapshot last reconciled N days ago". It has the same button, labelled "Ask Claude to reconcile it".

## Evals

**E1** is `cargo test --test context -- snapshot`, in the new file `server/tests/context.rs`. Every test name starts with `snapshot_`:

| test | covers |
|---|---|
| `snapshot_format_valid_and_invalid` | REQ-0057#AC1: headings in order, one Next item, Last reconciled line |
| `snapshot_op_apply_writes_and_commits` | REQ-0057#AC2: propose → simulate diff present → apply writes `state/HOT.md` in the apply commit; stale on concurrent change |
| `snapshot_single_writer` | REQ-0057#AC2: source scan, only `snapshot.rs` and `changes::apply` write the path |
| `snapshot_simulate_errors` | REQ-0057#AC3: >8,192 bytes, missing heading, 2 Next items each give `valid: false` |
| `snapshot_lint_stale` | REQ-0057#AC4: `REQFORGE_TODAY` 22 days after the date gives `snapshot-stale`, 21 days gives none |
| `snapshot_chat_first_turn` | REQ-0058#AC1: with fake claude (`REQFORGE_CLAUDE_BIN`), the stdin of the first turn has the block verbatim, and a resumed turn doesn't |
| `snapshot_agent_brief` | REQ-0058#AC2: block after `## Done when`, before `## Story` |
| `snapshot_compact_hook` | REQ-0058#AC3: `hooks/hooks.json` registers SessionStart/compact with `snapshot --hook`; running it with `REQFORGE_REPO` prints the additionalContext JSON, and without `REQFORGE_REPO` or without the file it prints nothing and exits 0 |

**E2** is `node web/e2e/run.mjs --suite snapshot`, in the new file `web/e2e/suites/snapshot.js`, with `snapshot` added to `SUITE_NAMES`:
- **REQ-0057#AC2:** propose a snapshot changeset through the API, check that the card shows `cs-snapshot-diff`, click Apply, then check that `GET …/snapshot` returns the new content.
- **REQ-0058#AC4:** in a seeded project without `state/HOT.md`, check that the chat panel shows `snapshot-missing`, and that clicking `snapshot-draft` posts the draft message as a chat turn (with fake claude).

## Open points

- A resumed chat keeps the snapshot from its first turn until the next compaction, even if a newer one is applied in the meantime. Re-injecting on the first resumed turn after the file's hash changes would close this. It is not required by REQ-0058 and is left out.
- Stories and tasks have no field linking them to the snapshot. The Next item is free text.
