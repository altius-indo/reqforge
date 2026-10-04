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
