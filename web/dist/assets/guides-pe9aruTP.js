var e=Object.assign({"../../../help/01-browse-and-filter.md":`---
id: browse-and-filter
title: Browse and filter
tabs: requirements, epics, stories, tasks
keywords: list, search, tree, category, facet, filter, sort, page, crumbs, children, export, csv, sidebar, panel, resize, collapse, width
---
Every record list (Requirements, Epics, Stories, Tasks, Components) shares the same toolbar, table and sidebar.
Filters combine: the tree, the facet chips and the search box all narrow the same list.

### Find requirements with the category tree

1. Open the **Requirements** tab in the header.
2. In the left sidebar under **Categories**, click a requirement type (for example *quality*). Its categories expand,
   each with a coverage bar showing how many of its requirements are linked to stories.
3. Click a category to show only its requirements. The breadcrumb above the table reads *All requirements › type ›
   category*.
4. A category marked **gap** has no requirement and no waiver; **waived** means the gap was accepted on purpose.
5. Click **All requirements** in the breadcrumb (or in the tree) to clear the drill-down.

### Search and filter

1. Type words into the search box above the table and press **Enter**.
2. Narrow by field with \`field:value\` tokens, for example \`status:approved\`, \`tags:pci\`, \`priority:must\` or
   \`parent:\` followed by a requirement id. Separate alternatives with \`|\`, as in \`status:draft|proposed\`.
3. Click a facet chip in the sidebar (status, priority, tags, …) to add it as a filter; click it again to remove it.
   On the Requirements tab, the **Traceability** chips show requirements *Not linked to a story* or *Linked*, and the
   **Verification** chips filter by verification status.
4. Each active filter appears as a pill next to the breadcrumb. Click the **×** on a pill to remove that filter.

### Sort, page and drill into children

1. Click a column header to sort by it; click again to reverse the order. An arrow marks the sorted column.
2. Use **Prev** / **Next** in the pager to move between pages, and its page-size menu to show 50, 100, 250 or 500
   rows per page. The pager also shows the range and the total, for example *1–100 of 3,040*.
3. On the Requirements tab, a red **0** in the *stories* column means no story realises that requirement.
4. Click the **▸** count in the *children* column to list that requirement's children.
5. Click any row to open the record drawer (see *Edit and bulk update*).

### Export the current view

1. Set up the filters and search you want.
2. Click **Export CSV**: the download contains exactly the rows that match the current view.

### Make room: collapse or resize the side panels

On wide screens you can give the list, the sidebar or the chat the space you need.

1. Click the **collapse** button at the top of the sidebar to shrink it to a narrow rail; click the rail's **expand**
   button to bring it back. Close the chat with its **×**; **Chat with Claude** in the header reopens it. The list
   takes the freed width.
2. Drag the inner edge of the sidebar (200–480 px) or the chat panel (320–720 px) to resize it. The list always keeps
   at least 480 px.
3. From the keyboard, Tab to the edge, then use the **arrow keys** (16 px a step), **Home** / **End** for the
   smallest / largest width, and **Enter** to collapse.
4. Double-click an edge to restore its default width (270 px sidebar, 410 px chat).

Widths and collapsed panels are remembered in this browser across reloads and projects. On narrow screens the
sidebar stays a slide-out sheet (the **☰** button) and the chat opens full-screen.
`,"../../../help/02-edit-and-bulk-update.md":`---
id: edit-and-bulk-update
title: Edit and bulk update
tabs:
keywords: drawer, record, create, new, save, delete, conflict, version, bulk, select, tags, dry run, import, csv, links, impact
---
Records are edited one at a time in the record drawer, or many at once with the bulk bar. Every save is versioned and
committed to the project's git repository.

### Edit one record

1. Click a row in any list to open the record drawer on the right. Its title shows the id and version, for example
   *v3*.
2. On the **Details** tab, change the fields. The form is generated from the record schema: list fields are
   comma-separated, and acceptance criteria and evals are JSON lists.
3. Click **Save**. A toast confirms the new version and the list refreshes.
4. If someone else saved the record after you opened it, the save is refused as a conflict: close the drawer, reopen
   the record to load the latest version, and edit again.
5. Press **Esc** or click **×** to close the drawer without saving.

### Create or delete a record

1. On the list for the kind you want, click **New**. The drawer opens with an empty form.
2. Fill in the required fields (marked **\\***) and click **Create**.
3. To delete, open the record and click **Delete**, then **Click again to delete** to confirm.

### Review links and impact

1. Open a requirement and switch to the **Links & impact** tab.
2. Read the stories, tasks, evals and components that realise it, its parent and children, and which acceptance
   criteria each eval covers. Criteria *not covered by any eval* are shown in red.
3. Check the **Lint** list at the bottom for findings on this requirement.
4. Click any id to open that record in the drawer.

### Update many records at once

1. Tick the checkbox at the start of each row you want, or the checkbox in the header to select the whole page.
2. To act on every match of the current filters, click **Select all … matching** in the bulk bar.
3. In the bulk bar, choose the field, the mode (**set to**, **add to list** or **remove from list** — the list modes
   work on list fields such as tags) and the value.
4. Click **Dry run** to see how many records would change without writing anything.
5. Click **Apply** to write the change. Click **Clear** to drop the selection.

### Import from CSV

1. Click **Export CSV** to download the current view, and edit it in a spreadsheet (columns are field names).
2. Click **Import CSV** on the same list and pick the edited \`.csv\` file.
3. Rows with an existing id are updated; rows without one are created. A toast reports both counts.
`,"../../../help/03-chat-and-changesets.md":`---
id: chat-and-changesets
title: Chat and changesets
tabs: changes, chat
keywords: claude, chat, ask, assistant, changeset, apply, reject, revise, stale, pending, choices, operations, mece, sync
---
Claude never edits records directly. It proposes a **changeset** — a batch of create, update and delete operations —
that you review and apply. Applying writes the whole batch atomically as one git commit.

### Ask Claude for a change

1. Click **Chat with Claude** in the header. The chat panel opens on the right; the dot next to *Claude* is green when
   the \`claude\` CLI is available on the server.
2. Leave **include view & selection** ticked to send your current tab, filters and selected rows as context.
3. Describe what you want — add, refine, merge or remove requirements — and press **Enter** (Shift+Enter adds a new
   line), or click **Send**.
4. When Claude asks a question with options, click an option button (or tick several and click **Send** for a
   multi-choice question).
5. Click **Stop** to interrupt a running turn, and **New** to start a fresh conversation.

Shortcuts: **Ask Claude about this view** on a list, **Ask Claude** in the record drawer or the bulk bar, and the
*Ask Claude…* buttons on the Lint, Traceability and Verification tabs prefill the chat with a ready-made prompt.

### Review and apply a changeset

1. A proposal appears as a changeset card in the chat. Read its verdicts: **valid**, **MECE holds**, the traceability
   result before → after, taxonomy gaps and lint errors before → after.
2. Read the operations. Untick an operation's checkbox to leave it out of the apply.
3. Check **Impact** for the stories, tasks, evals and components the change touches, and any listed risks.
4. Click **Apply** to write it (disabled while the changeset is invalid), **Ask to revise** to send feedback to
   Claude, or **Reject** to discard it.
5. After you apply, Claude follows up to verify the result.

### Find changesets later

1. Open the **Changes** tab. Its badge counts the pending changesets.
2. Click a row to open its changeset card and apply or reject it from there.
3. A changeset becomes **stale** when the records it touches were edited after it was proposed; ask Claude for a
   fresh one.
4. Click **Sync** in the header to commit, pull and push the project repository.
`,"../../../help/04-lint-and-traceability.md":`---
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
`,"../../../help/05-verification-and-impact.md":`---
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
   \`implements\` and \`verifies\` tags were found.

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

1. Under **Impact of a code change**, pick the component and enter the base ref (default \`main\`).
2. Click **Analyse changes**. reqforge diffs the component's local checkout, including uncommitted changes, against
   the base ref.
3. Read the changed files, the requirements touched, the tests to re-run, the evals and the criteria at risk.
4. For files listed under **Untraced changes**, click **Ask Claude to trace these** to get the missing trace tags
   proposed.
`,"../../../help/06-code-components.md":`---
id: code-components
title: Code components
tabs: components
keywords: component, code, checkout, path, globs, repository, language, tag mode, owners, story component, trace tags
---
A **component** is a code checkout — a service, module or package — whose source files carry trace tags. Stories name
the component that delivers them, and the Verification tab scans components for tags.

### Add a component

1. Open the **Components** tab and click **New**.
2. Fill in **title** and **key** (lower-case letters, digits, \`.\`, \`_\` or \`-\`, for example \`web\`). Stories refer to the
   component by this key.
3. Set **path** to the local checkout, absolute or relative to the requirements repository, and optionally
   **repo_url**.
4. Set **globs** (comma-separated) to choose which files to scan, for example \`src/**, tests/**\`.
5. Choose **tag_mode**: *auto* also counts requirement ids that appear in test files; *explicit* counts only
   \`reqforge: implements\` and \`reqforge: verifies\` comments, for code that mentions ids as data.
6. Click **Create**.

### Tag code and tests

1. Above the code that implements a requirement, add a comment \`reqforge: implements\` followed by the requirement id.
2. Above a test, add \`reqforge: verifies\` followed by the criterion, written as the requirement id, \`#\` and the
   criterion id, or put the criterion in the test's name.
3. Open the **Verification** tab and click **Scan now** to pick up the tags.

### Link stories to a component

1. Open a story in the drawer.
2. In the **component** field, pick one of the suggested component keys. A warning appears if the key is not a defined
   component.
3. Click **Save**.
`,"../../../help/07-projects.md":`---
id: projects
title: Projects
tabs: projects
keywords: project, workspace, switch, switcher, create, import, rename, default, delete, github, repository, key, onboarding
---
A **project** is a git repository holding one product's requirements, plan, changesets and session notes. Each project
has a short key such as \`SHOP\` that appears in links (\`#/p/SHOP\`) and on the command line.

### Switch projects

1. Click the project name next to *reqforge* in the header to open the project switcher.
2. Click a project to open it. Each entry shows its requirement count; a star marks the default project.
3. Use the browser's back and forward buttons to return to the previous project.

### Create a project

1. Open the switcher and choose **New project…**, click **New project** on the projects page, or click
   **Create project** on the first-run screen.
2. Enter a **Key**: 2–16 characters, starting with a letter. It is upper-cased as you type and must not already exist.
3. Enter a **Name**.
4. Optionally enter a GitHub repository as \`owner/name\` and tick or untick **Private repository**: the server creates
   it with the \`gh\` CLI and pushes to it. Leave it empty for a local-only repository; you can add a remote later.
5. Click **Create project**. The new project opens.

### Import an existing repository

1. Click **Import** on the projects page or **Import existing repository** on the first-run screen (or switch the
   create dialog to its **Import existing repository** tab).
2. Enter the absolute path of an existing reqforge repository on the server (it has a \`reqforge.json\`). It is
   registered in place, not copied. The key defaults to the repository's own key unless you enter one.
3. Click **Import**.

### Manage projects

1. Open the switcher and choose **Manage projects** to open the projects page.
2. Click **Open** to work in a project, **Rename** to change its display name (the key stays the same), or
   **Make default** to choose the project opened when there is no last-used one.
3. To delete a project, click **Delete**, type its key to confirm, and decide whether to also delete its GitHub
   repository. Deletion removes the directory and its git history and cannot be undone.
4. Click **Back to** followed by the project key to return to the project you were working in.

In single-repository mode (the server was started with \`--repo\`), the projects page is read-only.
`,"../../../help/08-design.md":`---
id: design
title: Design documents
tabs: design
keywords: design, spec, specification, architecture, how it is built, realises, markdown, design directory, slug
---
The **Design** tab shows how the system is built: design documents kept in the requirements repository, each linked
to the requirements it realises. Read them here instead of reading the code.

### Read a design document

1. Open the **Design** tab in the header.
2. Pick a document from the list on the left; documents are listed by title, in file-name order.
3. Read the document on the right. Under its title, **Realises** lists the requirements it builds.
4. Click any record id, in the **Realises** list or in the text, to open that record in the drawer.

### Find the design behind a requirement

1. Open the requirement in the drawer and choose the **Links & impact** tab.
2. Under **Design documents**, click a document's title to open it on the **Design** tab.

### Add a design document

1. In the requirements repository, create a Markdown file \`design/<slug>.md\`. The slug is lower-case letters, digits
   and \`-\`, starting with a letter or digit, for example \`api\`.
2. Start the file with front matter between \`---\` lines: \`title:\` and \`realises:\`, the list of requirement ids the
   document realises (written as \`REQ-…\`).
3. Write the body in GitHub-flavoured Markdown: headings, lists, tables and code blocks all render.
4. Commit the file (or click **Sync**), then open the **Design** tab. **Lint** reports any \`realises\` id that is not
   an existing requirement.
`,"../../../help/09-decisions.md":`---
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

A decision is exercised when at least one code location carries the comment \`reqforge: implements DEC-NNNN\`, at
least one test is tagged with the same id, and every such test has fresh passing evidence.

1. Tag the code that relies on the decision, and tag its tests, as you do for requirements.
2. Scan the component and ingest the CI results on the **Verification** tab.
3. **Lint** warns about every accepted decision that is still not exercised 14 days after it was accepted.

### Record or change a decision

Decisions change only through changesets; the drawer shows a decision's fields but cannot save them.

1. Open the decision in the drawer and click **Ask Claude**, or describe the decision in the chat.
2. Review the changeset Claude proposes and apply it on the **Changes** tab.
`});function t(e,t){let n=t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/),r={};for(let e of(n?.[1]??``).split(/\r?\n/)){let t=e.indexOf(`:`);t>0&&(r[e.slice(0,t).trim()]=e.slice(t+1).trim())}let i=(n?.[2]??t).trim(),a=e.split(`/`).pop()??e,o=r.id||a.replace(/^\d+-/,``).replace(/\.md$/,``),s=r.title||o,c=r.keywords||``;return{id:o,title:s,tabs:(r.tabs||``).split(`,`).map(e=>e.trim()).filter(Boolean),keywords:c,body:i,haystack:`${s}\n${c}\n${i}`.toLowerCase(),file:a}}var n=Object.entries(e).sort(([e],[t])=>e.localeCompare(t)).map(([e,n])=>t(e,n));function r(e){return(n.find(t=>t.tabs.includes(e))??n[0])?.id??``}function i(e){let t=e.toLowerCase().split(/\s+/).filter(Boolean);return t.length?n.filter(e=>t.every(t=>e.haystack.includes(t))):n}export{n as GUIDES,i as searchGuides,r as sectionFor};