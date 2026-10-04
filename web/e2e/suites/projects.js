// Suite "projects": multi-project workspace (`reqforge --workspace <ws> serve`) holding SHOP (examples/seed_demo.py
// --no-code, 4 requirements, the default) and BIG (examples/seed_large.py, 3,040 requirements).
// The suite runs in two phases around a page reload; the log survives in sessionStorage (see lib/prelude.js).
// run.mjs adds one harness check afterwards: the deleted project's directory is gone from disk.

const switchTo = async (key) => {
  await openSwitcher();
  $(`${T("switcher-item")}[data-key="${key}"]`).click();
  return until(() => location.hash === `#/p/${key}` && new RegExp(`\\b${key}\\b`).test(project()) && $(T("list-view")), 10000);
};
const listReady = async (n) => until(() => pagerTotal() === n, 15000);
const prow = (k) => $(`${T("project-row")}[data-key="${k}"]`);
const WS = E2E.workspaceName || "ws";

async function suite() {
  if (phase === "1") return phaseOne();
  if (phase === "2") return phaseTwo();
}

// reqforge: verifies REQ-0033#AC1
async function phaseOne() {
  // ---------------------------------------------------------------- 1. default project
  await until(() => rows().length > 0, 15000);
  ok("[REQ-0033#AC1] loads default SHOP with 4 rows", rows().length === 4 && /SHOP/.test(project()) && pagerTotal() === 4, rows().length + " " + project());
  ok("[REQ-0033#AC1] hash canonicalised to #/p/SHOP", location.hash === "#/p/SHOP", location.hash);
  // ---------------------------------------------------------------- 2. switcher
  await openSwitcher();
  const items = $$(T("switcher-item"));
  const byKey = Object.fromEntries(items.map((i) => [i.dataset.key, i]));
  ok("[REQ-0033#AC1] switcher lists SHOP and BIG", items.length === 2 && byKey.SHOP && byKey.BIG, items.map((i) => i.dataset.key).join(","));
  ok("[REQ-0033#AC1] switcher shows requirement counts", /4 req/.test(byKey.SHOP?.textContent) && /3,040 req/.test(byKey.BIG?.textContent), items.map((i) => i.textContent).join(" | "));
  ok("[REQ-0033#AC1] switcher marks active + default", byKey.SHOP?.dataset.active === "true" && !!byKey.SHOP?.querySelector(T("switcher-default")) && !byKey.BIG?.querySelector(T("switcher-default")));
  ok("switcher actions", !!$(T("switcher-new")) && !!$(T("switcher-manage")));
  press($(T("switcher-menu")), "Escape");
  await until(() => !$(T("switcher-menu")), 3000);
  ok("switcher closes on Escape", !$(T("switcher-menu")));
  // ---------------------------------------------------------------- 3. switch to BIG
  ok("[REQ-0033#AC1] switch to BIG", await switchTo("BIG"), location.hash + " " + project());
  await listReady(3040);
  ok("[REQ-0033#AC1] BIG shows 3,040 rows", /of 3,040/.test(txt(T("pager-range"))) && rows().length === 100, txt(T("pager-range")));
  ok("[REQ-0033#AC1] URL hash #/p/BIG", location.hash === "#/p/BIG", location.hash);
  await until(() => /3,040/.test(txt(T("tree-all"))), 10000);
  ok("[REQ-0033#AC4] tree is BIG's", /3,040/.test(txt(T("tree-all"))) && $$(T("tree-type")).length === 5, txt(T("tree-all")));
  const st = $(`${T("facet-chip")}[data-facet="status"]`);
  ok("[REQ-0033#AC4] facets are BIG's", !!st && +(st.textContent.match(/[\d,]+$/) || ["0"])[0].replace(/,/g, "") > 4, st?.textContent);
  // ---------------------------------------------------------------- 4. back / forward
  history.back();
  ok("[REQ-0033#AC1] history back returns to SHOP", await until(() => location.hash === "#/p/SHOP" && /SHOP/.test(project()) && pagerTotal() === 4, 10000), location.hash + " " + project());
  history.forward();
  ok("[REQ-0033#AC1] history forward returns to BIG", await until(() => location.hash === "#/p/BIG" && /BIG/.test(project()) && pagerTotal() === 3040, 10000), location.hash + " " + project());
  ok("last-used persisted", localStorage.getItem("reqforge.project") === '"BIG"', localStorage.getItem("reqforge.project"));
  // ---------------------------------------------------------------- 5. reload with #/p/SHOP (hash wins over last-used BIG)
  reloadInto(2, "#/p/SHOP");
}

async function phaseTwo() {
  await until(() => rows().length > 0, 15000);
  ok("[REQ-0033#AC1] reload with #/p/SHOP opens SHOP", /SHOP/.test(project()) && pagerTotal() === 4, project() + " " + pagerTotal());
  await createTest();
  await manageProjects();
  await chatPerProject();
  await deleteTest();
  await coreOnBig();
}

// reqforge: verifies REQ-0033#AC2
async function createTest() {
  // ---------------------------------------------------------------- 6. create TEST via the dialog
  await openSwitcher();
  $(T("switcher-new")).click();
  await until(() => $(T("create-key")), 8000);
  ok("[REQ-0033#AC2] create dialog opens from switcher", !!$(T("create-dialog")));
  setVal($(T("create-key")), "1x"); await sleep(150);
  ok("[REQ-0033#AC2] key uppercased as typed", $(T("create-key")).value === "1X", $(T("create-key")).value);
  ok("[REQ-0033#AC2] invalid key shows validation", $(T("create-key-hint")).dataset.error === "true" && /start with a letter/.test(txt(T("create-key-hint"))) && $(T("create-submit")).disabled, txt(T("create-key-hint")));
  setVal($(T("create-key")), "s"); await sleep(100);
  ok("[REQ-0033#AC2] too-short key rejected", /too short/.test(txt(T("create-key-hint"))) && $(T("create-submit")).disabled, txt(T("create-key-hint")));
  setVal($(T("create-key")), "shop"); await sleep(100);
  ok("[REQ-0033#AC2] existing key rejected", /already exists/.test(txt(T("create-key-hint"))) && $(T("create-submit")).disabled, txt(T("create-key-hint")));
  setVal($(T("create-key")), "test"); await sleep(100);
  ok("[REQ-0033#AC2] valid key accepted", $(T("create-key-hint")).dataset.error === "false" && $(T("create-key")).value === "TEST", txt(T("create-key-hint")));
  ok("[REQ-0033#AC2] name required", $(T("create-submit")).disabled);
  setVal($(T("create-name")), "Test project"); await sleep(100);
  setVal($(T("create-github")), "bad repo"); await sleep(100);
  ok("[REQ-0033#AC2] github owner/name validated", $(T("create-submit")).disabled && !!$(T("create-private")));
  setVal($(T("create-github")), ""); await sleep(100);
  ok("[REQ-0033#AC2] submit enabled", !$(T("create-submit")).disabled);
  $(T("create-submit")).click();
  ok("[REQ-0033#AC2] switched to TEST", await until(() => location.hash === "#/p/TEST" && /TEST/.test(project()) && $(T("list-view")), 15000), location.hash + " " + project() + " " + txt(T("create-error")));
  await until(() => txt(T("pager-range")) !== "", 8000); await sleep(500);
  ok("[REQ-0033#AC2] TEST has 0 rows", rows().length === 0 && pagerTotal() === 0, rows().length + " " + txt(T("pager-range")));
  ok("[REQ-0033#AC2] create dialog closed", !$(T("create-dialog")));
  await openSwitcher();
  ok("[REQ-0033#AC2] TEST appears in switcher", !!$(`${T("switcher-item")}[data-key="TEST"]`) && $(`${T("switcher-item")}[data-key="TEST"]`).dataset.active === "true");
  press($(T("switcher-menu")), "Escape"); await until(() => !$(T("switcher-menu")), 3000);
  // ---------------------------------------------------------------- 7. add a requirement in TEST via the New drawer
  $(T("new-record")).click();
  await until(() => $(T("f_title")), 8000);
  setVal($(T("f_title")), "Session timeout");
  setVal($(T("f_statement")), "The system shall end idle sessions after 15 minutes.");
  setVal($(T("f_type")), "quality"); await sleep(100);
  setVal($(T("f_category")), "security"); await sleep(100);
  $(T("drawer-save")).click();
  await until(() => pagerTotal() === 1, 10000);
  ok("[REQ-0031#AC1] TEST list shows the new requirement", rows().length === 1, rows().length);
  const tst = await getJ("/api/p/TEST/requirements?limit=1"), shp = await getJ("/api/p/SHOP/requirements?limit=1");
  ok("[REQ-0033#AC4] TEST has 1, SHOP still 4", tst.total === 1 && shp.total === 4, tst.total + " / " + shp.total);
}

async function manageProjects() {
  // ---------------------------------------------------------------- 8. projects page: rename TEST, make BIG default
  await openSwitcher();
  $(T("switcher-manage")).click();
  ok("projects page via switcher", await until(() => location.hash === "#/projects" && $$(T("project-row")).length === 3, 10000), location.hash + " " + $$(T("project-row")).length);
  prow("TEST").querySelector(T("project-rename")).click();
  await until(() => $(T("rename-input")), 5000);
  setVal($(T("rename-input")), "Renamed test project"); await sleep(100);
  $(T("rename-save")).click();
  await until(() => /Renamed test project/.test(prow("TEST")?.querySelector(T("project-name"))?.textContent || ""), 8000);
  const pl1 = await getJ("/api/projects");
  ok("rename TEST", pl1.projects.find((p) => p.key === "TEST")?.name === "Renamed test project" && /Renamed test project/.test(prow("TEST").textContent), JSON.stringify(pl1.projects.map((p) => p.name)));
  prow("BIG").querySelector(T("project-default")).click();
  await until(() => prow("BIG")?.querySelector(T("default-badge")), 8000);
  const pl2 = await getJ("/api/projects");
  ok("make BIG default", pl2.default === "BIG" && pl2.projects.find((p) => p.key === "BIG").default && !prow("SHOP").querySelector(T("default-badge")), pl2.default);
}

// reqforge: verifies REQ-0033#AC4
// reqforge: verifies REQ-0032#AC1
// reqforge: verifies REQ-0032#AC2
// reqforge: verifies REQ-0032#AC4
async function chatPerProject() {
  // ---------------------------------------------------------------- 9. chat on BIG
  prow("BIG").querySelector(T("project-open")).click();
  await until(() => location.hash === "#/p/BIG" && pagerTotal() === 3040, 15000);
  ok("[REQ-0033#AC1] open BIG from projects page", location.hash === "#/p/BIG" && /BIG/.test(project()), location.hash);
  if (!$(T("chat-input"))) $(T("chat-toggle")).click();
  await until(() => $(T("chat-input")));
  setVal($(T("chat-input")), "Add an audit log retention requirement"); await sleep(100);
  $(T("chat-send")).click();
  await until(() => $$(T("choice-option")).length === 2 && !$(T("choice-option")).disabled, 15000);
  ok("[REQ-0032#AC1] chat on BIG: choices", $$(T("choice-option")).length === 2, $$(T("choice-option")).length);
  $(T("choice-option")).click();
  await until(() => $(T("changeset-card")), 15000);
  ok("[REQ-0032#AC2] chat on BIG: changeset card", /Audit log retention/.test(txt(T("changeset-card"))), txt(T("changeset-card")).slice(0, 150));
  await until(() => $(T("cs-apply")) && !$(T("cs-apply")).disabled && !$(T("chat-stop")), 15000);
  $(T("cs-apply")).click();
  await until(() => $(T("changeset-card"))?.dataset.status === "applied", 15000);
  ok("[REQ-0032#AC2] chat on BIG: applied", $(T("changeset-card"))?.dataset.status === "applied", $(T("changeset-card"))?.dataset.status);
  await until(() => /Verified/.test(txt(T("chat-messages"))), 15000);
  const bcs = await getJ("/api/p/BIG/changesets"), scs = await getJ("/api/p/SHOP/changesets");
  ok("[REQ-0033#AC4] changeset landed in BIG, not SHOP", bcs.length === 1 && bcs[0].status === "applied" && scs.length === 0, bcs.length + " / " + scs.length);
  const bigLog = JSON.parse(localStorage.getItem("reqforge.chat.log.BIG") || "[]");
  ok("[REQ-0032#AC4] chat log stored per project", bigLog.length >= 6 && localStorage.getItem("reqforge.chat.session.BIG") === '"s1"' && !localStorage.getItem("reqforge.chat.log"), bigLog.length);
  // ---------------------------------------------------------------- 10. chat logs are per project
  await switchTo("SHOP");
  await until(() => $(T("chat-messages")), 5000); await sleep(300);
  ok("[REQ-0033#AC4] SHOP chat has no BIG messages", $$(T("msg-user")).length === 0 && !/audit log/i.test(txt(T("chat-messages"))), txt(T("chat-messages")).slice(0, 200));
  await switchTo("BIG");
  await until(() => $$(T("msg-user")).length > 0, 5000);
  ok("[REQ-0032#AC4] BIG chat restored on switch back", $$(T("msg-user")).length >= 2 && $(T("changeset-card"))?.dataset.status === "applied", $$(T("msg-user")).length);
  // a chat in flight on BIG must not render into SHOP
  setVal($(T("chat-input")), "hello again"); await sleep(50);
  $(T("chat-send")).click();
  await sleep(30);
  await switchTo("SHOP");
  await sleep(2500);
  ok("[REQ-0033#AC4] in-flight BIG chat not rendered into SHOP", $$(T("msg-user")).length === 0 && $$(T("msg-asst")).length === 0 && JSON.parse(localStorage.getItem("reqforge.chat.log.SHOP") || "[]").length === 0, txt(T("chat-messages")).slice(0, 200));
  ok("SHOP not busy", !$(T("chat-stop")) && !$(T("chat-send")).disabled);
  $(T("chat-close")).click();
}

// reqforge: verifies REQ-0033#AC3
async function deleteTest() {
  // ---------------------------------------------------------------- 11. delete TEST (make it active first)
  await switchTo("TEST");
  await openSwitcher(); $(T("switcher-manage")).click();
  await until(() => prow("TEST"), 8000);
  prow("TEST").querySelector(T("project-delete")).click();
  await until(() => $(T("delete-dialog")), 5000);
  const btn = () => $(T("delete-confirm"));
  ok("[REQ-0033#AC3] delete button disabled until key typed", btn().disabled);
  ok("[REQ-0033#AC3] delete dialog shows counts", /1 requirement, 0 epics, 0 stories, 0 tasks/.test(txt(T("delete-summary"))) && new RegExp(`${WS}/test`).test(txt(T("delete-summary"))) && /git history/.test(txt(T("delete-summary"))), txt(T("delete-summary")));
  ok("[REQ-0033#AC3] no GitHub checkbox without a remote", !$(T("delete-remote")));
  ok("[REQ-0033#AC3] confirmation field focused", document.activeElement === $(T("delete-confirm-input")), document.activeElement?.outerHTML.slice(0, 80));
  setVal($(T("delete-confirm-input")), "test"); await sleep(100);
  ok("[REQ-0033#AC3] wrong-case key keeps delete disabled", btn().disabled);
  setVal($(T("delete-confirm-input")), "TES"); await sleep(100);
  ok("[REQ-0033#AC3] partial key keeps delete disabled", btn().disabled);
  setVal($(T("delete-confirm-input")), "TEST"); await sleep(100);
  ok("[REQ-0033#AC3] exact key enables delete", !btn().disabled);
  btn().click();
  await until(() => !prow("TEST") && !$(T("delete-dialog")), 10000);
  const pl3 = await getJ("/api/projects");
  ok("[REQ-0033#AC3] TEST deleted (gone from GET /api/projects)", !pl3.projects.some((p) => p.key === "TEST") && pl3.projects.length === 2, pl3.projects.map((p) => p.key).join(","));
  ok("[REQ-0033#AC3] TEST gone from projects page", !prow("TEST") && $$(T("project-row")).length === 2);
  await until(() => /BIG/.test(project()), 5000);
  ok("[REQ-0033#AC3] active project switched to the new default BIG", /BIG/.test(project()) && prow("BIG")?.dataset.active === "true", project());
  ok("[REQ-0033#AC3] TEST localStorage cleared", !Object.keys(localStorage).some((k) => k.endsWith(".TEST")) && localStorage.getItem("reqforge.project") !== '"TEST"', Object.keys(localStorage).join(","));
  await openSwitcher();
  ok("[REQ-0033#AC3] TEST gone from switcher", $$(T("switcher-item")).length === 2 && !$(`${T("switcher-item")}[data-key="TEST"]`));
  press($(T("switcher-menu")), "Escape"); await until(() => !$(T("switcher-menu")), 3000);
  // ---------------------------------------------------------------- 12. projects page lists the remaining projects with counts
  const bigRow = prow("BIG"), shopRow = prow("SHOP");
  ok("projects page counts", bigRow.querySelector('[data-col="requirements"]').textContent === "3,041" && bigRow.querySelector('[data-col="changesets"]').textContent === "1" && shopRow.querySelector('[data-col="requirements"]').textContent === "4", bigRow.querySelector('[data-col="requirements"]').textContent);
  ok("projects page shows paths", new RegExp(`${WS}/big`).test(bigRow.textContent) && /local only/.test(bigRow.textContent));
  // unknown project in the hash
  location.hash = "#/p/NOPE";
  ok("unknown hash key falls back", await until(() => location.hash === "#/p/BIG" && /BIG/.test(project()), 8000), location.hash);
}

// reqforge: verifies REQ-0030#AC2
// reqforge: verifies REQ-0030#AC3
// reqforge: verifies REQ-0030#AC6
// reqforge: verifies REQ-0031#AC1
// reqforge: verifies REQ-0045#AC1
async function coreOnBig() {
  // ---------------------------------------------------------------- 13. core checks on the active project (BIG)
  await until(() => pagerTotal() === 3041, 15000);
  ok("BIG list after apply", pagerTotal() === 3041, pagerTotal());
  setVal($(T("page-size")), "50");
  await until(() => rows().length === 50);
  ok("[REQ-0030#AC3] paging: page size 50", rows().length === 50, rows().length);
  const first = rows()[0].dataset.id;
  $(T("next-page")).click();
  await until(() => /^51–100 of/.test(txt(T("pager-range"))) && rows()[0]?.dataset.id !== first);
  ok("[REQ-0030#AC3] paging: next page", /^51–100 of 3,041/.test(txt(T("pager-range"))), txt(T("pager-range")));
  $(`${T("tree-type")}[data-type="quality"]`).click();
  await until(() => /quality/.test(txt(T("crumbs"))));
  await until(() => $(`${T("tree-cat")}[data-category="security"]`));
  $(`${T("tree-cat")}[data-category="security"]`).click();
  await until(() => /security/.test(txt(T("crumbs"))) && pagerTotal() < 3041); await sleep(300);
  ok("[REQ-0030#AC2] drill-down quality › security", pagerTotal() > 0 && pagerTotal() < 500, pagerTotal());
  rows()[0].click();
  await until(() => $(T("drawer")) && /v\d+/.test(txt(T("drawer-title"))));
  ok("[REQ-0031#AC1] drawer opens", txt(T("drawer-title")).includes(rows()[0].dataset.id), txt(T("drawer-title")));
  press(document.body, "Escape");
  await until(() => !$(T("drawer")), 3000);
  ok("[REQ-0045#AC1] Esc closes drawer", !$(T("drawer")));
  $(T("tab-lint")).click();
  await until(() => /findings in/.test(txt(T("lint-summary"))), 15000);
  ok("[REQ-0030#AC6] lint view", $$(T("lint-row")).length > 0, txt(T("lint-summary")));
  $(T("tab-trace")).click();
  await until(() => $(T("trace-verdict")), 15000);
  ok("[REQ-0030#AC6] trace view", /PASS|FAIL/.test(txt(T("trace-verdict"))), txt(T("trace-verdict")));
  ok("tab persisted per project", localStorage.getItem("reqforge.tab.BIG") === '"trace"', localStorage.getItem("reqforge.tab.BIG"));
  await switchTo("SHOP");
  ok("[REQ-0033#AC4] switch resets filters/paging (SHOP list unfiltered)", /SHOP/.test(project()) && $(T("list-view")) && await listReady(4) && !/security/.test(txt(T("crumbs"))), txt(T("crumbs")) + " " + pagerTotal());
  $(T("tab-requirements")).click(); await sleep(300);
}
