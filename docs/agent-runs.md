# Agent runs: starting a task with a coding agent

Design for STORY-0013 (REQ-0051 start task with coding agent, REQ-0052 coding agent sandbox). TASK-0027.

## Flow

1. **Readiness.** `GET /api/p/{K}/tasks/{id}/agent` returns the component, its local checkout, the branch `reqforge/TASK-NNNN`, the worktree path, the full brief, and `ready`/`reasons`. Start with agent is disabled when:
   - the story has no component;
   - the component is undefined or has no `path`;
   - any `depends_on` task is not done;
   - the task is done.
2. **Confirmation.** The UI shows the component path, branch and brief. Nothing runs until the user confirms (REQ-0051#AC1).
3. **Worktree.** `git -C <component> worktree add -b reqforge/TASK-NNNN <worktrees>/<PROJECT>/TASK-NNNN <HEAD>`. If the branch or worktree already exists it is reused, so a task can be re-run. `<worktrees>` is `$REQFORGE_WORKTREES`, defaulting to `~/.reqforge/worktrees`, which is outside both the component and the requirements repo.
4. **Start.** If the task is `todo` it is started first: task, story and epic move to in-progress in one commit (REQ-0050).
5. **Run.** `claude -p` runs with the worktree as cwd, the brief on stdin, the coding system prompt and the coding tool policy. stream-json is translated to UI events and streamed over SSE. The user can cancel.
6. **Result.** Recorded at the end:
   - exit status: a numeric code, `cancelled`, or `error`;
   - the commits on the branch since its base;
   - any sandbox violations.

   The task status is never set to done automatically (REQ-0051#AC5).

## Brief (REQ-0051#AC3)

The brief contains:
- task id, title, kind, description and done_when;
- story title and narrative, and the story's acceptance criteria;
- each linked requirement's id, statement and acceptance criteria;
- the trace tag convention (`reqforge: implements REQ-…`, tests tagged `REQ-…#AC…`), the branch rules, and "run the tests named in the story's evals".

## Tool policy (REQ-0052)

| | tools |
|---|---|
| allowed | Read, Edit, MultiEdit, Write, Glob, Grep, TodoWrite; `Bash` limited to build/test/inspect commands (`cargo`, `npm`, `npx`, `node`, `python3`, `pytest`, `go`, `make`, `git status/diff/log/show/add/commit`); reqforge read tools (`taxonomy`, `search`, `get`, `context`, `verification`, `eval_registry`) |
| denied | every reqforge write and changeset tool (`create`, `update`, `delete`, `bulk_update`, `upsert_many`, `propose_changeset`, `apply_changeset`, `reject_changeset`, `config`, `sync`, `init_repo`, `scan_code`, `ingest_evidence`, `create_project`); `Bash(git push:*)`, `Bash(git checkout:*)`, `Bash(git switch:*)`, `Bash(git reset:*)`, `Bash(git rebase:*)`, `Bash(git merge:*)`, `Bash(git worktree:*)`, `Bash(rm -rf:*)`, `Bash(curl:*)`, `Bash(wget:*)`; WebFetch, WebSearch |

- `--permission-mode acceptEdits` with no `--add-dir`: Claude Code auto-approves edits only inside the working directory (the worktree). Anything else needs a permission that a headless run can't get.
- **Detection backs prevention.** Before and after the run, the server snapshots:
  - the default branch head of the component;
  - `git status --porcelain` of the component's main checkout;
  - `git status --porcelain` of the requirements repo.

  Any difference is recorded as a violation and shown to the user. The run never pushes; the branch stays local for review (REQ-0052#AC1).

## Run log (REQ-0052#AC4)

The run log is written to `requirements/agent-runs/RUN-<TASK>-<yyyymmddThhmmss>.json` and committed. It holds:
- run id, task, story, component, branch, worktree, base commit;
- the user who started it (`$USER`), start and end times;
- exit status, commits, violations, and the last 200 events.

`GET /api/p/{K}/tasks/{id}/runs` lists a task's runs.

The same commit appends one metadata-only entry for the run to `requirements/history/sessions.jsonl` (REQ-0062). The entry holds kind `agent`, the run id, project, user, start and end, and an outcome: success, failed, cancelled, timeout or violation. Its records touched is the task. Chat sessions are added to the same file when `POST /api/chat/end {session_id}` is called or after 30 idle minutes. History is compacted once a day into monthly summaries, covering entries older than 365 days. See `server/src/history.rs`.

## Agent queue (STORY-0014, REQ-0053, TASK-0030)

**Setting.** Per project, stored in `reqforge.json` as `agent_queue: {enabled, limit, changed_by, changed_at}`:
- the queue is off by default;
- `limit` is an integer from 1 to 8, default 2;
- `POST /api/p/{K}/agent-queue {enabled, limit, confirm: true}` changes it and records the user and time;
- the UI shows the number of eligible tasks in the confirmation before calling it (AC1).

**Eligibility (AC2).** A task is eligible only if all of these hold:
- its status is `todo`;
- every requirement linked to its story is `approved`;
- every `depends_on` task is `done`;
- its story's component has a `path`;
- it has no agent run on record, so a failed or cancelled run is never retried (AC5);
- it is not running now.

**Scheduling (AC3).** `tick` runs every 5 s (`REQFORGE_QUEUE_TICK_MS`), which keeps it well inside the 30 s bound. For each project with the queue on, it starts eligible tasks in ascending id order while the number of running agents is below `limit`.

**Runs (AC4).** Queued runs go through the same `AgentRunner::run` as UI runs: the same worktree, branch, brief and run log, and the task is moved to in-progress. Their events go into the same live buffer the UI reads through `GET /api/p/{K}/tasks/{id}/agent/live`. Turning the queue off starts no new runs and leaves active ones running (AC5).

**View (AC6).** `GET /api/p/{K}/agent-queue` returns:
- the setting and who changed it;
- the running tasks;
- the eligible waiting tasks, in start order.

## Completing a task from its agent branch (STORY-0016, REQ-0056, TASK-0038)

Terms used below:
- **checkout**: the component's main checkout (`git rev-parse --show-toplevel` of the component path).
- **target**: the branch currently checked out there. This is usually `main`, but Complete does not assume it.
- **task branch** and **worktree**: `reqforge/TASK-NNNN` and its worktree, as created by Start with agent.

Complete is one request, `POST /api/p/{K}/tasks/{id}/complete {_version}`. The steps below run in order. A failure at any step before step 5 leaves the target and the requirements unchanged and returns `409` with `{step, reason, …}` for the drawer to show.

### Review (AC1)

`GET /api/p/{K}/tasks/{id}/branch` returns:
- `branch`, `worktree`, `target`, and `base` = `git merge-base <target> <task branch>`;
- `commits`: `git log --format=%h%x09%an%x09%aI%x09%s <base>..<task branch>`;
- `files`: `git diff --name-status <base>...<task branch>` (status and path);
- `diff`: `git diff <base>...<task branch>`, cut at 512 KiB with `truncated: true`;
- `ahead` and `behind`: commit counts relative to the target;
- `complete`: `{ready, reasons}`, the step-1 checks, so the drawer can disable Complete and show why before it is clicked.

If the branch doesn't exist, the endpoint returns `404`. The drawer shows this section only when the task has a branch.

### 1. Preconditions (AC2)

Complete is refused, with the reason, when any of these holds:
- the task is not `in-progress`;
- an agent run for the task is active (`AgentRunner::running`);
- another Complete is running in the same project. A per-project mutex makes this a `409`, not a queued request;
- the worktree is missing or not on the task branch;
- the worktree has uncommitted changes (`git status --porcelain` is not empty). Only committed work is merged;
- the task branch has no commits ahead of `base`;
- **the checkout has uncommitted changes outside the requirements folder.** This reuses `agent::snapshot(...).component_status`, which already excludes the requirements folder when it lives inside the checkout. Untracked files count, because they can block the final merge. The reason lists the first 20 paths.

`_version` is checked as for `start`, so a stale drawer gets `409`.

### 2. Bring the target into the task branch (AC3)

- Record `H` = `git -C <checkout> rev-parse HEAD`, the target head the evals will be checked against.
- Record `T` = the task branch head.
- In the worktree run `git merge --no-edit <H>`. If it is already up to date, this is a no-op.

On conflict:
- read the conflicting files from `git diff --name-only --diff-filter=U`;
- run `git merge --abort`, which leaves the task branch at `T` (verify with `rev-parse`);
- refuse with `{step: "merge", conflicts: [...]}`.

The target is never touched in this step, so both branches stay unchanged.

The merge runs in the worktree, not the checkout. Conflicts are then never visible in the user's checkout, and the evals in step 3 test exactly the tree that will land.

### 3. Run the story's evals on the merged tree (AC4)

- Select the evals of the task's story that have a `command`, from `evals::registry` filtered by story, in eval-id order. Stage is ignored: every eval of the story must pass. Evals without a command are reported as `skipped` and do not block.
- Run each one with `evals::run_one` in the worktree, using the eval's `timeout` (default 1800 s), with `REQFORGE_STORY` and `REQFORGE_EVAL` set.
- No report is written into the worktree. The `reqforge-reports` default of `evals::run` would leave it dirty.
- If any eval fails or times out, Complete is refused with `{step: "evals", failed: [{id, name, command, seconds, output_tail}]}`. `output_tail` is the last 4000 characters, as captured by `run_one`; the drawer shows its last 40 lines, expandable.
- The merge commit from step 2 stays on the task branch. A follow-up agent run or manual fix then builds on the integrated tree, and re-running Complete makes step 2 a no-op.

Each attempt, passed or refused, is logged in `requirements/agent-runs/COMPLETE-<TASK>-<yyyymmddThhmmss>.json` and committed with the run logs. The log holds: user, start and end time, H, T, the merge result, the per-eval results, and the outcome. `GET …/runs` returns these entries with `kind: "complete"`.

### 4. Land on the target with --no-ff (AC5)

- Check that the target hasn't moved since step 2:
  - if `HEAD` ≠ `H`, look at `git diff --name-only H HEAD`;
  - if every changed path is under the requirements folder (reqforge's own commits, e.g. a run log), proceed;
  - otherwise refuse with `{step: "target-moved"}`, because the evals did not test that tree. The user retries.
- Check step 1's checkout-cleanliness again.
- Run `git -C <checkout> merge --no-ff --no-edit -m "TASK-NNNN: complete — <task title>" <task branch>`. The task branch already contains `H`, so this cannot conflict on code. If it fails anyway, run `git merge --abort` and refuse with `{step: "land"}`.
- The resulting merge commit is the `merge_commit` in the response and the log.

### 5. Status cascade (AC5, AC6)

Under the store lock, in one versioned commit `TASK-NNNN: complete (<ids> -> done)`:
- the task becomes `done`;
- the story becomes `done` when every task with `story == <story>` is `done` after this change;
- the epic becomes `done` when every story of the epic is `done` after this change.

As with `start`, `blocked` or other parents that don't qualify are left as they are. The response's `changed` lists every id that moved.

Ordering matters. The code merge (step 4) happens before the status commit, so a task is never `done` without its code on the target. If the status commit fails after the merge, the response is `500` with `merge_commit` set. Complete can be re-run: step 1 then sees the branch has no commits ahead of base, and in that case only (task `in-progress`, branch fully merged into the target) Complete skips steps 2–4 and goes straight to 5.

### 6. Cleanup (AC5)

- `git -C <checkout> worktree remove <worktree>`, without `--force`. The worktree is known to be clean.
- `git -C <checkout> branch -d reqforge/TASK-NNNN`. Use `-d`, not `-D`: git itself confirms the branch is merged.
- Run logs in `requirements/agent-runs/` are kept.

The status is already `done` at this point, so a cleanup failure does not undo anything. The response carries `cleanup_warnings`, and the drawer shows them with the manual commands.

The response on success is `{task, merge_commit, changed, evals, cleanup_warnings}`. Everything happens in the one user action (AC5): the drawer's Complete button, after a confirmation that names the target branch.

### Parallel-task warning on Start with agent (AC7)

`GET …/tasks/{id}/agent` (the plan) gains `parallel: [{id, title, branch, ahead}]`. These are the other tasks of the same story that meet all of these:
- the task is `in-progress`;
- `git rev-parse --verify reqforge/TASK-X` succeeds in the checkout;
- `git merge-base --is-ancestor reqforge/TASK-X <target>` fails, meaning the branch is unmerged.

When `parallel` is not empty, the confirmation dialog shows a warning before the user confirms: "N other tasks of this story have unmerged agent branches; their changes may conflict with this run." Each task in the list has a checkbox, and the dialog has two actions:
- **Add to depends_on.** Sends `PATCH /api/p/{K}/tasks/{id} {depends_on: existing ∪ checked, _version}` and does not start. The plan reloads, and Start with agent is disabled by the existing "waiting for …" reason until those tasks are done.
- **Start anyway.** Starts as before.

The warning is advisory and doesn't change `ready`. The agent queue, which has no confirmation, is not affected.

### Sandboxed eval run (REQ-0052#AC5, CS-0018)

The evals in step 3 execute agent-written code. Each eval is therefore bracketed like an agent run.

Before the eval, record:
- `agent::snapshot` of the checkout and the requirements repo;
- every ref in the checkout (`git for-each-ref`);
- the task branch head.

After it, recheck all three. Complete is refused with `{step: "sandbox", violations}`, and the attempt is logged, when any of these happened:
- a file changed outside the worktree (checkout or requirements repo);
- a ref other than the target moved (a commit, branch or push);
- the target moved with anything other than reqforge's own requirements-folder commits;
- the task branch moved (the eval committed).

The eval's environment carries no `REQFORGE_*` repository variables.

### Not covered here

- Complete does not push. The target stays local, as the agent branch did.
