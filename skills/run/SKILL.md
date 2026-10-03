---
name: run
description: End-to-end pipeline from one plain-language requirement to a stored MECE requirement set, a delivery plan with evals, a traceability evaluation and a generated CI/CD pipeline — pausing only for the user's multiple-choice decisions.
argument-hint: "<the requirement in plain words>"
---

# /reqforge:run: requirement to pipeline

Run these in order, carrying context forward. Stop at the first stage that fails and report it.

1. `/reqforge:elicit $ARGUMENTS` (follow that skill fully, including its question rounds).
2. `/reqforge:plan source:<the ELI id from step 1>` to plan just this session's requirements. If the user approved the set as `proposed`, include proposed.
3. `/reqforge:evaluate`
4. If a code repository is the current directory, run `/reqforge:cicd`. Otherwise ask the user for one, or skip.

Final report: one line per stage with its result, the ids created, the trace verdict, and the pipeline file path.
