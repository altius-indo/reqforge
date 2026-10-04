// Suite "help": the in-app help panel (REQ-0048) on the BIG repository (single-repository mode, as in core).
// Phase 1 drives the project app and the projects page; phase 2 reloads with GET /api/projects stubbed to an empty
// workspace so the onboarding screen shows. Keyboard behaviour (AC6) is the help-a11y suite.
// Helpers (ok, until, T, $, $$, setVal, rows, pagerTotal, reloadInto, …) come from web/e2e/lib/prelude.js.

// section ids are the `id:` front matter of web/help/*.md
const SECTION_FOR_TAB = {
  requirements: "browse-and-filter", epics: "browse-and-filter", stories: "browse-and-filter", tasks: "browse-and-filter",
  components: "code-components", trace: "lint-and-traceability", verification: "verification-and-impact",
  lint: "lint-and-traceability", changes: "chat-and-changesets", design: "design",
};
const SIX_TOPICS = ["browse-and-filter", "edit-and-bulk-update", "chat-and-changesets", "lint-and-traceability",
  "verification-and-impact", "projects"];

const panel = () => $(T("help-panel"));
const sections = () => $$(T("help-section"));
const sectionIds = () => sections().map((s) => s.dataset.section);
const tocIds = () => $$(T("help-toc-item")).map((b) => b.dataset.section);
const currentSection = () => $(T("help-body"))?.dataset.section;
const helpReady = () => until(() => panel() && sections().length > 0, 20000); // first open loads the guides chunk
/** the section's top edge is at the top of the scrolled content (it is the one in view) */
const atTop = (id) => {
  const box = $(T("help-content")), sec = $(`${T("help-section")}[data-section="${id}"]`);
  if (!box || !sec) return false;
  const d = sec.getBoundingClientRect().top - box.getBoundingClientRect().top;
  return d >= -2 && d <= 40;
};
const openHelp = async () => { $(T("help-button")).click(); return helpReady() };
const closeHelp = async () => { $(T("help-close")).click(); return until(() => !panel(), 4000) };
const search = async (q) => { setVal($(T("help-search")), q); await sleep(150) };

async function suite() {
  if (phase === "1") return phaseOne();
  if (phase === "2") return phaseTwo();
}

async function phaseOne() {
  await until(() => rows().length > 0, 15000);

  // reqforge: verifies REQ-0048#AC1
  // ---------------------------------------------------------------- 1. opens over the view, state untouched
  ok("[REQ-0048#AC1] Help button in the app header", !!$(`header ${T("help-button")}`));
  await until(() => $(`${T("facet-chip")}[data-facet="status"][data-value="approved"]`), 15000);
  $(`${T("facet-chip")}[data-facet="status"][data-value="approved"]`).click();
  await until(() => /status: approved/.test(txt(T("crumbs"))) && pagerTotal() < 3040, 10000); await sleep(300);
  rows()[0].querySelector(T("row-check")).click();
  rows()[1].querySelector(T("row-check")).click();
  await until(() => /2 selected/.test(txt(T("bulk-count"))), 4000);
  const snapshot = () => ({ hash: location.hash, crumbs: txt(T("crumbs")), total: pagerTotal(), sel: txt(T("bulk-count")),
    selected: rows().filter((r) => r.dataset.selected === "true").map((r) => r.dataset.id).join(",") });
  const before = snapshot();
  $(T("help-button")).click(); // one click
  const t0 = Date.now(), opened = await helpReady();
  ok("[REQ-0048#AC1] 1 click opens the help panel", opened && panel().getAttribute("role") === "dialog",
    `opened=${opened} after ${Date.now() - t0}ms, panel=${!!panel()} role=${panel()?.getAttribute("role")} sections=${sections().length} body=${(panel()?.textContent || "").slice(0, 80)}`);
  ok("[REQ-0048#AC1] panel slides out over the current view", !!$(T("list-view")) && panel().getBoundingClientRect().right >= innerWidth - 2 && panel().getBoundingClientRect().width < innerWidth, JSON.stringify(panel()?.getBoundingClientRect()));
  const during = snapshot();
  ok("[REQ-0048#AC1] route (hash) unchanged while open", during.hash === before.hash, `${before.hash} -> ${during.hash}`);
  ok("[REQ-0048#AC1] filters unchanged while open", during.crumbs === before.crumbs && during.total === before.total, `${before.crumbs}/${before.total} -> ${during.crumbs}/${during.total}`);
  ok("[REQ-0048#AC1] selection unchanged while open", during.sel === before.sel && during.selected === before.selected && /2 selected/.test(during.sel), `${before.selected} -> ${during.selected}`);
  // navigate inside the panel: contents entries must not touch the hash route either
  $(`${T("help-toc-item")}[data-section="projects"]`).click(); await sleep(200);
  ok("[REQ-0048#AC1] contents navigation keeps the route", location.hash === before.hash, location.hash);
  await closeHelp();
  const after = snapshot();
  ok("[REQ-0048#AC1] route, filters and selection intact after closing", JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after) + " vs " + JSON.stringify(before));
  $(T("bulk-clear")).click();

  // reqforge: verifies REQ-0048#AC2
  // ---------------------------------------------------------------- 2. contextual section + table of contents
  await openHelp();
  const all = sectionIds();
  ok("[REQ-0048#AC2] contents link to every section", all.length >= 6 && JSON.stringify(tocIds()) === JSON.stringify(all), tocIds().join(",") + " vs " + all.join(","));
  ok("[REQ-0048#AC2] contents entries are buttons, not hash links", $$(`${T("help-toc")} a[href^="#"]`).length === 0 && $$(T("help-toc-item")).every((b) => b.tagName === "BUTTON"));
  $(`${T("help-toc-item")}[data-section="verification-and-impact"]`).click(); await sleep(250);
  ok("[REQ-0048#AC2] a contents entry scrolls to its section", currentSection() === "verification-and-impact" && atTop("verification-and-impact") && $(`${T("help-toc-item")}[data-section="verification-and-impact"]`).getAttribute("aria-current") === "true", currentSection());
  await closeHelp();
  const wrong = [];
  for (const [tab, want] of Object.entries(SECTION_FOR_TAB)) {
    $(T(`tab-${tab}`)).click();
    await until(() => $(`${T(`tab-${tab}`)}[aria-current="page"]`), 4000); await sleep(150);
    await openHelp(); await sleep(150);
    const got = currentSection();
    if (got !== want || !atTop(want) || $(`${T("help-section")}[data-section="${want}"]`)?.dataset.current !== "true") wrong.push(`${tab}→${got}${atTop(want) ? "" : " (not in view)"}`);
    await closeHelp();
  }
  ok("[REQ-0048#AC2] opens on the section of every tab", !wrong.length, wrong.join(", "));
  // the chat panel's own help button opens the chat section
  $(T("tab-requirements")).click(); await sleep(300);
  $(T("chat-toggle")).click();
  await until(() => $(T("chat-help")), 4000);
  $(T("help-button")).click(); await helpReady(); await sleep(150);
  ok("[REQ-0048#AC2] header Help follows the active tab while chat is open", currentSection() === "browse-and-filter", currentSection());
  await closeHelp();
  $(T("chat-help")).click(); await helpReady(); await sleep(150);
  ok("[REQ-0048#AC2] chat panel help opens on chat and changesets", currentSection() === "chat-and-changesets" && atTop("chat-and-changesets"), currentSection());
  await closeHelp();
  $(T("chat-close")).click(); await sleep(200);
  // projects page
  pdown($(T("project-switcher")));
  await until(() => $(T("switcher-menu")), 4000);
  $(T("switcher-manage")).click();
  await until(() => $(T("projects-view")), 8000);
  ok("[REQ-0048#AC1] Help button on the projects page", !!$(`header ${T("help-button")}`));
  const projHash = location.hash;
  await openHelp(); await sleep(150);
  ok("[REQ-0048#AC2] projects page opens on the projects section", currentSection() === "projects" && atTop("projects") && location.hash === projHash, currentSection() + " " + location.hash);

  // reqforge: verifies REQ-0048#AC3
  // ---------------------------------------------------------------- 3. the six numbered how-to guides
  const missing = SIX_TOPICS.filter((id) => !sectionIds().includes(id));
  ok("[REQ-0048#AC3] guides for the 6 required topics", !missing.length, "missing: " + missing.join(","));
  const unnumbered = sections().filter((s) => {
    const ol = s.querySelector("ol");
    return !ol || getComputedStyle(ol).listStyleType !== "decimal" || ol.querySelectorAll(":scope > li").length < 2;
  }).map((s) => s.dataset.section);
  ok("[REQ-0048#AC3] every guide has numbered steps", !unnumbered.length, unnumbered.join(","));
  const steps = sections().reduce((n, s) => n + s.querySelectorAll("ol > li").length, 0);
  ok("[REQ-0048#AC3] guides are step-by-step (≥ 3 steps per topic)", SIX_TOPICS.every((id) => $(`${T("help-section")}[data-section="${id}"]`)?.querySelectorAll("ol > li").length >= 3), steps + " steps");

  // reqforge: verifies REQ-0048#AC4
  // ---------------------------------------------------------------- 4. search
  const total = sections().length;
  const matches = (q) => {
    const words = q.toLowerCase().split(/\s+/);
    return sections().every((s) => words.every((w) => s.textContent.toLowerCase().includes(w)));
  };
  await search("changeset");
  ok("[REQ-0048#AC4] search 'changeset' shows only matching sections", sections().length > 0 && sections().length < total && matches("changeset") && sectionIds().includes("chat-and-changesets"), sectionIds().join(","));
  ok("[REQ-0048#AC4] contents follow the search", JSON.stringify(tocIds()) === JSON.stringify(sectionIds()), tocIds().join(","));
  await search("JUnit");
  ok("[REQ-0048#AC4] search is case-insensitive ('JUnit' → verification)", JSON.stringify(sectionIds()) === '["verification-and-impact"]' && matches("junit"), sectionIds().join(","));
  await search("dry run");
  ok("[REQ-0048#AC4] multi-word search ('dry run' → bulk update)", JSON.stringify(sectionIds()) === '["edit-and-bulk-update"]', sectionIds().join(","));
  await search("zzqxv nothing");
  ok("[REQ-0048#AC4] no-results message when nothing matches", sections().length === 0 && /No help sections match/.test(txt(T("help-no-results"))), txt(T("help-content")).slice(0, 120));
  await search("");
  ok("[REQ-0048#AC4] clearing the search shows every section", sections().length === total && !$(T("help-no-results")), sections().length);

  // reqforge: verifies REQ-0048#AC5
  // ---------------------------------------------------------------- 5. content from the bundled Markdown files
  const first = $(`${T("help-section")}[data-section="browse-and-filter"]`);
  ok("[REQ-0048#AC5] guide text comes from web/help/01-browse-and-filter.md", /Every record list \(Requirements, Epics, Stories, Tasks, Components\) shares the same toolbar/.test(first?.textContent), first?.textContent.slice(0, 120));
  ok("[REQ-0048#AC5] Markdown rendered (headings, ordered lists, emphasis)", sections().every((s) => s.querySelector(".md h3") && s.querySelector(".md ol") && s.querySelector(".md strong")), sectionIds().join(","));
  ok("[REQ-0048#AC5] front matter not shown", !sections().some((s) => /^\s*---|keywords:|tabs:/m.test(s.querySelector(".md").textContent)));
  const chunk = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/assets\/guides-[\w-]+\.js$/.test(n));
  ok("[REQ-0048#AC5] guides bundled with the web UI (lazy chunk from /assets)", !!chunk && new URL(chunk).origin === location.origin, chunk || "no guides chunk loaded");
  await closeHelp();

  reloadInto(2);
}

async function phaseTwo() {
  // stub an empty workspace before the app's first request: the onboarding screen shows
  const realFetch = window.fetch.bind(window);
  window.fetch = (u, o) => /\/api\/projects$/.test(String(u)) && (!o || !o.method || o.method === "GET")
    ? Promise.resolve(new Response(JSON.stringify({ workspace: "ws", single: false, default: null, projects: [] }), { status: 200, headers: { "Content-Type": "application/json" } }))
    : realFetch(u, o);
  await until(() => $(T("onboarding")), 15000);
  // reqforge: verifies REQ-0048#AC1
  ok("[REQ-0048#AC1] Help button on the onboarding screen", !!$(T("onboarding")) && !!$(`header ${T("help-button")}`));
  // reqforge: verifies REQ-0048#AC2
  await openHelp(); await sleep(150);
  ok("[REQ-0048#AC2] onboarding opens on the projects section", currentSection() === "projects" && atTop("projects"), currentSection());
  await closeHelp();
  window.fetch = realFetch;
}
