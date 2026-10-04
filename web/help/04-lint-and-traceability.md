---
id: lint-and-traceability
title: Lint and traceability
tabs: lint, trace
keywords: lint, findings, rule, severity, mece, duplicate, gap, taxonomy, trace, traceability, coverage, gate, ci, score, checks
---
**Lint** checks the requirements themselves (MECE, measurable wording, duplicates, taxonomy gaps). **Traceability**
checks the chain requirement → story → task → eval — the same gate CI runs.

### Work through lint findings

1. Open the **Lint** tab. The cards show the overall verdict (**OK** or **ERRORS**), the error, warning and info counts
   for the whole repository, and the taxonomy gaps.
2. Click a rule chip under **Rules:** to show only that rule's findings; click it again to show all rules.
3. Pick *error only*, *warning only* or *info only* in the severity menu to narrow further.
4. Click a type or category in the sidebar tree to scope the findings to that part of the taxonomy. The line above the
   table reads *N findings in* the current scope.
5. Click an id in the *records* column to open the requirement and fix it in the drawer.
6. Click **Ask Claude to fix these** to have Claude group the visible findings by root cause and propose a changeset.

### Check traceability

1. Open the **Traceability** tab. The first card shows the CI gate verdict (**PASS** or **FAIL**) and its score.
2. Read the coverage cards: *requirements → stories* and *criteria → evals*, plus the record counts.
3. Click the *requirements → stories* card to list the requirements that no story realises.
4. In the checks table, click the failure count of a failing check to expand its failures; ids in them open the
   record.
5. Click **Ask Claude to fix gaps** to get a changeset that remaps or fills the most important gaps.
