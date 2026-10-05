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
tagged code implements it and every test tagged with its id has passing evidence. The spec
covers the schema and file layout, the rule that decisions change only through changesets,
search, CSV, MCP and the record drawer, the `DEC` tag grammar in the code scan, how the
exercised flag is computed from evidence, the 14-day lint rule and the Decisions tab.

It builds on the existing code: `server/src/model.rs` (kinds and schemas), `server/src/store.rs`
(writes), `server/src/changes.rs` (changesets), `server/src/codetrace.rs` (code scan),
`server/src/evidence.rs` and `server/src/verify.rs` (evidence and status), `server/src/lint.rs`,
`server/src/csvio.rs`, `server/src/mcp.rs` and `web/src`. TASK-0046 builds the record kind and
DEC tags. TASK-0047 builds the Decisions tab.

## Realised requirements

| Id | Title | How / where realised |
|----|-------|----------------------|
| REQ-0060 | Decision records | New `Kind::Decisions` with schema `DECISIONS` in `model.rs`. Validation is in `model::validate` plus `model::decision_errors`. Writes are refused outside changesets in `Store`. The kind is added to `KINDS`, so search, CSV export, the drawer and the MCP read tools pick it up. |
| REQ-0061 | Decisions exercised by code | The `codetrace` ID regex accepts `DEC-NNNN`. Evidence targets `DEC-NNNN`. New `decisions::exercise` computes the flag. Lint rule `decision-unexercised` warns after 14 days. A Decisions tab is added in `web/src/views/DecisionsView.tsx`. |

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
| decisions | `DEC` | `decisions/` | decision | `decisions`, `decision`, `dec`, `decs` |

`KINDS` becomes `[Requirements, Epics, Stories, Tasks, Components, Decisions]`. `Kind::of_id`
then resolves `DEC-0001` with no extra code. As for other kinds, each record is one file,
`requirements/decisions/DEC-NNNN.json`. It is written by `Store::write_unlocked` (temp file, then
rename), and ids are allocated by `next_id` (max existing + 1, four digits minimum).

Schema `DECISIONS` (REQ-0060#AC1):

| Field | Type | Required | Values / default |
|-------|------|----------|------------------|
| title | str | yes | |
| context | text | yes | The forces and constraints behind the decision |
| decision | text | yes | What was decided |
| status | enum | | `proposed`, `accepted`, `superseded`; default `proposed` |
| requirements | reflist -> requirements | | Each id must exist |
| superseded_by | ref -> decisions | | Required when `status` is `superseded` |
| consequences | text | | Optional; not required by REQ-0060 |
| tags | list | | |

`title`, `context` and `decision` are `req(...)` fields, so `model::validate` reports
`<field>: required` when they are missing or empty. `status` uses
`en("status", DECISION_STATUSES, Some("proposed"))`, so `model::defaults` fills in `proposed`
and any other value fails with the usual enum error.

### The `accepted` timestamp

The 14-day rule needs to know when a decision was accepted. Decisions carry an extra
system-managed field, `accepted`, in the same UTC form as `created`/`updated`.
`DECISION_SYSTEM_FIELDS = ["accepted"]` is merged into `is_system` for this kind, so clients
cannot set it. `changes::materialize` maintains it when it builds the post-op record:

- When status moves from anything else to `accepted`, `accepted` is set to `store::now()`.
- When status moves from `accepted` back to `proposed`, `accepted` is removed.
- When status moves from `accepted` to `superseded`, `accepted` is kept.

Because `materialize` sets it, simulations and the applied record agree. If an accepted record
has no `accepted` field (for example, a hand-edited file), the lint falls back to `updated`.

Example `requirements/decisions/DEC-0001.json`:

```json
{
  "id": "DEC-0001",
  "title": "Store one JSON file per record",
  "context": "Records must diff cleanly in git and merge without a database.",
  "decision": "Each record is written to <kind>/<ID>.json with stable key order.",
  "status": "accepted",
  "requirements": ["REQ-0037"],
  "tags": [],
  "accepted": "2026-10-05T03:00:00+00:00",
  "version": 2,
  "created": "2026-10-05T02:50:00+00:00",
  "updated": "2026-10-05T03:00:00+00:00"
}
```

## Validation

Validation runs in `model::validate` and the kind-specific checks in `changes::materialize`,
alongside `component_key_clash` and `task_dependency_errors`. Every failure is a 422 with
per-field details (REQ-0060#AC2):

- `requirements` is a `reflist` to requirements, so the existing reference check rejects ids that
  do not exist (`requirements: REQ-9999 does not exist`).
- New `model::decision_errors(rec, &all_decisions)`:
  - If `status == "superseded"` and `superseded_by` is empty, it reports
    `superseded_by: required when status is superseded`.
  - `superseded_by` must name an existing decision (enforced by the `ref` type) other than the
    record itself (`superseded_by: a decision cannot supersede itself`).
  - If `superseded_by` is set and status is not `superseded`, it reports
    `superseded_by: only allowed when status is superseded`. This keeps the chain meaningful.
  - Cycles: the check follows `superseded_by` from the record through the post-op view of all
    decisions (so ops in the same changeset count). If it comes back to a decision already
    visited, it reports `superseded_by: supersession cycle DEC-0001 -> DEC-0002 -> DEC-0001`.
    `superseded_by` is a single ref, so the walk is linear and bounded by the number of decisions.
- `Store::references_to` iterates `KINDS` and schema ref fields. A requirement linked from a
  decision, or a decision named in another decision's `superseded_by`, therefore cannot be
  deleted without `force`. A changeset that deletes one shows up as a dangling reference in
  simulation.

## Changesets only

REQ-0060 requires that decisions are created and changed only through changesets.
`Kind::changeset_only(self) -> bool` returns true for `Decisions`. The public `Store` write
methods `create`, `update`, `bulk_update`, `upsert_many` and `delete` return
`StoreError::new("decisions change only through changesets", 403)` for such kinds.
`changes::apply` writes with `Store::write_unlocked` and removes files directly, so it is the
only write path. As a result:

- REST `POST/PATCH/DELETE /api/decisions[/…]`, CSV import (`/api/decisions/import`,
  `reqforge import decisions`) and the MCP `create`, `update`, `upsert_many`, `bulk_update` and
  `delete` tools all fail with 403 and the message above.
- `simulate_changeset`, `propose_changeset` and `apply_changeset` accept ops with
  `"kind": "decisions"` and `DEC-` ids, as they already do for any kind in `KINDS`.
- The chat agent's tool allowlist (`chat.rs`) already excludes every direct write. It can only
  call `simulate_changeset` and `propose_changeset`, and a human applies. This satisfies "the
  chat agent can only propose them" (REQ-0060#AC3). `chat_prompt.md` gets one line saying
  decisions are proposed like any other record, with `context` and `decision` filled in.

## Search, CSV, drawer and MCP

Adding the kind to `KINDS` gives the generic paths (REQ-0060#AC3):

- **Search**: `Store::search`, `query::page` and `query::facets` work per kind. Free text matches
  `title`, `context` and `decision`. Filters use the usual tokens, for example
  `status:accepted` and `requirements:REQ-0037`. The REST and MCP `search` tools accept
  `kind: "decisions"`.
- **CSV export**: `csvio::export` derives columns from the schema, so the header is
  `id,title,context,decision,status,requirements,superseded_by,consequences,tags,version`.
  `requirements` and `tags` are comma-joined. `accepted` is a system field and is not exported.
  Import is refused (see above).
- **Record drawer**: `RecordDrawer.tsx` renders fields from the schema returned by `taxonomy`.
  For decisions it adds an **Exercised** section showing the flag, the reason and the tagged
  locations (reusing `CodeEvidence.tsx`). It also lists *superseded by* / *supersedes* links.
  The requirement drawer adds a *Decisions* list (decisions whose `requirements` contain it).
  Edit controls for decisions open a "Propose change" flow (chat) instead of saving directly.
- **MCP**: `mcp.rs` builds `kind` as an enum of every kind. The read tools (`search`, `get`,
  `context`, `taxonomy`, `trace`) gain `decisions`. The `verification` tool output gains a
  `decisions` array (see below). The write tools keep the kind in their enum but return the
  403 above, so agents get a clear message instead of a schema error.
- **Trace**: decisions are not part of the requirement → story → eval chain, and `trace` does not
  score them. `context` for a requirement lists its linked decisions.

## DEC tags in the code scan

`codetrace.rs` already parses `reqforge: implements|verifies <ids>`. The id grammar is widened
from `REQ-\d{4,}` to `(?:REQ|DEC)-\d{4,}` in the `EXPLICIT` and `ID` regexes (REQ-0061#AC1):

```
tag      := "reqforge:" ws verb ws id-list
verb     := implements | implement | impl | verifies | verify | tests | test
id-list  := id ( [\s,;]* id )*
id       := REQ-\d{4,} ( "#" [A-Za-z0-9_.-]+ )?
          | DEC-\d{4,}
```

- `DEC-0001` tags produce `Tag { req: "DEC-0001", ac: None, kind, file, line, symbol, … }`.
  They use the same struct, symbol attachment and file hashes as REQ tags, so existing indexes
  and the code view need no format change. A `#fragment` on a DEC id is dropped, because
  decisions have no acceptance criteria.
- In `auto` tag mode, a bare `DEC-NNNN` in a test file is a `verifies` tag, just as a bare
  `REQ-NNNN` is. In `explicit` mode, only the comment form counts.
- The quick pre-filter `line.contains("REQ-")` becomes `line.contains("REQ-") ||
  line.contains("DEC-")`.
- `ids_in` (used by evidence ingest to read ids from test names) uses the widened `ID` regex, so
  a test named `[DEC-0001] writes atomically` maps to the decision.
- The scan summary counts DEC tags with the rest. `verify::compute` keeps filtering tags to
  requirement ids (`starts_with("REQ-")`) for criterion status, so DEC tags never show up as
  orphan requirement tags.
- Tags naming a `DEC` id that does not exist are reported by `decisions::exercise` as
  `unknown_tags` and by lint as `dangling-decision-tag` (warning).

## Exercised computation

New module `server/src/decisions.rs` with
`exercise(src, indexes, latest) -> Vec<Value>`. It is called from `verify::compute` and
returned as `report["decisions"]`, so the REST verification endpoint, the MCP `verification`
tool and the UI all read the same result.

### Evidence for decisions

`evidence::ingest` needs no new branch. A test case matched through a DEC tag (by symbol and
file, or by an id in its name) calls `targets_for(src, "DEC-0001", None)`. Decisions are not
requirements, so this returns `["DEC-0001"]`. The record stores
`source = "test:<comp>:<file>::<name>"` and `hashes_for(indexes, "DEC-0001", test)`: the test
file plus every file tagged `implements DEC-0001`. Suspect detection therefore works exactly as
it does for requirements. Eval reports can also list `DEC-NNNN` in `covers`. This counts as
passing evidence but does not replace the per-test rule below.

### Rule (REQ-0061#AC2)

For each decision `D`:

1. `impls` = tags with `req == D` and `kind == "implements"` across all component indexes.
2. `tests` = tags with `req == D` and `kind == "verifies"`.
3. For each test tag `t`, its status comes from the evidence in `latest` with target `D` whose
   source is `test:<t.component>:<t.file>::…` and whose test name matches `t.symbol`
   (`evidence::symbol_matches`). The status values are the same as in `verify.rs`:
   - `failing`: any matching evidence failed.
   - `suspect`: there is passing evidence, but every passing record's `hashes` differ from the
     current file hashes.
   - `passing`: at least one passing record's hashes all match the current files.
   - `pending`: there is no evidence yet.
4. `exercised = !impls.is_empty() && tests.iter().all(|t| status(t) == "passing")`.

`reason` records the first rule that failed: `no implements tag`, `DEC-0001 test
server/tests/x.rs::y failing`, `… suspect`, or `… has no evidence`. A failing or suspect tagged
test always makes the flag `no`.

Following REQ-0061's statement literally, a decision with implements tags and **no** tagged
tests is exercised, because "every tagged test passes" holds when there are none. The reason
then reads `exercised (no tagged tests)` so reviewers can tell this case apart. See Open
questions.

Output, one entry per decision:

```json
{
  "id": "DEC-0001", "title": "…", "status": "accepted", "requirements": ["REQ-0037"],
  "exercised": false, "reason": "DEC-0001 test server/tests/store.rs::atomic_write suspect",
  "implements": [{"component": "server", "file": "src/store.rs", "line": 410, "symbol": "write_unlocked"}],
  "tests": [{"component": "server", "file": "tests/store.rs", "line": 12, "symbol": "atomic_write", "status": "suspect"}],
  "accepted": "2026-10-05T03:00:00+00:00"
}
```

Superseded decisions are still computed, but they are excluded from the lint rule. The tab
shows them dimmed.

## Lint rule: decision-unexercised

`lint::lint(src)` runs over a `Source` that has no code indexes. The `Source` trait gains:

```rust
/// Exercised flag per decision id, or None when no code scan is available.
fn decision_exercise(&self) -> Option<BTreeMap<String, bool>> { None }
```

`Store` implements it from `verify::report(store)["decisions"]`, which is memoised.
`changes::View` delegates to the base store's value, so simulations judge the same code state.

Rule (REQ-0061#AC3), with `DECISION_GRACE_DAYS = 14`:

- For every decision with `status == "accepted"`, compute
  `since = now - (accepted or updated)`.
- If `since > 14 days` and the exercised flag is `false` (or the decision is missing from the
  map), add a `warning` with rule `decision-unexercised`, `ids: [DEC-…]` and the message
  `DEC-0001 accepted 2026-09-01 is not exercised after 14 days: <reason>`.
- If `decision_exercise()` is `None` (no component has been scanned yet), the rule still warns
  after 14 days with the reason `no code scan`. With no scan, nothing is exercised.
- Proposed and superseded decisions are never warned about. A decision accepted less than 14
  days ago is not warned about.

The lint also adds `dangling-decision-tag` (warning) for code tags that name a nonexistent DEC
id.

## Decisions tab

The sidebar gets a **Decisions** tab (`view.tab === "decisions"`) that renders
`web/src/views/DecisionsView.tsx`. It is not the generic `ListView`, because it joins records
with the verification report (REQ-0061#AC4):

| Column | Source |
|--------|--------|
| Id, Title | decision record |
| Status | `status` badge: proposed / accepted / superseded (superseded rows dimmed, with "→ DEC-…") |
| Exercised | `yes` / `no` badge from `report.decisions[i].exercised`, with `reason` as the tooltip |
| Requirements | `requirements` as id chips that open the requirement drawer |
| Accepted | `accepted` date; shows a warning icon when the lint rule fires |

The tab has filters for status and exercised (yes/no) and a free-text search over title,
context and decision. Clicking a row opens the record drawer with the Exercised section. A
"Propose decision" button opens chat with a prefilled request, because decisions cannot be
created directly. The e2e suite `web/e2e/suites/decisions` (eval E2) seeds decisions, tags and
evidence, then checks the columns and badges.

## Tests

Eval E1 (`server/tests/decisions.rs`, `cargo test --test decisions`) should cover:

- Required fields and the default status (REQ-0060#AC1).
- An unknown requirement, superseded without `superseded_by`, self-supersession and a two-step
  cycle created inside one changeset (REQ-0060#AC2).
- 403 on direct create/update/delete/CSV import. Decisions are found by search, appear in CSV
  export and in MCP `get`/`search`, and the chat allowlist has no direct write tools
  (REQ-0060#AC3).
- DEC implements/verifies tags in comment and auto forms (REQ-0061#AC1).
- The exercised flag with passing, failing, suspect (file changed after passing) and pending
  tests, and with no implements tag (REQ-0061#AC2).
- The lint warning at 15 days and none at 13 days, using a seeded `accepted` timestamp
  (REQ-0061#AC3).

## Open questions

- **Decisions with no tagged tests.** The requirement's wording makes them exercised when they
  have implements tags. The story says "only when tested code relies on them", which suggests
  at least one tagged test should be required. This design follows the requirement and
  surfaces the case in `reason`. If the product owner wants the stricter reading, change
  REQ-0061 through a changeset and add `!tests.is_empty()` to step 4.
- **Grace period.** The 14-day period is a constant. A `decision_grace_days` project config key
  could be added later if teams need a different period.
