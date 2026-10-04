---
name: verify
description: Validate requirements all the way to code. Scan trace tags in code and tests, ingest CI results as evidence, and report each acceptance criterion as verified, pending, untested, suspect or failing, with the code locations. Pass "impact" to analyse the current code change instead.
argument-hint: "[impact | <REQ-id> | path/to/junit.xml ...]"
---

# /reqforge:verify: requirement → test → evidence → code

1. `config` and `search` components. If there are none, ask with AskUserQuestion which code repos to register: the current directory (Recommended), another path, or skip. Create each one as a `components` record with `key`, `path`, `globs` and `repo_url` (derive these from `git remote get-url origin`). Fix any story whose `component` doesn't match a key.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/reqforge scan` (MCP `scan_code`) to index the trace tags.
3. If `$ARGUMENTS` names result files (JUnit XML, `reqforge-reports/evals-*.json`), ingest them with `reqforge evidence ingest <files> -c <component> --commit $(git rev-parse HEAD)`. Otherwise mention that CI ingests evidence automatically (see `/reqforge:cicd`).
4. If `$ARGUMENTS` is "impact": run `reqforge impact -c <component> --md` (MCP `impact`). Show the requirements the current change touches, the tests to re-run (`--select-tests`), and the criteria at risk. Stop here.
5. Otherwise call `verification`, or `verification` with `req` if `$ARGUMENTS` is a requirement id. Report:
   - criteria counts by status and the gate result;
   - **failing**: the test or eval that failed, its commit and run;
   - **suspect**: which changed files invalidated which passing results; re-running those tests restores verification;
   - **untested**: criteria with no tagged test and no eval. Offer to have eval-designer add tests, or to tag existing tests that already prove them. Read the candidate test first, and only tag tests that really assert the criterion;
   - tag problems: unknown requirement ids, tags on deprecated requirements, eval coverage that doesn't match the tags in its test files.
6. Offer the fix as a changeset, or as code edits that add tags, as appropriate. Never mark a requirement verified by hand: status comes from evidence.
