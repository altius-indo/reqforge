---
name: evaluate
description: Run evals on the requirement-to-story map — deterministic traceability gate plus an LLM-judge review of every requirement→story→eval link — and write a dated report. Pass "fix" to let the evaluator apply unambiguous repairs.
argument-hint: "[fix]"
---

# /reqforge:evaluate: traceability evaluation

1. Launch **traceability-evaluator**. Pass `fix: true` only if `$ARGUMENTS` contains "fix".
2. Relay its verdict to the user: PASS/FAIL, the deterministic score, the semantic score, the top risks, and the report path (`reports/trace-review-<date>.md` in the requirements repo).
3. If the verdict is FAIL and fix wasn't requested, offer the choices with AskUserQuestion: apply safe fixes (Recommended) / re-plan affected stories with `/reqforge:plan <ids>` / leave as is.
