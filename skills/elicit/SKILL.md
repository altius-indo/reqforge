---
name: elicit
description: Turn a simple requirement into a researched, MECE, classified requirement set — parallel standards research, multiple-choice clarifying questions to the user, adversarial MECE review — and store it in the GitHub-backed reqforge repository. Use when the user states a new need, feature, product idea or raw requirement.
argument-hint: "<the requirement in plain words>"
---
<!-- reqforge: implements REQ-0001 -->
<!-- reqforge: implements REQ-0063 -->

# /reqforge:elicit: research-backed requirement elicitation

Input: `$ARGUMENTS`, the user's raw requirement. If it's empty, ask for it in one line.

You run this loop in the main session because only the main session can ask the user questions. Subagents do the research, drafting and review. Persist everything through the reqforge MCP tools (`taxonomy`, `search`, `simulate_changeset`, `propose_changeset`, `apply_changeset`, `config`, `save_session`, `lint`, `sync`). If the MCP server isn't connected, use the CLI at `${CLAUDE_PLUGIN_ROOT}/bin/reqforge` (`--help`) for the rest, and the UI's REST API (`POST /api/changesets/simulate`, `POST /api/changesets`, `POST /api/changesets/{id}/apply`) for the changeset.

## 0. Repository
Call `config`. If it errors with "no reqforge repository", run `/reqforge:init` first, then continue.

## 1. Frame (no questions yet)
Restate the need in 2–3 sentences: actor, outcome, context. Infer domain, likely users, region and scale. Call `search` on requirements for key terms, so you know what already exists and can extend it instead of duplicating it. Call `lint` and keep the `research-refuted` and `research-stale` warnings on those related requirements: the findings they cite (`RF-NNNN`, read from `research/RF-NNNN.json`) need re-checking.

## 2. Research: fan out in parallel
Launch `standards-researcher` subagents **in one message**, one per relevant slice. Pick 3–6 of:
domain & regulation · security & privacy · quality attributes / NFRs · operations & reliability · data · integration & interfaces · UX & accessibility.
Give each the raw requirement, its slice, what you inferred in step 1, and the refuted or stale findings from step 1 that belong to its slice. Skip slices that clearly don't apply, and say which you skipped and why.

Each researcher returns graded findings (`VERIFIED` / `THIN` / `REFUTED`, sources, date, `fast` / `slow` perishability; re-checks carry `supersedes`). Collect them into one list and give each a changeset ref `f1`, `f2`, … across all slices, rewriting the `F#` references in that slice's text to the new refs. Drop findings without a source URL. These refs are what requirements cite in step 3 and what becomes `RF-NNNN` in step 7.

## 3. Draft
Launch `requirements-analyst` with the raw requirement, all research output verbatim, the existing related requirement ids, and the session id you'll use (reserve one now: `save_session` with the title and a stub body; it returns `ELI-NNNN`). Pass the findings list with its refs and tell it to cite them in `standards` as `"$f3"`, and existing findings as `"RF-0012"`. It returns JSON: requirements, `not_applicable`, decisions.

## 4. Ask: multiple-choice rounds
Turn the analyst's `decisions` into **AskUserQuestion** calls:
- Up to 4 questions per call, 2–4 options each, `header` ≤ 12 chars. Recommended option first, labelled "(Recommended)". Each option's `description` gives the trade-off and the standard or source behind it. Use `multiSelect` only for non-exclusive choices. The user can always pick "Other".
- Ask the highest-impact decisions first. After each round, call `requirements-analyst` again with the answers. It folds them in and may raise follow-ups.
- Stop when no must-priority requirement is blocked on a decision, or after 4 rounds. If you stop on the round limit, record the remaining decisions as assumptions and tell the user which defaults you took.
- Never ask what research or the code already answers. Never ask open-ended questions when a choice list would do.

## 5. MECE review
Launch `mece-reviewer` on the current draft JSON. Apply its `fixes` and `new_requirements` yourself. Any `questions_for_user` go through one more AskUserQuestion round. Repeat the review once if the verdict was `revise`.

## 6. Confirm
Show the user a compact table: key · type/category · priority · title, grouped by type, plus the `not_applicable` list and a findings table: ref · grade · perishability · claim (flag every THIN and REFUTED one). Ask one AskUserQuestion: **Save as proposed (Recommended)** / Save as approved / Revise first. On "Revise first", take their edits and loop back to step 5.

## 7. Persist
- Build ONE changeset, title `<ELI id>: <short title>`, whose ops are, in order:
  1. one `{"op": "finding", "ref": "f3", "data": {claim, grade, sources, date, perishability, supersedes}, "reason": "<slice>"}` per finding. Findings are append-only: a re-check is a new finding with `supersedes` set, never an update.
  2. one `{"op": "create", "kind": "requirements", "ref": "<key>", "data": {...}}` per new row, parents before children, with `parent` set to `"$<parent_key>"`. Keep the `"$f3"` citations in `standards`; reqforge resolves them to the assigned `RF-NNNN`. Set `source` to the ELI id and `status` to what the user chose.
  3. one `{"op": "update", "id": "<existing_id>", "patch": {...}}` per row with an `existing_id`. When a re-check supersedes a finding an existing requirement cites, replace the old `RF-NNNN` in its `standards` with the new `"$f#"`.
- `simulate_changeset` and fix every error until it is valid. Then `propose_changeset`, and `apply_changeset` with the returned id: the user's choice in step 6 is the confirmation. `assigned_ids` maps each ref to its `REQ-NNNN` / `RF-NNNN`.
- `config` patch `coverage_waivers` with `not_applicable`, merged with the existing waivers.
- `save_session` (same id) with the full transcript in markdown: the raw request; framing; research findings per slice, with their `RF-NNNN` ids, grades, refresh_by dates and source URLs; every question with options and the user's answer; assumptions; the review fixes applied; the ids created.
- `lint`. Fix any `error` findings, then report the warnings (including any `research-refuted` or `research-stale` left on requirements).
- `sync` to push to GitHub.

## 8. Report
Ids created or updated, counts by type, findings recorded by grade (with the earliest refresh_by), the changeset id, lint status, the session id, and the next step: `/reqforge:plan` to produce epics, stories and tasks.
