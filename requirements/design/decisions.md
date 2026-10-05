---
title: Decision records and the exercised rule
realises:
  - REQ-0060
  - REQ-0061
---

# Decision records and the exercised rule

## Purpose

This spec adds a sixth record kind, **decisions** (`DEC-NNNN`). A decision records a design
choice and links it to the requirements it serves. A decision counts as **exercised** only when
tagged code implements it, at least one test is tagged with its id, and every test tagged with
its id has passing evidence. The spec covers the schema and file layout, the rule that decisions
change only through changesets, search, CSV, MCP and the record drawer, the `DEC` tag grammar in
the code scan, how the exercised flag is computed from evidence, the 14-day lint rule and the
Decisions tab.

It builds on the existing code: `server/src/model.rs` (kinds and schemas), `server/src/store.rs`
(writes), `server/src/changes.rs` (changesets), `server/src/codetrace.rs` (code scan),
`server/src/evidence.rs` and `server/src/verify.rs` (evidence and status), `server/src/lint.rs`,
`server/src/csvio.rs`, `server/src/query.rs`, `server/src/mcp.rs`, `server/src/api.rs` and
`web/src`. TASK-0046 builds the record kind, DEC tags, the exercised report and the lint rule
(commit 53a75a1). TASK-0047 builds the Decisions tab.

## Realised requirements

| Id | Title | How / where realised |
|----|-------|----------------------|
| REQ-0060 | Decision records | New `Kind::Decisions` with schema `DECISIONS` in `model.rs`. Validation is in `model::validate` plus `model::decision_supersession_errors`. Direct writes are refused by `store::changeset_only`. The kind is added to `KINDS`, so search, CSV export, the drawer and the MCP read tools pick it up. |
| REQ-0061 | Decisions exercised by code | The `codetrace` id regexes accept `DEC-NNNN`. New `decisions::compute` builds the exercised report from tags and evidence. `decisions::lint_findings` adds rule `decision-unexercised` after 14 days. A Decisions tab is added in `web/src/views/DecisionsView.tsx`. |

## Acceptance criteria map

| Criterion | Section |
|-----------|---------|
| REQ-0060#AC1 | [Schema and file layout](#schema-and-file-layout) |
| REQ-0060#AC2 | [Validation](#validation) |
| REQ-0060#AC3 | [Changesets only](#changesets-only), [Search, CSV, drawer and MCP](#search-csv-drawer-and-mcp) |
| REQ-0061#AC1 | [DEC tags in the code scan](#dec-tags-in-the-code-scan) |
| REQ-0061#AC2 | [Exercised computation](#exercised-computation) |
| REQ-0061#AC3 | [Lint rule: decision-unexercised](#lint-rule-decision-unexercised) |
| REQ-0061#AC4 | [Decisions tab](#decisions-tab) |

## Schema and file layout

`model::Kind` gains `Decisions`:

| Kind | Prefix | Folder | `singular` | `Kind::parse` aliases |
|------|--------|--------|------------|-----------------------|
| decisions | `DEC` | `decisions/` | decision | `decisions`, `decision`, `dec` |

`KINDS` becomes `[Requirements, Epics, Stories, Tasks, Components, Decisions]`. `Kind::of_id`
then resolves `DEC-0001` with no extra code. As for other kinds, each record is one file,
`requirements/decisions/DEC-NNNN.json`. It is written by `Store::write_unlocked` (temp file, then
rename), which creates the `decisions/` folder on first write so repositories created before the
kind existed still work. Ids are allocated by `next_id` (max existing + 1, four digits minimum).

Schema `DECISIONS` (REQ-0060#AC1):

| Field | Type | Required | Values / default |
|-------|------|----------|------------------|
| title | str | yes | |
| context | text | yes | The forces and constraints behind the decision |
| decision | text | yes | What was decided |
| status | enum | | `proposed`, `accepted`, `superseded` (`DECISION_STATUSES`); default `proposed` |
| requirements | reflist -> requirements | | Each id must exist |
| superseded_by | ref -> decisions | | Required when `status` is `superseded` |
| accepted_at | str | | UTC timestamp; stamped when the decision becomes accepted |
| tags | list | | |

`title`, `context` and `decision` are `req(...)` fields, so `model::validate` reports
`<field>: required` when they are missing or empty. `status` uses
`en("status", DECISION_STATUSES, Some("proposed"))`, so `model::defaults` fills in `proposed`
and any other value fails with the usual enum error. `enums_json()` exposes the values as
`decision_status`.

### `accepted_at`

The 14-day rule needs to know when a decision was accepted. `accepted_at` is an ordinary schema
field (not a system field), in the same RFC 3339 UTC form as `created`/`updated`.
`changes::materialize` maintains it through `stamp_accepted`, so simulations and the applied
record agree:

- On create, a decision whose status is `accepted` gets `accepted_at = now` unless the op sets
  `accepted_at` itself.
- On update, when status moves from anything else to `accepted` and the op does not change
  `accepted_at`, it is set to the time of the changeset.
- An explicit `accepted_at` in the op is kept. This lets a backfill record the real acceptance
  date (and lets tests seed old dates).
- Moving from `accepted` to `proposed` or `superseded` does not clear `accepted_at`.

If an accepted record has no `accepted_at` (for example, a hand-edited file), the lint falls back
to `updated`, then `created`.

Example `requirements/decisions/DEC-0001.json`:

```json
{
  "id": "DEC-0001",
  "title": "Store one JSON file per record",
  "context": "Records must diff cleanly in git and merge without a database.",
  "decision": "Each record is written to <kind>/<ID>.json with stable key order.",
  "status": "accepted",
  "requirements": ["REQ-0037"],
  "accepted_at": "2026-10-05T03:00:00+00:00",
  "tags": [],
  "version": 2,
  "created": "2026-10-05T02:50:00+00:00",
  "updated": "2026-10-05T03:00:00+00:00"
}
```

## Validation

Validation runs in `model::validate` and the kind-specific checks that run both in
`changes::materialize` (post-op view, alongside `component_key_clash` and
`task_dependency_errors`) and in `Store` validation. Every failure is reported per field;
simulation lists it and apply refuses with 422 (REQ-0060#AC2):

- `requirements` is a `reflist` to requirements, so the existing reference check rejects ids that
  do not exist (`requirements: REQ-9999 does not exist`).
- `model::validate`: if `status == "superseded"` and `superseded_by` is empty, it reports
  `superseded_by: required when status is superseded`.
- `superseded_by` is a `ref` to decisions, so it must name an existing decision (or one created
  earlier in the same changeset).
- New `model::decision_supersession_errors(rec, &all_decisions)`:
  - `superseded_by` equal to the record's own id reports
    `superseded_by: DEC-0001 cannot supersede itself`.
  - Cycles: the check follows `superseded_by` from the record through the post-op view of all
    decisions (so ops in the same changeset count). If the walk returns to the record, it reports
    `superseded_by: supersession cycle DEC-0001 -> DEC-0002 -> DEC-0001`. `superseded_by` is a
    single ref, so the walk is linear and bounded by the number of decisions; a cycle that does
    not pass through the record is reported when one of its members is validated.
- `Store::references_to` iterates `KINDS` and schema ref fields. A requirement linked from a
  decision, or a decision named in another decision's `superseded_by`, therefore shows up as a
  dangling reference when a changeset deletes it.

## Changesets only

REQ-0060 requires that decisions are created and changed only through changesets.
`store::changeset_only(kind)` returns
`StoreError("decisions are created and changed only through changesets; propose a changeset", 403)`
for `Kind::Decisions`. It is called at the top of the public write paths `create_unlocked`,
`update`, `bulk_update`, `upsert_many` and `delete`. `changes::apply` writes with
`Store::write_unlocked` and removes files directly, so it is the only write path. As a result:

- REST `POST/PATCH/DELETE /api/decisions[/…]`, CSV import (`/api/decisions/import`, which goes
  through `upsert_many`) and the MCP `create`, `update`, `upsert_many`, `bulk_update` and
  `delete` tools all fail with 403 and the message above. The MCP `create` description says so.
- `simulate_changeset`, `propose_changeset` and `apply_changeset` accept ops with
  `"kind": "decisions"` and `DEC-` ids, as they already do for any kind in `KINDS`.
- The chat agent's tool allowlist (`chat.rs`) already excludes every direct write. It can only
  call `simulate_changeset` and `propose_changeset`, and a human applies. This satisfies "the
  chat agent can only propose them" (REQ-0060#AC3). `chat_prompt.md` lists `decisions` in the op
  format and says decisions need `title`, `context` and `decision`, that superseded needs
  `superseded_by`, and that they are never written directly.

## Search, CSV, drawer and MCP

Adding the kind to `KINDS` gives the generic paths (REQ-0060#AC3):

- **Search**: `Store::search`, `query::page` and `query::facets` work per kind. Free text matches
  `title`, `context` and `decision`. `query::facet_fields(Decisions)` is
  `["status", "requirements", "tags"]`, so filters such as `status:accepted` and
  `requirements:REQ-0037` work. `query::annotate` adds `_exercised` to each listed decision from
  `changes::links(...)["decisions_exercised"]`. The REST and MCP `search` tools accept
  `kind: "decisions"`.
- **CSV export**: `csvio::export` derives columns from the schema, so the header is
  `id,title,context,decision,status,requirements,superseded_by,accepted_at,tags,version`.
  `requirements` and `tags` are joined with `", "`. Import is refused (see above).
- **Record drawer**: `RecordDrawer.tsx` renders fields from the schema returned by `taxonomy`.
  For decisions it adds an **Exercised** section showing the flag, the reason and the tagged
  locations and tests (from `context`, reusing `CodeEvidence.tsx`), and *superseded by* links.
  Edit controls for decisions open a "Propose change" flow (chat) instead of saving directly.
- **MCP**: the `kind` enum in `mcp.rs` lists every kind, including `components` and
  `decisions`. The read tools (`search`, `get`, `context`, `taxonomy`) cover decisions. `context`
  on a decision returns `exercised` (its entry in the exercised report) and its lint findings.
  `verification` with `req: "DEC-0001"` returns that decision's exercised entry. The write tools
  keep the kind in their enum but return the 403 above, so agents get a clear message instead of
  a schema error.
- **REST**: `GET /api/decisions/exercised` returns the full exercised report (see below).
- **Trace**: decisions are not part of the requirement → story → eval chain, and `trace` does not
  score them.

## DEC tags in the code scan

`codetrace.rs` already parses `reqforge: implements|verifies <ids>`. The id grammar is widened
from `REQ-\d{4,}` to `(?:REQ|DEC)-\d{4,}` in the `EXPLICIT` and `ID` regexes (REQ-0061#AC1):

```
tag      := "reqforge:" ws verb ws id-list
verb     := implements | implement | impl | verifies | verify | tests | test
id-list  := id ( [\s,;]* id )*
id       := ( REQ | DEC ) "-" \d{4,} ( "#" [A-Za-z0-9_.-]+ )?
```

- `DEC-0001` tags produce `Tag { req: "DEC-0001", kind, file, line, symbol, … }`. They use the
  same struct, symbol attachment, suppression (`reqforge:off/on`, `reqforge:ignore-file`) and
  file hashes as REQ tags, so existing indexes and the code view need no format change. A
  `#fragment` on a DEC id is ignored by the exercised computation, because decisions have no
  acceptance criteria.
- In `auto` tag mode, a bare `DEC-NNNN` in a test file is a `verifies` tag, just as a bare
  `REQ-NNNN` is. In `explicit` mode, only the comment form counts.
- The quick pre-filter `line.contains("REQ-")` becomes
  `line.contains("REQ-") || line.contains("DEC-")`.
- `ids_in` (used by evidence ingest to read ids from test names) uses the widened `ID` regex, so
  a test named `[DEC-0001] writes atomically` maps to the decision.
- `verify::compute` handles DEC tags separately: a tag naming a decision that does not exist is
  added to the `unknown` tag list (`<component>:<file>:<line> tags unknown DEC-0099`); other DEC
  tags are skipped, so they never show up as requirement tags. The per-component summary counts
  only `REQ-` ids under `requirements`.

## Exercised computation

New module `server/src/decisions.rs`:

- `compute(src, indexes, latest) -> Value` builds the report from the decisions in `src`, the
  code indexes and the latest evidence.
- `report(store) -> Arc<Value>` memoises `compute` on the store (repository, code index and
  evidence state). It backs `GET /api/decisions/exercised`, MCP `verification`/`context`, the
  `_exercised` list annotation and the UI.

### Evidence for decisions

`evidence::ingest` needs no new branch. A test case matched through a DEC tag (by symbol and
file, or by an id in its name) is stored with `target = "DEC-0001"`,
`source = "test:<component>:<file>::<name>"` and `hashes` for the test file and the files tagged
`implements DEC-0001`. Suspect detection therefore works exactly as it does for requirements.

### Rule (REQ-0061#AC2)

For each decision `D`:

1. `implements` = tags with `req == D` and `kind == "implements"` across all component indexes.
2. `tests` = tags with `req == D` and `kind == "verifies"`.
3. For each test tag `t`, take the evidence in `latest` with `target == D` that comes from that
   tag (`from_tag`: the source's component and file match the tag, and the test name matches its
   symbol). Its status is:
   - `failing`: any matching evidence failed.
   - `passed`: some passing evidence has all its file hashes equal to the current index hashes.
   - `suspect`: there is passing evidence, but none of it is fresh (a vouched-for file changed).
   - `pending`: there is no evidence yet (the tagged test is untested).
4. `exercised = !implements.is_empty() && !tests.is_empty() && tests.iter().all(|t| t.status == "passed")`.

So a decision is exercised only when there is implementing code, **at least one** tagged test,
and every tagged test has fresh passing evidence. No tagged test, or any failing, suspect or
pending tagged test, makes it `no`.

`reason` is empty when exercised, otherwise it names the first rule that failed:

| Case | `reason` |
|------|----------|
| no implements tag | ``no code is tagged `reqforge: implements DEC-0001` `` |
| no tagged test | `no test is tagged with DEC-0001` |
| a test not passed | `tagged tests without fresh passing evidence: tests/store.rs:12 suspect, tests/x.rs:40 pending` |

Output:

```json
{
  "summary": {"decisions": 3, "exercised": 1},
  "decisions": {
    "DEC-0001": {
      "id": "DEC-0001", "title": "…", "status": "accepted", "requirements": ["REQ-0037"],
      "superseded_by": null, "accepted_at": "2026-10-05T03:00:00+00:00",
      "exercised": false,
      "reason": "tagged tests without fresh passing evidence: tests/store.rs:12 suspect",
      "implements": [{"component": "server", "file": "src/store.rs", "line": 410, "symbol": "write_unlocked"}],
      "tests": [{"component": "server", "file": "tests/store.rs", "line": 12, "symbol": "atomic_write",
                 "status": "suspect", "evidence": [{"source": "test:server:tests/store.rs::atomic_write", "status": "passed", "commit": "…", "at": "…"}]}]
    }
  }
}
```

Superseded and proposed decisions are still computed; only the lint rule restricts itself to
accepted ones.

## Lint rule: decision-unexercised

`Source` gains `fn root(&self) -> Option<PathBuf>` (default `None`). `Store` returns its root and
`changes::View` carries the base store's root, so simulations judge the same code state.
`lint::lint` appends `decisions::lint_findings(src, Utc::now())`.

Rule (REQ-0061#AC3), with `decisions::GRACE_DAYS = 14`:

- If `src.root()` is `None` (a detached view), the rule emits nothing.
- Otherwise compute the exercised report from the indexes and evidence under the root.
- For every decision with `status == "accepted"` that is not exercised, take
  `since = accepted_at`, falling back to `updated`, then `created` (RFC 3339 or `YYYY-MM-DD`).
- If `now - since` is at least 14 whole days, add a `warning` with rule `decision-unexercised`,
  `ids: ["DEC-…"]` and the message `accepted 20 days ago but not exercised: <reason>`.
- Proposed and superseded decisions are never warned about. An accepted decision less than 14
  days old is not warned about yet. With no code scan nothing is exercised, so every accepted
  decision past 14 days warns with reason "no code is tagged …".

The warning shows in the lint dashboard, in `context` for the decision and on the Decisions tab.

## Decisions tab

The sidebar gets a **Decisions** tab (`view.tab === "decisions"`) that renders
`web/src/views/DecisionsView.tsx`. It joins `GET /api/decisions` (records with `_exercised`)
with `GET /api/decisions/exercised` (REQ-0061#AC4):

| Column | Source |
|--------|--------|
| Id, Title | decision record |
| Status | `status` badge: proposed / accepted / superseded (superseded rows dimmed, with "→ DEC-…") |
| Exercised | `yes` / `no` badge from `exercised`, with `reason` as the tooltip |
| Requirements | `requirements` as id chips that open the requirement drawer |
| Accepted | `accepted_at` date; a warning icon when `decision-unexercised` fires |

The tab has filters for status and exercised (yes/no) and a free-text search over title,
context and decision. Clicking a row opens the record drawer with the Exercised section. A
"Propose decision" button opens chat with a prefilled request, because decisions cannot be
created directly. The e2e suite `decisions` (eval E2, `node web/e2e/run.mjs --suite decisions`)
seeds decisions, tags and evidence, then checks the columns and badges.

## Tests

Eval E1 (`server/tests/decisions.rs`, `cargo test --test decisions`) covers:

- Required fields, the default status and `accepted_at` stamping (REQ-0060#AC1).
- An unknown requirement, superseded without `superseded_by`, self-supersession and a two-step
  cycle created inside one changeset (REQ-0060#AC2).
- 403 on direct create/update/delete/CSV import. Decisions are found by search, appear in CSV
  export, `context` and MCP `get`/`search`/`verification`, and the chat session can only propose
  (REQ-0060#AC3).
- DEC implements/verifies tags in comment and auto forms (REQ-0061#AC1).
- The exercised flag with passing, failing, suspect (file changed after passing) and pending
  tests, with no implements tag, and with implementing code but **no tagged test** (not
  exercised) (REQ-0061#AC2).
- The lint warning for a decision accepted 20 days ago, none for one accepted 13 days ago, and a
  warning for the latter once its 14 days are up; an explicit `accepted_at` is kept
  (REQ-0061#AC3).

## Open questions

- **Grace period.** The 14-day period is a constant. A `decision_grace_days` project config key
  could be added later if teams need a different period.
- **Clearing `accepted_at`.** Re-proposing an accepted decision keeps its old `accepted_at`. It
  does not affect the lint (only accepted decisions are checked, and re-accepting re-stamps), but
  a later change could clear it on the way back to `proposed`.
