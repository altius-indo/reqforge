# In-app help: information architecture

Design for the slide-out help panel (REQ-0048, STORY-0010, TASK-0020). The guides in this directory are the panel's
content; this README is not shown in the panel.

## Panel layout

- **Entry point.** A **Help** button sits at the right end of the header on every view: the project app (all tabs),
  the projects page, the first-run (onboarding) screen and the load-error screen. One click opens the panel; the
  route (URL hash), filters, search, selection, open record drawer and chat stay untouched underneath.
- **Panel.** A right-hand slide-out sheet (`HelpPanel`, shadcn `Sheet`), about 640px wide, full height, full width on
  phones. It is modal while open: the page behind is inert, and **Esc** or the **×** button closes it.
- **Header row.** Title *Help*, a search box (focused on open), the close button.
- **Body, two columns** (stacked on narrow screens):
  - **Contents** (left): one entry per section, in guide order. The entry for the current section is highlighted.
    Clicking an entry scrolls the content to that section (buttons, not `#` links, so the app's hash route never
    changes).
  - **Content** (right, scrolls): every section rendered in order. Each section is one guide: its title (h2), a short
    intro, then one or more tasks (h3), each a numbered list of steps.
- **Search.** Typing filters the sections (contents and content) to those whose title, keywords or text contain every
  word typed (case-insensitive). When nothing matches, the panel shows *No help sections match “…”* instead.
  Clearing the box shows every section again.
- **Opening section.** The panel opens scrolled to the section mapped to the active tab (table below). Reopening it
  starts from that section again, with an empty search.
- **Keyboard.** Focus moves into the panel (to the search box) on open; Tab cycles inside the panel; Esc closes it;
  focus returns to the button that opened it.
- **Loading.** The panel body and the guides are a separate, lazily loaded chunk: they cost nothing until Help is
  first opened.

## Tab → section map

Every UI tab and page maps to exactly one section; every section is reachable from the contents.

| UI tab / page                       | Opens on section          | Guide file                      |
| ----------------------------------- | ------------------------- | ------------------------------- |
| Requirements                        | `browse-and-filter`       | `01-browse-and-filter.md`       |
| Epics                               | `browse-and-filter`       | `01-browse-and-filter.md`       |
| Stories                             | `browse-and-filter`       | `01-browse-and-filter.md`       |
| Tasks                               | `browse-and-filter`       | `01-browse-and-filter.md`       |
| Components                          | `code-components`         | `06-code-components.md`         |
| Traceability                        | `lint-and-traceability`   | `04-lint-and-traceability.md`   |
| Verification                        | `verification-and-impact` | `05-verification-and-impact.md` |
| Lint                                | `lint-and-traceability`   | `04-lint-and-traceability.md`   |
| Changes                             | `chat-and-changesets`     | `03-chat-and-changesets.md`     |
| Design                              | `design`                  | `08-design.md`                  |
| Decisions                           | `decisions`               | `09-decisions.md`               |
| Chat panel (its **?** help button)  | `chat-and-changesets`     | `03-chat-and-changesets.md`     |
| Projects page, onboarding           | `projects`                | `07-projects.md`                |
| (contents only)                     | `edit-and-bulk-update`    | `02-edit-and-bulk-update.md`    |

The header's Help button follows the active tab even while the chat panel is open; the chat panel has its own help
button that opens the chat section. The map lives in each guide's `tabs:` front matter, so adding a tab means
naming it in one guide.

## Guide outlines

1. **Browse and filter** — find requirements with the category tree (types, categories, coverage bars, gaps and
   waivers); search and filter (free text, `field:value` tokens, facet chips, traceability and verification chips,
   filter pills); sort, page and drill into children; export the current view as CSV.
2. **Edit and bulk update** — edit one record in the drawer (schema-generated form, save, version conflicts, Esc);
   create or delete a record; review links and impact; update many records at once (select page / all matching,
   field + set/add/remove, dry run, apply); import from CSV.
3. **Chat and changesets** — ask Claude for a change (context toggle, Enter to send, choice buttons, stop, new
   conversation, the *Ask Claude* shortcuts); review and apply a changeset (verdicts, operations, impact, apply /
   revise / reject, follow-up); find changesets later on the Changes tab (pending badge, stale changesets, Sync).
4. **Lint and traceability** — work through lint findings (verdict cards, rule chips, severity, tree scope, *Ask
   Claude to fix these*); check traceability (CI gate and score, coverage cards, failing checks, *Ask Claude to fix
   gaps*).
5. **Verification evidence and impact** — read the verification dashboard (gate, five statuses, status counts as
   filters); scan code for trace tags; ingest CI results (JUnit XML / eval reports, commit, run URL); see one
   requirement's evidence (*Code & evidence* drawer tab); analyse the impact of a code change (component, base ref,
   tests to re-run, untraced changes).
6. **Code components** — add a component (key, path, globs, tag mode); tag code and tests; link stories to a
   component.
7. **Projects** — switch projects (switcher, back/forward); create a project (key rules, optional GitHub repo);
   import an existing repository; manage projects (open, rename, make default, delete, single-repository mode).
8. **Design documents** — read a design document (list, Markdown, realised requirements, record ids open the
   drawer); find the design behind a requirement (*Links & impact* drawer tab); add a design document
   (`design/<slug>.md`, front matter, Lint).
9. **Decisions** — read the decisions (status, exercised and why not, linked requirements, *Exercised* drawer
   tab); make a decision exercised (tags, scan, evidence, the 14-day lint); record or change a decision
   (changesets only).

## Authoring and bundling

- One Markdown file per section, named `NN-<id>.md`; `NN` sets the order. Front matter (between `---` lines):
  `id` (section id, stable: tests and the tab map use it), `title`, `tabs` (comma-separated tab ids from the map
  above), `keywords` (extra search terms, not shown).
- Body: a one-paragraph intro, then `###` task headings, each followed by a numbered (`1.`) list of steps. Name UI
  controls in **bold** exactly as they are labelled. Do not write literal record ids (they would be linkified and
  picked up by trace scans); write `REQ-…` instead.
- `web/src/components/help/guides.ts` bundles every `web/help/[0-9]*.md` at build time with Vite's
  `import.meta.glob(..., { query: "?raw", import: "default", eager: true })`, so the guides are versioned here and
  ship inside `web/dist` (and the server binary). Rebuild the web UI after editing a guide.
