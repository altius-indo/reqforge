---
id: verification-and-impact
title: Verification evidence and impact
tabs: verification
keywords: verification, verify, evidence, ingest, junit, results, ci, scan, tags, verified, pending, untested, suspect, failing, impact, diff, base ref, code
---
Verification follows each acceptance criterion all the way to code: requirement → criterion → tagged test or eval →
CI result → implementing code. A criterion is **verified** when its latest result passed and the code it vouched for
has not changed since.

### Read the verification dashboard

1. Open the **Verification** tab. The cards show the verification gate (**PASS** or **FAIL**), the share of criteria
   verified, the requirements with tagged code and the number of evidence results.
2. The *Acceptance criteria* and *Requirements* bars count each status: **verified**, **pending** (tests or evals
   exist but no result was ingested), **untested** (no tagged test or covering eval), **suspect** (passed, but a file
   it vouched for changed since) and **failing** (the latest result failed).
3. Click a status count to list the requirements with that status on the Requirements tab.
4. Expand a failing gate check at the bottom to see its findings.

### Scan the code for trace tags

1. Make sure the project has at least one code component (see *Code components*).
2. Click **Scan now** to scan every component, or **Scan** on one component's row.
3. The components table then shows the scanned commit, the time of the scan, the tagged files and how many
   `implements` and `verifies` tags were found.

### Ingest CI results as evidence

1. Click **Ingest results**.
2. Click the file picker and choose one or more JUnit XML files (pytest, Jest, …) or reqforge eval reports (JSON).
3. Optionally pick the component, the commit the results belong to (default: the scanned commit) and the CI run URL.
4. Click **Ingest**. The dialog reports how many test cases were read and matched; unmatched cases have no
   requirement id in their name and no tagged test.
5. Click **Close**: the dashboard and the requirements' verification badges update.

### See one requirement's evidence

1. Open a requirement from any list and switch to the **Code & evidence** tab of the drawer.
2. Read **Implemented by** (tagged code locations) and, per acceptance criterion, its tagged tests, covering evals and
   latest evidence.
3. Files listed under *Changed since the evidence was recorded* must be re-tested to clear a **suspect** status.

### Analyse the impact of a code change

1. Under **Impact of a code change**, pick the component and enter the base ref (default `main`).
2. Click **Analyse changes**. reqforge diffs the component's local checkout, including uncommitted changes, against
   the base ref.
3. Read the changed files, the requirements touched, the tests to re-run, the evals and the criteria at risk.
4. For files listed under **Untraced changes**, click **Ask Claude to trace these** to get the missing trace tags
   proposed.
