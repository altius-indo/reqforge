---
name: elicit
description: Turn a simple requirement into a researched, MECE, classified requirement set — parallel standards research, multiple-choice clarifying questions to the user, adversarial MECE review — and store it in the GitHub-backed reqforge repository. Use when the user states a new need, feature, product idea or raw requirement.
argument-hint: "<the requirement in plain words>"
---
<!-- reqforge: implements REQ-0001 -->

# /reqforge:elicit: research-backed requirement elicitation

Input: `$ARGUMENTS`, the user's raw requirement. If it's empty, ask for it in one line.

You run this loop in the main session because only the main session can ask the user questions. Subagents do the research, drafting and review. Persist everything through the reqforge MCP tools (`taxonomy`, `search`, `upsert_many`, `config`, `save_session`, `lint`, `sync`). If the MCP server isn't connected, use the CLI at `${CLAUDE_PLUGIN_ROOT}/bin/reqforge` (`--help`). Its subcommands mirror the MCP tools.

## 0. Repository
Call `config`. If it errors with "no reqforge repository", run `/reqforge:init` first, then continue.

## 1. Frame (no questions yet)
Restate the need in 2–3 sentences: actor, outcome, context. Infer domain, likely users, region and scale. Call `search` on requirements for key terms, so you know what already exists and can extend it instead of duplicating it.

## 2. Research: fan out in parallel
Launch `standards-researcher` subagents **in one message**, one per relevant slice. Pick 3–6 of:
domain & regulation · security & privacy · quality attributes / NFRs · operations & reliability · data · integration & interfaces · UX & accessibility.
Give each the raw requirement, its slice, and what you inferred in step 1. Skip slices that clearly don't apply, and say which you skipped and why.

## 3. Draft
Launch `requirements-analyst` with the raw requirement, all research output verbatim, the existing related requirement ids, and the session id you'll use (reserve one now: `save_session` with the title and a stub body; it returns `ELI-NNNN`). It returns JSON: requirements, `not_applicable`, decisions.

## 4. Ask: multiple-choice rounds
Turn the analyst's `decisions` into **AskUserQuestion** calls:
- Up to 4 questions per call, 2–4 options each, `header` ≤ 12 chars. Recommended option first, labelled "(Recommended)". Each option's `description` gives the trade-off and the standard or source behind it. Use `multiSelect` only for non-exclusive choices. The user can always pick "Other".
- Ask the highest-impact decisions first. After each round, call `requirements-analyst` again with the answers. It folds them in and may raise follow-ups.
- Stop when no must-priority requirement is blocked on a decision, or after 4 rounds. If you stop on the round limit, record the remaining decisions as assumptions and tell the user which defaults you took.
- Never ask what research or the code already answers. Never ask open-ended questions when a choice list would do.

## 5. MECE review
Launch `mece-reviewer` on the current draft JSON. Apply its `fixes` and `new_requirements` yourself. Any `questions_for_user` go through one more AskUserQuestion round. Repeat the review once if the verdict was `revise`.

## 6. Confirm
Show the user a compact table: key · type/category · priority · title, grouped by type, plus the `not_applicable` list. Ask one AskUserQuestion: **Save as proposed (Recommended)** / Save as approved / Revise first. On "Revise first", take their edits and loop back to step 5.

## 7. Persist
- `upsert_many` kind `requirements` with the final rows. Map `parent_key` to ids: write parents first, then children with `parent` set to the returned ids. Set `source` to the ELI id and `status` to what the user chose. For rows with an `existing_id`, include `id` so they patch instead of duplicating.
- `config` patch `coverage_waivers` with `not_applicable`, merged with the existing waivers.
- `save_session` (same id) with the full transcript in markdown: the raw request; framing; research findings per slice, with source URLs; every question with options and the user's answer; assumptions; the review fixes applied; the ids created.
- `lint`. Fix any `error` findings, then report the warnings.
- `sync` to push to GitHub.

## 8. Report
Ids created or updated, counts by type, lint status, the session id, and the next step: `/reqforge:plan` to produce epics, stories and tasks.
