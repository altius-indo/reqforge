---
id: decisions
title: Decisions
tabs: decisions
keywords: decision, decisions, adr, architecture decision, exercised, superseded, accepted, proposed, DEC
---
The **Decisions** tab lists the project's design decisions (DEC-NNNN) and shows which ones tested code really
relies on.

### Read the decisions

1. Open the **Decisions** tab in the header.
2. Each row shows the decision's **status** (proposed, accepted or superseded), whether it is **exercised**, and
   the **requirements** it is linked to. A decision that is not exercised says why.
3. Click a row to open the decision in the drawer on its **Exercised** tab: the code tagged as implementing it and
   every tagged test with its status (passed, suspect, failing or pending).

### Make a decision exercised

A decision is exercised when at least one code location carries the comment `reqforge: implements DEC-NNNN`, at
least one test is tagged with the same id, and every such test has fresh passing evidence.

1. Tag the code that relies on the decision, and tag its tests, as you do for requirements.
2. Scan the component and ingest the CI results on the **Verification** tab.
3. **Lint** warns about every accepted decision that is still not exercised 14 days after it was accepted.

### Record or change a decision

Decisions change only through changesets; the drawer shows a decision's fields but cannot save them.

1. Open the decision in the drawer and click **Ask Claude**, or describe the decision in the chat.
2. Review the changeset Claude proposes and apply it on the **Changes** tab.
