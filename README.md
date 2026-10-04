# reqforge

A Claude Code plugin that takes a plain-language requirement and runs it all the way to an eval-driven CI/CD pipeline:

```
 "guests should be able to check out"
        │  /reqforge:elicit
        ▼
 standards-researcher ×N (parallel) ─▶ requirements-analyst ─▶ multiple-choice questions to you ─▶ mece-reviewer
        │  MECE, classified requirements (ISO 29148 form, ISO 25010 quality model) → GitHub repo
        ▼  /reqforge:plan
 delivery-planner (epics → stories → design/code/deployment/monitoring tasks) ─▶ eval-designer (evals on every story)
        │
        ▼  /reqforge:evaluate                         ▼  /reqforge:cicd
 traceability-evaluator (gate + LLM judge)     cicd-engineer → .github/workflows/reqforge-pipeline.yml
```

Work is organised into **projects** inside a **workspace** (default `~/.reqforge`). Each project is its own requirements repository: plain JSON in git, one file per record, every change a commit, optionally pushed to its own GitHub repo. You can reach it six ways, all sharing one validated store: the **agents (MCP)**, the **web UI**, the **REST API**, the **CLI**, the **console**, and **CSV** round-trips.

**Stack.** The backend is a single Rust binary (`server/`: axum + tokio). It serves the REST API, the chat bridge, the MCP server, the CLI and the console, and it embeds the web UI. The UI (`web/`) is React + TypeScript + Tailwind + shadcn/ui, built with Vite. At runtime you need `git` (plus `gh` to create GitHub repos), and `claude` for the chat. To build from source you need Rust (cargo); `bin/reqforge` builds the binary on first use. Node is only needed to change the UI: the built `web/dist` is committed and embedded.

## Install

```bash
# inside Claude Code
/plugin marketplace add /path/to/reqforge
/plugin install reqforge@reqforge-marketplace
# or for development:  claude --plugin-dir /path/to/reqforge
```

## Use (in Claude Code)

| command | what it does |
|---|---|
| `/reqforge:init [KEY]` | create a project (optionally with a GitHub repo), import one, or switch the default |
| `/reqforge:elicit <need>` | research → draft → multiple-choice question rounds → MECE review → store |
| `/reqforge:plan [query]` | epics, stories, typed tasks, evals on every story; trace-gated |
| `/reqforge:evaluate [fix]` | deterministic trace gate + LLM-judge of each requirement→story→eval link |
| `/reqforge:cicd [path]` | generate the eval-driven GitHub Actions pipeline in a code repo |
| `/reqforge:ui [port\|console]` | start web UI + REST API, or the console |
| `/reqforge:run <need>` | all of the above in sequence |

### Agents
| agent | role |
|---|---|
| `standards-researcher` | per-slice research: applicable standards (OWASP ASVS, NIST 800-63B, WCAG 2.2, PCI DSS, GDPR…), common concerns, and decisions with industry defaults, all cited |
| `requirements-analyst` | decomposes and classifies the need into "shall" statements with acceptance criteria; turns open decisions into multiple-choice questions |
| `mece-reviewer` | adversarial check for overlaps, misclassification, gaps, unverifiable statements and contradictions |
| `requirements-classifier` | puts imported or legacy requirements into the taxonomy using bulk updates |
| `delivery-planner` | requirements → epics → stories → tasks (`design`, `code`, `deployment`, `monitoring`) |
| `eval-designer` | evals per story (unit … synthetic-monitor), each covering requirement ACs, with runnable commands |
| `traceability-evaluator` | trace gate plus a semantic judge (realisation / proof / scope); writes `reports/trace-review-<date>.md` |
| `cicd-engineer` | configures and generates the pipeline, and lists the GitHub secrets and branch protection a human must set |

## Projects

A workspace (`reqforge-workspace.json` in `~/.reqforge`, `$REQFORGE_WORKSPACE`, or any directory you pass with `--workspace`) registers the projects. Each project lives at `<workspace>/<key>/` by default, and existing repositories can be imported from anywhere.

```bash
reqforge project create PAY --name "Payments" --github acme/pay-requirements
reqforge project import ../legacy-reqs --key LEGACY
reqforge project list                     # * marks the default project
reqforge project default PAY
reqforge -P PAY list req -q type:quality  # target a project explicitly (or REQFORGE_PROJECT=PAY)
reqforge project delete PAY --confirm PAY [--delete-remote]
```

**Deleting a project removes everything it holds**: its directory with all requirements, epics, stories, tasks, changesets, elicitation sessions, reports and the git history. The key must be typed to confirm. `--delete-remote` (an unchecked box in the UI) also runs `gh repo delete` on its GitHub repo; that is irreversible, and the default leaves the remote alone. Agents can list and create projects through MCP but can't delete them.

In the UI, the header has a project switcher (also deep-linkable as `#/p/KEY`) and a Projects page with create, import, rename, make-default and delete. Chat history and view state are kept per project. In the API, every route is project-scoped as `/api/p/{KEY}/…`; unscoped `/api/…` uses the default project.

`reqforge serve` runs the workspace. `reqforge serve --repo <dir>` serves a single repository; in that mode project management is disabled.

## Web UI at scale, and chat with Claude

`reqforge serve` (or `/reqforge:ui`) opens a UI built for repositories with thousands of fine-grained requirements:

- **Category tree.** The sidebar shows type → category with counts, a story-coverage bar and lint error/warning badges per cell. It marks *gap* cells (empty and not waived) and faded *waived* cells. Click to drill down; breadcrumbs and filter pills show where you are.
- **Facets.** Status, priority, tags (and epic, component, deliverable for stories) with live counts, plus a *Not linked to a story* filter. Each facet ignores its own filter so sibling values stay visible.
- **Large lists.** Server-side paging (50–500 per page) and sorting by any column, including story and children counts. Children counts drill into the hierarchy. Each row shows the statement inline.
- **Bulk edits.** Select a page, then **Select all N matching** to update a whole filtered set: set a field, or add/remove list values. Dry runs are available, and the write is all-or-nothing.
- **Record drawer.** A **Links & impact** tab shows the parent, children, realising stories, tasks, the evals covering each acceptance criterion, components, and the record's lint findings.
- **Lint and traceability.** Lint is paged and filterable by rule, severity and category; traceability drills into uncovered requirements. Every list, facet and lint call is server-side and stays fast at 3,000+ requirements.

**Chat with Claude** (right panel) runs your local Claude Code (`claude -p`, resumed per conversation) with this plugin loaded:

1. The agent reviews what exists (`search`, `context`, `lint`, `trace`), using your current view and selection as context. It asks multiple-choice questions, rendered as buttons, only when a product decision is needed.
2. It drafts a **changeset**: creates, updates and deletes across requirements, stories, tasks and evals, including traceability remaps. It loops on `simulate_changeset`, which applies the ops in memory and reports validation errors, dangling references, the MECE/lint delta, the trace delta and the blast radius, until the result is clean.
3. It reads code components (`config.components: {name: path}` → passed as `--add-dir`) to assess code impact, then proposes. The UI shows a card with per-op diffs and include checkboxes, verdicts, impact and risks, and **Apply / Ask to revise / Reject**.
4. **Apply** is deterministic and atomic. It rejects the changeset as *stale* if any touched record changed since it was proposed, writes one git commit, and feeds the result back to the agent, which verifies traceability and proposes follow-up remaps if needed.

The chat agent's tool allowlist contains no direct write tools (`create`, `update`, `delete`, `bulk_update`, `upsert_many`, `apply_changeset`, `Bash`, `Write`, `Edit` are denied), so nothing changes without your click. Environment: `REQFORGE_CLAUDE_BIN` (path to `claude`), `REQFORGE_CHAT_MODEL`, `REQFORGE_PLUGIN_DIR`. Changesets are stored in `changesets/CS-NNNN.json` and listed in the **Changes** tab.

## How MECE is enforced

- **Mutually exclusive.** Types are tested in a fixed decision order, and a requirement takes the *first* type whose test passes: `constraint → interface → data → quality → functional`. Quality categories are the 9 ISO/IEC 25010:2023 characteristics. The lint flags near-duplicate statements (term overlap) and compound "shall … and shall" statements.
- **Collectively exhaustive.** Every taxonomy cell (25 of them, plus a functional catch-all) must be either populated or waived with a reason in `reqforge.json → coverage_waivers`. An empty cell shows up as a gap; it is never silently ignored.
- **Verifiable.** Requirements use "shall" form, with no vague terms (ISO 29148 list), measurable thresholds on quality requirements, and acceptance criteria. Approved requirements without ACs are an error.

`reqforge taxonomy` prints the full taxonomy with each type's decision test.

## Evals → CI/CD

Each story carries `evals: [{id, name, kind, command, covers: ["REQ-0007#AC1"], required}]`. The eval kind determines its pipeline stage:

| stage | eval kinds | runs |
|---|---|---|
| commit | static, unit, contract | every push/PR |
| acceptance | integration, e2e, accessibility, llm-judge | every push/PR |
| security | security | every push/PR |
| performance | performance | main |
| post-deploy | smoke | after deploy on main |
| monitor | synthetic-monitor | cron |

Before any stage runs, a `traceability` job gates on `reqforge lint --gate` and `reqforge trace --gate`. Each stage job runs `reqforge evals run --stage <s>`, so **adding an eval to a story extends the pipeline without regenerating the workflow**. A failed eval reports the requirement IDs at risk. CI builds the reqforge binary from the server sources vendored into `.reqforge/server` (cached), or from `cicd.reqforge_git` if you set it.

Trace checks: requirement→story coverage, orphan stories, non-empty epics, tasks per story, evals on every code story, runnable commands, acceptance-criteria→eval coverage, quality requirements verified by a matching eval kind (performance→performance, security→security, …), lifecycle coverage (design/deployment/monitoring), and valid eval references. Thresholds are in `reqforge.json → gates`.

## CLI

```bash
bin/reqforge init ./shop-reqs --key SHOP --name "Shop" --github acme/shop-requirements
bin/reqforge list req -q "type:quality status:approved|proposed"
bin/reqforge add req -s title="Login" -s type=functional -s category=auth -s statement="The system shall …"
bin/reqforge edit REQ-0003 -s priority=must --if-version 2
bin/reqforge bulk req -q "category:security" -s status=approved --add tags=asvs-l2 --dry-run
bin/reqforge export req > reqs.csv   # edit in a spreadsheet…
bin/reqforge import req reqs.csv     # …and upsert back (all-or-nothing validation)
bin/reqforge lint --md ; bin/reqforge trace --md --gate
bin/reqforge evals run --stage commit --workdir ../shop
bin/reqforge cicd ../shop            # writes the workflow + vendored reqforge sources
bin/reqforge config --set 'components={"web":"../shop-web"}'   # read/patch reqforge.json
bin/reqforge sync                    # commit, pull --rebase, push
bin/reqforge serve --port 8787       # UI + REST
bin/reqforge console                 # REPL: ls / show / set / new / bulk / lint / trace / sync
```

The repo is found from `--repo`, then `$REQFORGE_REPO`, then by walking up from the current directory to a `reqforge.json` or a `.reqforge-repo` pointer file.

## REST API

Projects: `GET /api/projects` · `POST /api/projects {key, name, github?, private?}` · `POST /api/projects/import {path, key?}` · `PATCH /api/projects/{key} {name?, default?}` · `DELETE /api/projects/{key}?confirm=KEY[&delete_remote=1]`. All routes below also exist as `/api/p/{KEY}/…`.

`GET /api/meta` · `GET|POST /api/{requirements|epics|stories|tasks}` (`?q=` plus `field=value` filters; add `limit/offset/sort/order` for `{total, items}` pages with link counts; pseudo-filter `covered=yes|no`) · `GET /api/{kind}/facets` (facet counts and the category tree) · `GET /api/context/{id}` · `GET /api/changesets` · `POST /api/changesets[/simulate]` · `POST /api/changesets/{id}/apply|reject` · `POST /api/chat` (SSE) · `POST /api/chat/cancel` · `GET|PATCH|DELETE /api/{kind}/{id}` (send `_version` for optimistic concurrency → 409 on conflict) · `POST /api/{kind}/bulk` `{ids|q|where, set, add, remove, dry_run}` · `POST /api/{kind}/import` (JSON rows or `text/csv`) · `GET /api/{kind}/export.csv` · `GET /api/lint` · `GET /api/trace` · `GET /api/evals?stage=` · `GET|POST /api/sessions` · `POST /api/sync` · `PATCH /api/config`.
Set `REQFORGE_TOKEN` to require `Authorization: Bearer <token>`.

## Layout

```
~/.reqforge/                       workspace
  reqforge-workspace.json          project registry {default, projects:[{key, name, path, created}]}
  pay/                             one project = one requirements repo (below)
```

Each requirements repo looks like this:

```
reqforge.json              key, gates, coverage_waivers, cicd settings
requirements/REQ-0001.json epics/EPIC-0001.json stories/STORY-0001.json tasks/TASK-0001.json
sessions/ELI-0001.md       elicitation transcripts: research with sources, Q&A, decisions
changesets/CS-0001.json    proposed/applied/rejected change batches with their analysis
reports/                   traceability reviews
```

## Develop

```
server/   Rust crate `reqforge`
  src/model.rs     kinds, MECE taxonomy, schemas, validation
  src/workspace.rs projects: registry, create/import/rename/default/delete, project resolution
  src/store.rs     JSON-file store (mtime cache, write lock + flock), git/GitHub sync
  src/lint.rs      MECE + ISO 29148 quality lint (inverted-index overlap detection)
  src/trace.rs     traceability gate
  src/changes.rs   changesets: in-memory simulation, impact, propose/apply/reject
  src/query.rs     paging, sorting, facets, category tree, paged lint
  src/evals.rs     eval registry + stage runner     src/cicd.rs  GitHub Actions generator
  src/api.rs       axum REST + SSE + embedded UI    src/chat.rs  `claude -p` bridge
  src/mcp.rs       stdio MCP server                 src/cli.rs, console.rs
  tests/integration.rs
web/      React + TypeScript + Tailwind + shadcn/ui (Vite) → web/dist, embedded in the binary
```

```bash
cargo test --manifest-path server/Cargo.toml           # 36 integration tests
cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings
(cd web && npm ci && npm run dev)                      # UI dev server; proxies /api to :8787
(cd web && npm run build)                              # rebuild web/dist (bin/reqforge then re-embeds it)
python3 examples/seed_demo.py /tmp/demo && bin/reqforge --repo /tmp/demo serve
python3 examples/seed_large.py /tmp/big 3000 && bin/reqforge --repo /tmp/big serve   # scale demo
claude plugin validate .
```

`REQFORGE_UI_DIR=<dir>` makes the server serve the UI from disk instead of the embedded copy.
