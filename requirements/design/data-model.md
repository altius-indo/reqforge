---
title: Data model and storage
realises:
  - REQ-0003
  - REQ-0004
  - REQ-0005
  - REQ-0006
  - REQ-0007
  - REQ-0008
  - REQ-0035
  - REQ-0037
  - REQ-0042
  - REQ-0049
---

# Data model and storage

## Purpose

This spec describes how reqforge represents and stores its data. It covers the record kinds
(requirements, epics, stories, tasks, components) and their fields, how ids are allocated,
how records are validated, versioned and written to disk, and how every change becomes a git
commit that can be synced to GitHub. It also covers the operations built on the store:
search, all-or-nothing bulk update, CSV round trip and task dependencies. It was written from
the code as it stands (`server/src/model.rs`, `server/src/store.rs`, `server/src/query.rs`,
`server/src/csvio.rs`, `server/src/taskflow.rs`, `server/src/api.rs`). The CLI, REST API, MCP
server and web UI all call the same `Store` methods, so the behaviour below holds for every
entry point.

## Realised requirements

| Id | Title | How / where realised |
|----|-------|----------------------|
| REQ-0003 | Record lifecycle with sequential ids | `Store::create_unlocked` assigns `next_id` (PREFIX-NNNN, max existing + 1), version 1; `Store::delete` refuses with 409 when `references_to` finds referrers, unless `force` (`server/src/store.rs`) |
| REQ-0004 | Schema validation | `model::validate` (required, types, enums, objlist keys, taxonomy category per type, reference existence); `Store::check` adds component key uniqueness and task dependency checks; failures are HTTP 422 with per-field details |
| REQ-0005 | Optimistic concurrency | `Store::apply_unlocked` compares `expected_version` (`_version` body field or `If-Match` header, `server/src/api.rs` `route`) with the stored version and returns 409 before anything is written |
| REQ-0006 | Search and filters | `store::parse_query`, `store::matches`, `store::keep`, `Store::search`; paged/faceted variants in `query::page` and `query::facets` |
| REQ-0007 | All-or-nothing bulk update | `Store::bulk_update` computes and validates every target first, returns 422 listing all failures and writes nothing; otherwise writes all and makes one commit |
| REQ-0008 | CSV round trip | `csvio::export` and `csvio::parse`, then `Store::upsert_many` (patch rows whose id exists, create the rest) |
| REQ-0035 | GitHub-backed persistence | `git::commit_all` (pathspec `-- .` limits the commit to the requirements folder), `Store::commit` (honours `autocommit`), `git::sync`, `git::create_remote` used by `Store::init` / `reqforge init --github` |
| REQ-0037 | One JSON file per record | `Store::path` (`<kind>/<ID>.json`), `Store::write_unlocked` orders keys id, schema fields, then the rest; `store::dump` pretty-prints |
| REQ-0042 | Crash-safe writes | `Store::write_unlocked` writes `<ID>.json.tmp` then `fs::rename`; `Store::entries` only loads names ending in `.json`, and `.gitignore` excludes `*.json.tmp` |
| REQ-0049 | Task dependencies | `depends_on` is a `reflist` of tasks (`server/src/model.rs` `TASKS`); `model::task_dependency_errors` rejects self-reference and cycles; deleting a depended-on task is refused by `Store::delete` |

## Record kinds

`model::Kind` defines five kinds. The kind gives the id prefix, the folder and the schema.
`Kind::parse` accepts singular, plural and short forms (for example `req`, `story`, `comp`), and
`Kind::of_id` infers the kind from an id prefix.

| Kind | Prefix | Folder | Purpose |
|------|--------|--------|---------|
| requirements | `REQ` | `requirements/` | A classified requirement with acceptance criteria |
| epics | `EPIC` | `epics/` | A group of stories realising requirements |
| stories | `STORY` | `stories/` | A deliverable with acceptance criteria and evals |
| tasks | `TASK` | `tasks/` | A typed unit of work on a story |
| components | `COMP` | `components/` | A code module whose source carries trace tags |

### Field types

The field schemas live in `server/src/model.rs` (`REQUIREMENTS`, `EPICS`, `STORIES`, `TASKS`,
`COMPONENTS`, `schema()`). `FType` values:

| Type | JSON shape | Notes |
|------|-----------|-------|
| `str`, `text` | string | `text` is multi-line in the UI |
| `enum` | string | Must be one of `values` |
| `int` | integer | |
| `list` | array of strings | Comma-separated strings are split by `model::coerce` |
| `ref` | string id | Must exist in the referenced kind |
| `reflist` | array of string ids | Every id must exist in the referenced kind |
| `objlist` | array of objects | Each object must have the listed keys (except `command`) |

### Requirements (`REQ`)

| Field | Type | Required | Values / default |
|-------|------|----------|------------------|
| title | str | yes | |
| statement | text | yes | |
| type | enum | yes | constraint, interface, data, quality, functional |
| category | str | yes | Must belong to the type (see Taxonomy) |
| priority | enum | | must, should, could, wont; default `should` |
| status | enum | | draft, proposed, approved, implemented, verified, deprecated; default `draft` |
| rationale | text | | |
| acceptance_criteria | objlist | | keys `id`, `text` |
| parent | ref -> requirements | | |
| tags, standards, stakeholders | list | | |
| source | str | | |
| notes | text | | |

### Epics, stories, tasks, components

| Kind | Field | Type | Required | Values / default |
|------|-------|------|----------|------------------|
| epic | title | str | yes | |
| epic | description | text | | |
| epic | requirements | reflist -> requirements | | |
| epic | status | enum | | todo, in-progress, blocked, done; default `todo` |
| epic | tags | list | | |
| story | title | str | yes | |
| story | epic | ref -> epics | yes | |
| story | narrative | text | | |
| story | requirements | reflist -> requirements | | |
| story | deliverable | enum | | code, design, infrastructure, documentation; default `code` |
| story | component | str | | A component `key` (not a ref field) |
| story | acceptance_criteria | objlist | | keys `id`, `text` |
| story | evals | objlist | | keys `id`, `name`, `kind`, `command`; `kind` must be an `EVAL_KINDS` entry |
| story | status | enum | | work statuses; default `todo` |
| story | points | int | | |
| story | tags | list | | |
| task | title | str | yes | |
| task | story | ref -> stories | yes | |
| task | kind | enum | yes | design, code, deployment, monitoring |
| task | depends_on | reflist -> tasks | | No self-reference, no cycles |
| task | description, done_when | text | | |
| task | status | enum | | work statuses; default `todo` |
| task | estimate | str | | |
| task | tags | list | | |
| component | title | str | yes | |
| component | key | str | yes | Matches `^[a-z0-9][a-z0-9._-]{0,63}$`, unique per project |
| component | path, repo_url, language | str | | |
| component | globs, owners, tags | list | | |
| component | tag_mode | enum | | auto, explicit; default `auto` |
| component | description | text | | |

### System fields

Every record also carries `id`, `version`, `created` and `updated` (`model::SYSTEM_FIELDS`).
Clients cannot set them through create or update: `is_system` keys are dropped from the input.
`created`/`updated` are UTC timestamps in the form `2026-10-04T06:40:10+00:00` (`store::now`).
Unknown non-system fields are kept as they are. They are written after the schema fields and are
not validated.

### Example record

`requirements/tasks/TASK-0033.json` in this repository:

```json
{
  "id": "TASK-0033",
  "title": "Commit the 5 reverse-engineered design specs",
  "story": "STORY-0015",
  "kind": "design",
  "depends_on": [],
  "description": "Commit the specs drafted from code ...",
  "done_when": "5 files are committed in design/ and lint reports 0 unknown realises ids.",
  "status": "in-progress",
  "tags": [],
  "version": 2,
  "created": "2026-10-04T06:40:10+00:00",
  "updated": "2026-10-04T06:49:55+00:00"
}
```

## Id allocation

`Store::next_id` scans the kind's folder for `PREFIX-(\d+).json`, takes the highest number and
adds one, padding to four digits (`REQ-NNNN`, growing to five digits once past 9999). Callers may
supply their own `id`, which is used as given (`create_unlocked`). An id that already exists is
rejected with 409. The id is not checked against the kind's prefix. Changesets (`CS-NNNN`) and
elicitation sessions (`ELI-NNNN`) use the same max+1 scheme in their own folders.

## Validation

`Store::check` runs on every create, update, bulk update, import and task start, before
anything is written:

1. **Schema** (`model::validate`): required fields are non-empty; each field has the right JSON
   shape; enum values are in range; each `objlist` item has its required keys (`command` on
   evals may be blank).
2. **Taxonomy**: for requirements, `category` must be one of the categories of `type`
   (`TAXONOMY`: for example `data` -> model, lifecycle, quality, migration; `quality` -> the
   ISO/IEC 25010 characteristics). `functional` has no fixed list, so any category is accepted.
   Error text: `category: 'x' not valid for type 'data' (expected one of [...])`.
3. **Referential integrity**: every `ref`/`reflist` id must exist as a file of the referenced
   kind (`Store::exists`). Error text: `story: STORY-NNNN does not exist`.
4. **Kind-specific rules**: the format of story `evals[i].kind`; the format and uniqueness of
   component `key` (`model::component_key_clash`); task dependency cycles (below).

Failures return `StoreError` with status **422** and `details` set to one message per field.
The API returns these as `{"error", "details"}` (`api.rs` `err_resp`).

Deleting a record (`Store::delete`) uses `references_to`, which checks every `ref`/`reflist`
field of every kind. If anything refers to the record, the delete fails with 409 and the list
of referrers. With `force` (`?force=1`) the file is removed and the referrers are returned as
`dangling`.

## Versions and optimistic concurrency

- Create sets `version: 1`. Every successful update sets `version` to the stored version + 1
  and refreshes `updated` (`apply_unlocked`).
- `PATCH /api/{kind}/{id}` takes the expected version from the body field `_version` or from the
  `If-Match` header. If it differs from the stored version, the store returns **409**
  `"<id> was modified (version N, you had M); reload and retry"` and writes nothing.
- If no expected version is sent, the update proceeds (last writer wins). The web client always
  sends `_version` (`web/src/api/client.ts`). `RecordDrawer` shows a "changed since you opened
  it" message on a 409.
- `POST /api/tasks/{id}/start` applies the same check (`taskflow::start`).
- Writes are serialised by `Store::lock`: an in-process mutex plus an exclusive `fs2` lock on
  `<repo>/.reqforge.lock`, so separate processes (CLI, server, MCP) do not interleave.

## On-disk layout

A requirements repository is a folder containing `reqforge.json`. It can be its own git repo or
a subfolder of a code repo, as in this project's `requirements/`. `Store::discover` finds it
through `REQFORGE_REPO`, an ancestor `reqforge.json`, or a `.reqforge-repo` pointer file.

```
requirements/
  reqforge.json          project config: key, name, autocommit, gates, coverage_waivers, cicd
  README.md, .gitignore  created by Store::init; .gitignore lists .reqforge.lock and *.json.tmp
  requirements/REQ-0001.json ...
  epics/EPIC-0001.json ...
  stories/STORY-0001.json ...
  tasks/TASK-0001.json ...
  components/COMP-0001.json ...
  changesets/CS-0001.json     proposed/applied change batches (changes.rs)
  sessions/ELI-0001.md        elicitation transcripts (Store::save_session)
  code/<component-key>.json   trace-tag index per component (codetrace.rs)
  evidence/latest.json, history.jsonl, verification-history.jsonl   CI evidence (evidence.rs)
  agent-runs/<run>.json       coding-agent run logs (agent.rs), created on first run
  design/*.md                 design specs such as this one (not read by the server)
```

`Store::init` creates the five kind folders plus `sessions/` and `changesets/`, each with a
`.gitkeep`. `Store::open` merges the file's `reqforge.json` over `default_config()`.

### File format and field order

`Store::write_unlocked` builds an ordered map: `id` first, then the schema fields in schema
order, then every remaining key (`version`, `created`, `updated` and any unknown fields) in
their existing order. `store::dump` writes pretty-printed JSON (2-space indent) followed by a
newline, one file per record, so git diffs stay small and readable.

### Atomic writes

`write_unlocked` writes the whole document to `<ID>.json.tmp` and then calls `fs::rename` onto
`<ID>.json`. On one filesystem the rename is atomic, so a reader sees either the old file or
the new one. If the process crashes between the two steps, the old file (for example version 1)
is still there. The leftover `.json.tmp` is ignored, because `Store::entries` only loads names
ending in `.json` and git ignores `*.json.tmp`.

### Read cache

`Store::entries` keeps a per-file cache keyed by mtime and size. Each read re-scans the folder
and re-parses only the files that changed, so edits made outside reqforge (for example a
`git pull`) are picked up. Files that are not valid JSON objects are skipped. Each entry also
holds a lowercase JSON `blob` used for free-text search. `Store::revision` and `Store::memo`
cache derived views (lint, trace, verification) and drop them when any record, the config,
`code/` or `evidence/` changes.

## Git commit per change and GitHub sync

- Every mutating store method calls `Store::commit` with a descriptive message, for example
  `REQ-0003: create - <title>`, `<id>: update title, status`,
  `bulk: status on 4 requirements`, `import: 2 created, 3 updated tasks`, `<id>: delete`.
  `autocommit: false` in `reqforge.json` turns this off.
- `git::commit_all` runs `git add -A -- .` and `git commit -m <msg> -- .` from the repository
  root. Because of the `-- .` pathspec, a requirements folder inside a code repo commits only its
  own files and leaves unrelated work in progress alone. An empty diff does not produce a commit.
- `git::sync` (`POST /api/sync`, `reqforge sync`) commits any pending changes, runs
  `pull --rebase --autostash origin <branch>` (and runs `rebase --abort` if it fails), then
  `push -u origin <branch>`. It returns `{ok, committed, pushed, error?}`.
- `reqforge init --github owner/name` calls `git::create_remote`. A URL or path is added as
  `origin` and pushed. Otherwise `gh` attaches the GitHub repo if it exists or creates it
  (`--private` by default) and pushes. Without `gh`, it only adds an SSH remote.

## Search query language

`Store::search(kind, q, where)` (REQ-0006):

| Token | Meaning |
|-------|---------|
| `word` | Must appear, case-insensitive, somewhere in the record's JSON (field names included) |
| `field:value` | The field equals the value, case-insensitive. For list fields, any element equals it |
| `field:a\|b` | Any of the alternatives |
| `field:` / `field:none` / `field:null` | The field is empty or missing |

All tokens must match (AND). A token containing `:` is a filter unless it starts with `http`.
On the API, every query-string parameter other than `q`, `limit`, `offset`, `sort` and `order`
is also a `field=value` filter (`api.rs` `where_from`). Filters on fields that do not exist
match nothing. `query::page` adds sorting and paging (limit 1..1000), list annotations
(`_stories`, `_tasks`, ...) and two pseudo-fields for requirements: `covered:yes|no` and
`verification:verified|pending|untested|suspect|failing`. `query::facets` returns counts per
facet field, where each facet ignores its own filter.

Example: `GET /api/requirements?q=commit type:interface|data priority:must`.

## Bulk update (all or nothing)

`POST /api/{kind}/bulk` with `{ids | q | where, set, add, remove, dry_run}` calls
`Store::bulk_update`, which works as follows:

1. Selects targets: `ids` if given, otherwise `search(q, where)`. No targets returns
   `matched: 0`.
2. For each target, runs `apply_unlocked`: `set` replaces fields, `add` appends list values
   that are not already present, `remove` drops list values. Then it bumps the version and runs
   the full `check`.
3. If any target fails (invalid data or an unknown id), returns 422
   `bulk update rejected: N of M records invalid` with per-record details. **No file is written.**
4. Otherwise, unless `dry_run`, writes every record (each one atomically) and makes **one** git
   commit. Returns `{matched, changed, dry_run}`.

Bulk update does not take an expected version. It applies to the current stored state while
holding the write lock.

## CSV import and export

- **Export** (`csvio::export`, `GET /api/{kind}/export.csv`, honours `q`/filters): columns are
  `id`, every schema field in order, then `version`. `list`/`reflist` cells are joined with
  `", "`. `objlist` cells (acceptance criteria, evals) are JSON text. Line endings are CRLF.
- **Import** (`csvio::parse`, `POST /api/{kind}/import` with `text/csv`, or `{rows:[...]}`):
  a header-driven parse. `id` is kept, other system columns (`version`, ...) and unknown columns
  are dropped. A blank scalar cell means "leave unchanged". A blank list cell clears the list.
  `objlist` cells are parsed as JSON. List cells are split on commas by `coerce`.
- `Store::upsert_many` patches rows whose id exists (`apply_unlocked`, validated, version + 1)
  and creates rows with no id or an unknown id, then makes one commit
  (`import: X created, Y updated <kind>`).

## Task dependencies

- `depends_on` holds task ids. The generic reflist check rejects unknown ids:
  `depends_on: TASK-NNNN does not exist`.
- When there are no other errors, `model::task_dependency_errors` builds the dependency graph
  from all stored tasks, with this record's proposed `depends_on` replacing its stored one. It
  rejects:
  - self-reference: `depends_on: TASK-0007 cannot depend on itself`
  - any cycle, found by depth-first search back to the record:
    `depends_on: dependency cycle TASK-0007 -> TASK-0003 -> TASK-0007`
- Deleting a task that another task lists in `depends_on` fails with 409 unless forced
  (`references_to` covers reflist fields).
- `taskflow::start` blocks starting a task (409) while any dependency is not `done`.
  `taskflow::readiness` explains this to the UI.

## Open questions and gaps

- **CSV / upsert import is not all-or-nothing.** `Store::upsert_many` writes rows one by one.
  If a later row fails validation, earlier rows are already on disk but not committed, and the
  next commit will include them. REQ-0008 does not require atomicity, but this differs from bulk
  update (REQ-0007).
- **No concurrency check on import or bulk.** The `version` column is dropped on import and bulk
  update takes no expected version, so a CSV edited offline can overwrite newer changes without
  a 409 (REQ-0005 is enforced only for single-record update and task start).
- **Bulk writes are atomic per file, not per batch.** Validation is all-or-nothing (REQ-0007
  AC2), but a crash partway through the write loop can leave some records updated and
  uncommitted.
- **Crash-safety is process-level only.** `write_unlocked` does not fsync the temp file or the
  folder, so power loss could still lose a just-renamed write. Stale `.json.tmp` files are never
  cleaned up. `reqforge.json`, changesets, sessions and evidence are written with plain
  `fs::write`, not temp-file + rename (REQ-0042 names records only).
- **Id reuse and caller ids.** `next_id` is max + 1 over existing files, so deleting the
  highest-numbered record lets its id be issued again. Caller-supplied ids (API, import) are not
  checked against the `PREFIX-NNNN` format (REQ-0003).
- **Commit failures are silent.** `git::commit_all` ignores git errors. A mutation succeeds on
  disk even if the commit fails or git is missing, which weakens "every change is a commit"
  (REQ-0035). Sync only happens on an explicit `sync`, not on every mutation.
- **Search limits.** Free text also matches field names in the JSON blob. A `field:value` value
  cannot contain spaces. A repeated field token replaces the earlier one instead of combining
  with it.
- **Design documents are not modelled.** The server does not read `design/*.md` or its
  `realises` front matter, so nothing in the code checks that the realised REQ ids exist.
