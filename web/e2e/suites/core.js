// Suite "core": single-repository mode (`reqforge --repo <dir> serve`) on the 3,040-requirement BIG repo
// (examples/seed_large.py <dir> 3000), with a fake `claude -p` (web/e2e/fake-claude.py) behind the chat panel.
// Helpers (ok, until, T, $, $$, setVal, rows, pagerTotal, …) come from web/e2e/lib/prelude.js.
// Check names start with the acceptance criterion they verify, so JUnit results map to requirements.

// reqforge:off (fixture ids from the seeded data, not reqforge's own requirements)
const FIXTURE_NEARBY_REQ = "REQ-0042"; // the id the fake agent mentions
// reqforge:on

async function suite() {
  // reqforge: verifies REQ-0030#AC1
  // ---------------------------------------------------------------- 1. first page
  await until(() => rows().length > 0, 15000);
  ok("[REQ-0030#AC1] first page 100 rows", rows().length === 100, rows().length);
  ok("[REQ-0030#AC1] pager shows total 3,040", /of 3,040/.test(txt(T("pager-range"))), txt(T("pager-range")));
  ok("project name from /api/meta", /BIG/.test(txt(T("project"))), txt(T("project")));

  // reqforge: verifies REQ-0030#AC2
  // ---------------------------------------------------------------- 2. tree drill-down: quality › security
  await until(() => $$(T("tree-type")).length > 0, 20000);
  ok("[REQ-0030#AC2] tree has 5 types", $$(T("tree-type")).length === 5, $$(T("tree-type")).length);
  $(`${T("tree-type")}[data-type="quality"]`).click();
  await until(() => /quality/.test(txt(T("crumbs"))));
  const cat = $(`${T("tree-cat")}[data-category="security"]`);
  ok("[REQ-0030#AC2] categories expanded with coverage bars", !!cat && !!cat.querySelector("[data-slot=progress]"));
  cat.click();
  await until(() => /security/.test(txt(T("crumbs"))) && pagerTotal() < 3040); await sleep(300);
  const totalSec = pagerTotal();
  ok("[REQ-0030#AC2] drill-down quality › security filters", totalSec > 0 && totalSec < 500, totalSec);
  ok("[REQ-0030#AC2] tree node marked active", $(`${T("tree-cat")}[data-category="security"]`)?.dataset.active === "true");

  // reqforge: verifies REQ-0030#AC3
  // ---------------------------------------------------------------- 3. sort by stories, page size 50
  $(T("sort-_stories")).click();
  await until(() => $(T("sort-_stories"))?.getAttribute("aria-sort") === "ascending"); await sleep(500);
  ok("[REQ-0030#AC3] sort by stories asc", rows()[0]?.querySelector('[data-col="_stories"]')?.textContent === "0", rows()[0]?.querySelector('[data-col="_stories"]')?.textContent);
  setVal($(T("page-size")), "50");
  await until(() => rows().length === Math.min(50, totalSec));
  ok("[REQ-0030#AC3] page size 50", rows().length === Math.min(50, totalSec), rows().length);

  // reqforge: verifies REQ-0030#AC4
  // ---------------------------------------------------------------- 4. select all matching + bulk add tag
  $(T("select-page")).click();
  await until(() => $(T("bulk-bar")));
  ok("[REQ-0030#AC4] select page marks rows", rows().every((r) => r.dataset.selected === "true"));
  $(T("bulk-select-all")).click();
  const selRe = new RegExp(`${totalSec.toLocaleString("en-US")} selected`);
  await until(() => selRe.test(txt(T("bulk-count"))));
  ok("[REQ-0030#AC4] select all matching", selRe.test(txt(T("bulk-count"))), txt(T("bulk-count")));
  setVal($(T("bulk-field")), "tags"); await sleep(150);
  setVal($(T("bulk-mode")), "add"); await sleep(150);
  setVal($(T("bulk-value")), "sec-review"); await sleep(150);
  ok("[REQ-0030#AC4] bulk mode add enabled for list field", $(T("bulk-mode")).value === "add", $(T("bulk-mode")).value);
  $(T("bulk-apply")).click();
  await until(() => !$(T("bulk-bar")), 8000); await sleep(300);
  const tagged = await getJ("/api/requirements?q=tags:sec-review&limit=1");
  ok("[REQ-0030#AC4] bulk tagged all matching", tagged.total === totalSec, tagged.total + " vs " + totalSec);

  // reqforge: verifies REQ-0030#AC5
  // ---------------------------------------------------------------- 5. facet chip → filter pill
  await until(() => $(`${T("facet-chip")}[data-facet="status"][data-value="approved"]`));
  $(`${T("facet-chip")}[data-facet="status"][data-value="approved"]`).click();
  await until(() => /status: approved/.test(txt(T("crumbs"))));
  ok("[REQ-0030#AC5] facet filter pill", /status: approved/.test(txt(T("crumbs"))), txt(T("crumbs")));
  await until(() => pagerTotal() < totalSec); await sleep(300);
  ok("[REQ-0030#AC5] facet filter narrows list", pagerTotal() > 0 && pagerTotal() < totalSec, pagerTotal());
  // search with a field:value token
  const s = $(T("search")); setVal(s, "priority:must"); press(s, "Enter");
  await until(() => /priority:must/.test(txt(T("crumbs")))); await sleep(400);
  ok("search field:value token", rows().length > 0 && /“priority:must”/.test(txt(T("crumbs"))), txt(T("crumbs")));

  // reqforge: verifies REQ-0031#AC1
  // reqforge: verifies REQ-0031#AC2
  // reqforge: verifies REQ-0045#AC1
  // ---------------------------------------------------------------- 6. record drawer: details form, links tab, Esc
  const firstId = rows()[0].dataset.id;
  rows()[0].click();
  await until(() => $(T("drawer")) && /v\d+/.test(txt(T("drawer-title"))));
  ok("[REQ-0031#AC1] drawer opens record", txt(T("drawer-title")).includes(firstId), txt(T("drawer-title")));
  ok("[REQ-0031#AC1] details form generated from schema", !!$(T("f_statement")) && $(T("f_type"))?.tagName === "SELECT" && $(T("f_acceptance_criteria"))?.tagName === "TEXTAREA");
  mdown($(T("drawer-tab-links")));
  await until(() => /Realised by stories/.test(txt(T("links-panel"))));
  ok("[REQ-0031#AC2] links & impact tab", /Acceptance criteria/.test(txt(T("links-panel"))) && /Realised by stories/.test(txt(T("links-panel"))), txt(T("drawer")).slice(0, 200));
  press(document.body, "Escape");
  await until(() => !$(T("drawer")), 3000);
  ok("[REQ-0045#AC1] Esc closes drawer", !$(T("drawer")));

  // reqforge: verifies REQ-0030#AC6
  // ---------------------------------------------------------------- 7. lint view, 8. trace view
  $(T("tab-lint")).click();
  await until(() => /findings in/.test(txt(T("lint-summary"))), 15000);
  ok("[REQ-0030#AC6] lint view paged", $$(T("lint-row")).length > 0 && $$(T("lint-row")).length <= 100 && $$(T("rule-chip")).length > 0, $$(T("lint-row")).length);
  await until(() => $(`${T("tree-type")}[data-type="quality"]`));
  $(`${T("tree-type")}[data-type="quality"]`).click();
  await until(() => /findings in quality/.test(txt(T("lint-summary"))), 10000);
  ok("[REQ-0030#AC6] lint scoped to tree selection", /findings in quality/.test(txt(T("lint-summary"))), txt(T("lint-summary")));
  $(T("tab-trace")).click();
  await until(() => $(T("trace-verdict")), 15000);
  ok("[REQ-0030#AC6] trace view verdict", /PASS|FAIL/.test(txt(T("trace-verdict"))), txt(T("trace-verdict")));
  ok("[REQ-0030#AC6] trace checks table", $$(`${T("trace-checks")} tbody tr`).length > 0);

  // reqforge: verifies REQ-0032#AC1
  // reqforge: verifies REQ-0032#AC2
  // reqforge: verifies REQ-0032#AC3
  // ---------------------------------------------------------------- 9. chat: choices, changeset card, apply, follow-up
  $(T("chat-toggle")).click();
  await until(() => $(T("chat-input")));
  setVal($(T("chat-input")), "Add an audit log retention requirement"); await sleep(100);
  $(T("chat-send")).click();
  await until(() => $$(T("choice-option")).length === 2 && !$(T("choice-option")).disabled, 15000);
  ok("[REQ-0032#AC1] choices rendered as buttons", $$(T("choice-option")).length === 2, $$(T("choice-option")).length);
  ok("tool group summary", /1 tool call/.test(txt(T("tool-group"))), txt(T("tool-group")));
  $(`${T("tool-group")} button`).click(); await until(() => $(T("tool-item")), 3000);
  ok("tool activity shown", /search requirements/.test(txt(T("tool-group"))), txt(T("tool-group")));
  ok("assistant markdown linkifies ids", !!$(`${T("msg-asst")} ${T("id-link")}[data-id="${FIXTURE_NEARBY_REQ}"]`));
  $(T("choice-option")).click();
  await until(() => $(T("changeset-card")), 15000);
  ok("[REQ-0032#AC1] choices disabled after answer", $(T("choices"))?.dataset.done === "true");
  const cs = $(T("changeset-card"));
  ok("[REQ-0032#AC2] changeset card", /Audit log retention/.test(cs?.textContent) && /2 operations/.test(cs?.textContent), cs?.textContent.slice(0, 200));
  ok("[REQ-0032#AC2] card shows diff + verdicts", /priority:/.test(cs.textContent) && /valid/.test(txt(T("cs-verdicts"))), cs.textContent.slice(0, 300));
  await until(() => txt(T("pending-badge")) === "1", 8000);
  ok("changes badge", txt(T("pending-badge")) === "1", txt(T("pending-badge")));
  await until(() => $(T("cs-apply")) && !$(T("cs-apply")).disabled && !$(T("chat-stop")), 15000);
  $(T("cs-apply")).click();
  await until(() => $(T("changeset-card"))?.dataset.status === "applied", 15000);
  ok("[REQ-0032#AC2] applied", $(T("changeset-card"))?.dataset.status === "applied", $(T("changeset-card"))?.dataset.status);
  await until(() => /Verified/.test(txt(T("chat-messages"))), 15000);
  ok("[REQ-0032#AC3] agent follow-up after apply", /Verified/.test(txt(T("chat-messages"))));
  ok("[REQ-0032#AC3] follow-up message sent", $$(T("msg-user")).some((m) => /^I applied CS-\d+/.test(m.textContent)));
  const created = await getJ("/api/requirements?q=retention+audit+type:data");
  ok("[REQ-0032#AC2] record written", created.some((r) => r.title === "Audit log retention"), JSON.stringify(created).slice(0, 200));
  await until(() => !$(T("pending-badge")), 8000);
  ok("pending badge cleared", !$(T("pending-badge")));

  // ---------------------------------------------------------------- 10. changes view
  $(T("tab-changes")).click();
  await until(() => $(T("changeset-row")), 10000);
  $(T("changeset-row")).click();
  await until(() => $(`${T("changes-view")} ${T("changeset-card")}`), 10000);
  ok("changes view card", $(`${T("changes-view")} ${T("changeset-card")}`)?.dataset.status === "applied");

  // reqforge: verifies REQ-0032#AC4
  // ---------------------------------------------------------------- 11. chat log persisted (per-project keys)
  const lg = JSON.parse(localStorage.getItem("reqforge.chat.log.BIG") || "[]");
  ok("[REQ-0032#AC4] chat log persisted", lg.length >= 6 && localStorage.getItem("reqforge.chat.session.BIG") === '"s1"', lg.length + " " + localStorage.getItem("reqforge.chat.session.BIG"));
  $(T("tab-requirements")).click(); await sleep(500);

  // ---------------------------------------------------------------- 12. single-project mode: read-only project management
  pdown($(T("project-switcher")));
  await until(() => $(T("switcher-menu")), 4000);
  ok("single mode: switcher shows one project, no create", $$(T("switcher-item")).length === 1 && $(T("switcher-item")).dataset.key === "BIG" && !$(T("switcher-new")), $$(T("switcher-item")).length);
  $(T("switcher-manage")).click();
  await until(() => $(T("projects-view")), 8000);
  ok("single mode: projects page read-only", !!$(T("single-note")) && $$(T("project-row")).length === 1 && !$(T("project-delete")) && !$(T("project-rename")) && !$(T("project-default")) && !$(T("projects-new")), $$(T("project-row")).length);
  $(T("back-to-project")).click();
  await until(() => $(T("list-view")), 8000);
  ok("single mode: back to project", location.hash === "#/p/BIG" && !!$(T("list-view")), location.hash);
}
