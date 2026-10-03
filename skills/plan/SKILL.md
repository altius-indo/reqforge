---
name: plan
description: Turn the stored requirements into epics, stories and typed tasks (design / code / deployment / monitoring) with evals designed into every story from the start, then gate the result with the traceability check. Use after /reqforge:elicit, or when requirements change.
argument-hint: "[requirement query, e.g. tags:checkout — default: all proposed/approved]"
---

# /reqforge:plan: requirements to delivery plan with built-in evals

Scope: `$ARGUMENTS`, a search query over requirements. When empty, use `status:proposed|approved`.

1. `config` and `search` requirements in scope. If none exist, stop and suggest `/reqforge:elicit`. If some are `draft`, list them and ask with AskUserQuestion: include drafts / skip drafts (Recommended) / stop and refine.
2. Launch **delivery-planner** with the scope query. It writes epics, stories and tasks, and fixes the structural trace failures.
3. Launch **eval-designer** on the stories the planner created or touched. If a code repository exists (the current working directory, or one the user names), tell eval-designer where it is so the eval commands match the real toolchain.
4. `trace`. If it fails, send each failing check back to the responsible agent: coverage and tasks to delivery-planner; evals, criteria and quality-eval failures to eval-designer. Stop after 2 repair rounds, or once it passes.
5. `sync`.
6. Report: an epic → story → task outline with counts by task kind, the eval count by stage, the trace result (PASS/FAIL, requirement coverage, criteria coverage), and next steps: `/reqforge:evaluate` for the semantic review, `/reqforge:cicd` to generate the pipeline, and `/reqforge:ui` to browse and edit.
