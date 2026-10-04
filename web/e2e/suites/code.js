// Suite "code": code traceability UI (verification column/facet, Code & evidence drawer, Verification dashboard:
// scan, ingest, impact; Components tab) on a workspace holding SHOP (examples/seed_demo.py: tagged code component
// `web` in <ws>/shop-code with CI evidence, plus one uncommitted change to shop/checkout.py for impact analysis)
// and BIG (examples/seed_large.py, 3,040 requirements, no components).
// Demo-data ids are spelled as "demo req N" in check names: a requirement id in a JUnit test name counts as evidence.

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const R1 = "REQ-0001", R2 = "REQ-0002", R3 = "REQ-0003", R4 = "REQ-0004";
// reqforge:on

const switchTo = async (key) => {
  await openSwitcher();
  $(`${T("switcher-item")}[data-key="${key}"]`).click();
  return until(() => location.hash === `#/p/${key}` && project().endsWith(key) && $(T("main")), 10000);
};
const chip = (v) => $(`${T("verif-chip")}[data-value="${v}"]`);
const badgeOf = (id) => $(`${T("row")}[data-id="${id}"] td[data-col="_verification"] ${T("verif-badge")}`);
const openReq = async (id) => {
  $(`${T("row")}[data-id="${id}"]`).click();
  await until(() => $(T("drawer")) && new RegExp(id + " · v").test(txt(T("drawer-title"))) && $(T("drawer-tab-code")), 8000);
  mdown($(T("drawer-tab-code")));
  return until(() => $(T("code-panel")), 8000);
};
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const ac = (a) => $(`${T("ac-verif")}[data-ac="${a}"]`);
const cnt = (k, s) => $(`${T("verif-count")}[data-kind="${k}"][data-status="${s}"]`)?.dataset.count;

async function suite() {
  await verificationColumnAndFacet();
  await codeEvidenceDrawer();
  await dashboard();
  await scanAndIngest();
  await impact();
  await componentsAndStories();
  await bigWithoutComponents();
  await coreOnBig();
}

// reqforge: verifies REQ-0034#AC1
async function verificationColumnAndFacet() {
  // ---------------------------------------------------------------- 1. verification column
  await until(() => rows().length === 4 && badgeOf(R4), 15000);
  const want = { [R1]: "failing", [R2]: "suspect", [R3]: "verified", [R4]: "pending" };
  const got = Object.keys(want).map((id) => [id, badgeOf(id)?.dataset.status, badgeOf(id)?.textContent.trim()]);
  ok("[REQ-0034#AC1] verification column: statuses + labels for demo reqs 1..4", got.every(([id, s, l]) => s === want[id] && l === want[id]), JSON.stringify(got));
  ok("[REQ-0034#AC1] verification column header, not sortable", $$("th").some((th) => /^verification$/.test(th.textContent.trim()) && !th.dataset.testid), $$("th").map((t) => t.textContent).join("|"));
  const cls = Object.fromEntries(Object.keys(want).map((id) => [want[id], badgeOf(id).className]));
  ok("badge colours differ per status (err/warn/ok/info)", /text-err/.test(cls.failing) && /text-warn/.test(cls.suspect) && /text-ok/.test(cls.verified) && /text-info/.test(cls.pending), JSON.stringify(cls));
  // ---------------------------------------------------------------- 2. verification facet
  await until(() => chip("failing"), 8000);
  const fc = Object.fromEntries(["failing", "suspect", "untested", "pending", "verified"].map((v) => [v, chip(v)?.dataset.count]));
  ok("[REQ-0034#AC1] Verification facet counts (failing 1, suspect 1, verified 1, pending 1, untested 0)", fc.failing === "1" && fc.suspect === "1" && fc.verified === "1" && fc.pending === "1" && fc.untested === "0", JSON.stringify(fc));
  ok("[REQ-0034#AC1] facet chips show label text", /suspect\s*1/.test(chip("suspect").textContent), chip("suspect").textContent);
  chip("suspect").click();
  await until(() => pagerTotal() === 1, 8000);
  ok("[REQ-0034#AC1] click suspect filters to demo req 2", rowIds() === R2 && chip("suspect").getAttribute("aria-pressed") === "true", rowIds());
  ok("[REQ-0034#AC1] filter pill verification: suspect", /verification: suspect/.test(txt(T("crumbs"))), txt(T("crumbs")));
  ok("[REQ-0034#AC1] facet counts ignore own filter", chip("failing").dataset.count === "1", chip("failing").dataset.count);
  chip("failing").click();
  await until(() => pagerTotal() === 2, 8000);
  ok("[REQ-0034#AC1] multi-select OR (failing|suspect)", rowIds() === `${R1},${R2}` && /verification: suspect\|failing/.test(txt(T("crumbs"))), rowIds() + " " + txt(T("crumbs")));
  chip("failing").click(); await until(() => pagerTotal() === 1, 8000);
  chip("suspect").click(); await until(() => pagerTotal() === 4, 8000);
  ok("[REQ-0034#AC1] toggle off restores all", pagerTotal() === 4, pagerTotal());
  ok("tree shows verified indicator", await until(() => $$(T("tree-verified")).length > 0, 5000), $$(T("tree-verified")).length);
}

// reqforge: verifies REQ-0031#AC3
async function codeEvidenceDrawer() {
  // ---------------------------------------------------------------- 3. drawer: Code & evidence
  const v1 = await getJ(`/api/p/SHOP/verification?req=${R1}`);
  const sha = (v1.acs.AC2.evidence[0] || {}).commit || "";
  ok("[REQ-0031#AC3] drawer Code & evidence tab opens for demo req 1", await openReq(R1), txt(T("drawer-title")));
  ok("[REQ-0031#AC3] demo req 1 overall failing", $(T("code-status"))?.dataset.status === "failing" && /failing/.test(txt(T("code-status"))), txt(T("code-status")));
  const impl = $(T("impl-loc"));
  ok("[REQ-0031#AC3] implemented by shop/checkout.py place_order", !!impl && /shop\/checkout\.py:3/.test(impl.textContent) && impl.querySelector(T("code-symbol"))?.textContent === "place_order", impl?.textContent);
  const href = impl?.querySelector("a")?.getAttribute("href");
  ok("[REQ-0031#AC3] implementation links to repo blob URL", href === "https://github.com/acme/shop-web/blob/HEAD/shop/checkout.py#L3", href);
  ok("[REQ-0031#AC3] AC1 verified with test_guest_can_pay", ac("AC1")?.dataset.status === "verified" && /verified/.test(ac("AC1").querySelector(T("ac-status")).textContent) && [...ac("AC1").querySelectorAll(T("test-loc"))].some((t) => /test_guest_can_pay/.test(t.textContent) && /tests\/checkout\/test_guest\.py:4/.test(t.textContent)), ac("AC1")?.textContent);
  const ev2 = ac("AC2")?.querySelector(T("evidence-row"));
  ok("[REQ-0031#AC3] AC2 failing with failed evidence", ac("AC2")?.dataset.status === "failing" && ev2?.dataset.status === "failed" && /test_declined_card_creates_no_order/.test(ev2.textContent), ac("AC2")?.textContent);
  ok("[REQ-0031#AC3] evidence shows short commit", ev2?.querySelector(T("evidence-commit"))?.textContent === sha.slice(0, 8) && sha.length > 8, ev2?.querySelector(T("evidence-commit"))?.textContent + " vs " + sha);
  ok("[REQ-0031#AC3] evidence run link", ev2?.querySelector(T("run-link"))?.getAttribute("href") === "https://github.com/acme/shop-web/actions/runs/1", ev2?.querySelector(T("run-link"))?.getAttribute("href"));
  ok("[REQ-0031#AC3] covering evals listed", [...ac("AC1").querySelectorAll(T("ac-eval"))].some((e) => /STORY-0001\/E1/.test(e.textContent)), ac("AC1")?.textContent);
  await closeDrawer();
  ok("[REQ-0031#AC3] demo req 2 drawer", await openReq(R2));
  ok("[REQ-0031#AC3] demo req 2 suspect with changed shop/psp.py", $(T("code-status"))?.dataset.status === "suspect" && ac("AC1")?.dataset.status === "suspect" && !!$(`${T("changed-file")}[data-file="shop/psp.py"]`), txt(T("code-panel")).slice(0, 300));
  await closeDrawer();
}

// reqforge: verifies REQ-0034#AC2
async function dashboard() {
  // ---------------------------------------------------------------- 4. dashboard
  $(T("tab-verification")).click();
  ok("[REQ-0034#AC2] Verification dashboard loads", await until(() => $(T("verif-gate")) && $(T("comp-row")), 10000), txt(T("main")).slice(0, 200));
  const rep = await getJ("/api/p/SHOP/verification");
  ok("[REQ-0034#AC2] gate FAIL", /FAIL/.test(txt(T("verif-gate"))) && rep.ok === false, txt(T("verif-gate")));
  ok("[REQ-0034#AC2] verified ratio 40%", /40%/.test(txt(T("verif-ratio"))), txt(T("verif-ratio")));
  ok("[REQ-0034#AC2] criteria counts by status", ["failing", "suspect", "untested", "pending", "verified"].every((s) => cnt("criteria", s) === String(rep.summary.criteria[s])), JSON.stringify(rep.summary.criteria));
  ok("[REQ-0034#AC2] requirement counts by status", ["failing", "suspect", "pending", "verified"].every((s) => cnt("requirements", s) === "1"), ["failing", "suspect", "pending", "verified"].map((s) => cnt("requirements", s)).join(","));
  const crow = $(`${T("comp-row")}[data-key="web"]`);
  ok("[REQ-0034#AC2] component web row (commit, scan time, counts)", !!crow && crow.textContent.includes(rep.summary.components[0].commit.slice(0, 8)) && crow.querySelector(T("comp-implements")).textContent === "2" && crow.querySelector(T("comp-verifies")).textContent === "4" && !!crow.querySelector(T("comp-scanned")).dataset.at, crow?.textContent);
  const chk = (id) => $(`${T("verif-check")}[data-id="${id}"]`);
  ok("[REQ-0034#AC2] checks: evidence-failing fails with demo req 1 link", chk("evidence-failing")?.dataset.passed === "false" && !!chk("evidence-failing").querySelector(`${T("id-link")}[data-id="${R1}"]`), chk("evidence-failing")?.textContent);
  ok("[REQ-0034#AC2] checks: evidence-suspect fails with demo req 2 link", chk("evidence-suspect")?.dataset.passed === "false" && !!chk("evidence-suspect").querySelector(`${T("id-link")}[data-id="${R2}"]`), chk("evidence-suspect")?.textContent);
  chk("evidence-suspect").querySelector(`${T("id-link")}[data-id="${R2}"]`).click();
  ok("check req link opens drawer", await until(() => new RegExp(R2 + " · v").test(txt(T("drawer-title"))), 5000), txt(T("drawer-title")));
  await closeDrawer();
  $(`${T("verif-count")}[data-kind="requirements"][data-status="suspect"]`).click();
  await until(() => $(T("list-view")) && pagerTotal() === 1, 8000);
  ok("[REQ-0034#AC1] count click → requirements filtered verification=suspect", rowIds() === R2 && /verification: suspect/.test(txt(T("crumbs"))), rowIds() + " " + txt(T("crumbs")));
  $(T("tab-verification")).click();
  await until(() => $(T("comp-row")), 8000);
}

// reqforge: verifies REQ-0034#AC3
async function scanAndIngest() {
  // ---------------------------------------------------------------- 5. scan now
  const before = $(T("comp-scanned")).dataset.at;
  await sleep(1200);
  $(T("scan-all")).click();
  ok("[REQ-0034#AC2] scan toast", await until(() => $$("[data-sonner-toast]").some((t) => /scanned web/.test(t.textContent)), 10000), $$("[data-sonner-toast]").map((t) => t.textContent).join("|"));
  ok("[REQ-0034#AC2] scanned_at updates", await until(() => $(T("comp-scanned"))?.dataset.at && $(T("comp-scanned")).dataset.at !== before, 10000), before + " -> " + $(T("comp-scanned"))?.dataset.at);
  const code = await getJ("/api/p/SHOP/code");
  ok("[REQ-0034#AC2] scan persisted (GET /code)", code.indexes[0].scanned_at !== before, code.indexes[0].scanned_at);
  // ---------------------------------------------------------------- 6. ingest
  $(T("ingest-open")).click();
  await until(() => $(T("ingest-dialog")), 5000);
  ok("[REQ-0034#AC3] ingest submit disabled without file", $(T("ingest-submit")).disabled);
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest"><testcase classname="tests.checkout.test_guest" name="test_declined_card_creates_no_order" time="0.2"/></testsuite></testsuites>`;
  const dt = new DataTransfer(); dt.items.add(new File([xml], "junit-rerun.xml", { type: "application/xml" }));
  const inp = $(T("ingest-file")); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => /junit-rerun\.xml/.test(txt(T("ingest-files"))), 3000);
  setVal($(T("ingest-component")), "web");
  setVal($(T("ingest-run")), "https://github.com/acme/shop-web/actions/runs/2");
  await sleep(100);
  $(T("ingest-submit")).click();
  ok("[REQ-0034#AC3] ingest result shown", await until(() => $(T("ingest-result")), 10000), txt(T("ingest-error")));
  ok("[REQ-0034#AC3] ingest: 1 case, 1 matched, 0 unmatched", txt(T("ingest-cases")) === "1" && txt(T("ingest-matched")) === "1" && /0 unmatched/.test(txt(T("ingest-result"))), txt(T("ingest-result")));
  const v1b = await getJ(`/api/p/SHOP/verification?req=${R1}`);
  ok("[REQ-0034#AC3] demo req 1 AC2 now verified, overall not failing", v1b.acs.AC2.status === "verified" && v1b.status !== "failing", v1b.status + " / AC2 " + v1b.acs.AC2.status);
  press(document.activeElement || document.body, "Escape");
  await until(() => !$(T("ingest-dialog")), 3000);
  await until(() => cnt("requirements", "failing") === "0", 8000);
  ok("[REQ-0034#AC3] dashboard refreshed (no failing requirements)", cnt("requirements", "failing") === "0", cnt("requirements", "failing"));
}

// reqforge: verifies REQ-0034#AC4
async function impact() {
  // ---------------------------------------------------------------- 7. impact
  ok("[REQ-0034#AC4] impact defaults (web, main)", $(T("impact-component")).value === "web" && $(T("impact-base")).value === "main", $(T("impact-component")).value + " " + $(T("impact-base")).value);
  $(T("impact-run")).click();
  await until(() => $(T("impact-result")) || $(T("impact-error")), 10000);
  const ir = $(`${T("impact-req")}[data-id="${R1}"]`);
  ok("[REQ-0034#AC4] impact lists demo req 1", !!ir && !!ir.querySelector(T("id-link")), txt(T("impact-result")) + txt(T("impact-error")));
  ok("[REQ-0034#AC4] impact lists tests/checkout/test_guest.py", !!$(`${T("impact-test")}[data-file="tests/checkout/test_guest.py"]`), txt(T("impact-result")));
  ok("[REQ-0034#AC4] impact lists changed shop/checkout.py", $$(T("impact-file")).some((f) => /shop\/checkout\.py/.test(f.textContent)), $$(T("impact-file")).map((f) => f.textContent).join(","));
  setVal($(T("impact-base")), "no-such-ref"); await sleep(100);
  $(T("impact-run")).click();
  ok("[REQ-0034#AC4] impact bad base ref → error shown", await until(() => $(T("impact-error")), 10000), txt(T("impact-panel")).slice(0, 200));
  // ---------------------------------------------------------------- 8. drawer after ingest
  $(T("tab-requirements")).click();
  await until(() => rows().length === 4 && badgeOf(R1), 10000);
  await until(() => badgeOf(R1)?.dataset.status !== "failing", 8000); // list refetches after the ingest invalidation
  ok("[REQ-0034#AC3] list badge demo req 1 no longer failing", badgeOf(R1)?.dataset.status !== "failing", badgeOf(R1)?.dataset.status);
  await openReq(R1);
  ok("[REQ-0034#AC3] drawer AC2 verified after ingest", await until(() => ac("AC2")?.dataset.status === "verified", 5000), ac("AC2")?.dataset.status);
  await closeDrawer();
}

async function componentsAndStories() {
  // ---------------------------------------------------------------- 9. components tab
  $(T("tab-components")).click();
  await until(() => $(T("list-view"))?.dataset.kind === "components" && rows().length === 1, 8000);
  const cr = rows()[0];
  ok("Components tab lists web", cr?.dataset.id === "COMP-0001" && cr.querySelector('td[data-col="key"]').textContent === "web" && /python/.test(cr.textContent) && /checkout-team/.test(cr.textContent), cr?.textContent);
  ok("components facets", !!$(`${T("facet-chip")}[data-facet="language"][data-value="python"]`));
  cr.click();
  await until(() => $(T("f_key")), 8000);
  ok("component drawer form (key, globs, owners lists)", $(T("f_key")).value === "web" && $(T("f_owners")).value === "checkout-team" && !!$(T("f_globs")) && /shop-code/.test($(T("f_path")).value), $(T("f_key"))?.value + " " + $(T("f_owners"))?.value);
  await closeDrawer();
  // ---------------------------------------------------------------- 10. story component select
  $(T("tab-stories")).click();
  await until(() => $(T("list-view"))?.dataset.kind === "stories" && rows().length > 0, 8000);
  rows()[0].click();
  await until(() => $(T("f_component")), 8000);
  await until(() => $$("#complist option").length > 0, 5000);
  ok("story drawer offers component keys", $(T("f_component")).getAttribute("list") === "complist" && $$("#complist option").map((o) => o.value).join(",") === "web" && $(T("f_component")).value === "web", $$("#complist option").map((o) => o.value).join(","));
  setVal($(T("f_component")), "nope"); await sleep(150);
  ok("unknown component key warned", !!$(T("component-unknown")));
  await closeDrawer();
}

async function bigWithoutComponents() {
  // ---------------------------------------------------------------- 11. BIG: no components
  $(T("tab-requirements")).click();
  ok("switch to BIG", await switchTo("BIG"), location.hash + " " + project());
  await until(() => pagerTotal() === 3040, 15000);
  ok("BIG list 3,040", pagerTotal() === 3040, pagerTotal());
  await until(() => chip("untested"), 8000);
  ok("[REQ-0034#AC1] BIG facet: untested + pending, no verified", +chip("untested").dataset.count > 0 && +chip("pending").dataset.count > 0 && chip("verified").dataset.count === "0", ["untested", "pending", "verified"].map((v) => chip(v)?.dataset.count).join(","));
  ok("[REQ-0034#AC1] BIG rows have badges", rows().every((r) => r.querySelector(`td[data-col="_verification"] ${T("verif-badge")}`)), rows().length);
  chip("untested").click();
  await until(() => pagerTotal() === +chip("untested").dataset.count, 8000);
  ok("[REQ-0034#AC1] BIG untested filter", rows().every((r) => r.querySelector(T("verif-badge")).dataset.status === "untested"), pagerTotal());
  rows()[0].click();
  await until(() => $(T("drawer-tab-code")), 8000);
  mdown($(T("drawer-tab-code")));
  await until(() => $(T("code-panel")), 8000);
  ok("[REQ-0031#AC3] BIG drawer: untested, empty states teach tag syntax", $(T("code-status"))?.dataset.status === "untested" && !!$(T("impl-empty")) && $$(T("tag-snippet")).some((s) => /# reqforge: implements REQ-\d+/.test(s.textContent)) && $$(T("tag-snippet")).some((s) => /@pytest\.mark\.req\("REQ-\d+#AC1"\)/.test(s.textContent)) && $$(T("tag-snippet")).some((s) => /^test\("\[REQ-\d+#AC1\] …/.test(s.textContent)), txt(T("code-panel")).slice(0, 300));
  ok("[REQ-0031#AC3] BIG drawer: no components hint", /No code components/.test(txt(T("impl-empty"))), txt(T("impl-empty")));
  await closeDrawer();
  $(T("tab-verification")).click();
  ok("[REQ-0034#AC2] BIG dashboard: no-components state", await until(() => $(T("no-components")) && $(T("verif-gate")), 10000), txt(T("main")).slice(0, 200));
  ok("[REQ-0034#AC2] BIG dashboard: scan disabled, impact empty", $(T("scan-all")).disabled && $(T("impact-run")).disabled, "");
  ok("[REQ-0034#AC2] BIG dashboard: untested count", +$(`${T("verif-count")}[data-kind="criteria"][data-status="untested"]`).dataset.count > 0);
  $(T("tab-components")).click();
  await until(() => $(T("list-view"))?.dataset.kind === "components", 8000); await sleep(500);
  ok("BIG components tab empty", rows().length === 0 && pagerTotal() === 0 && !$(T("list-error")), pagerTotal());
}

// reqforge: verifies REQ-0030#AC3
// reqforge: verifies REQ-0030#AC6
// reqforge: verifies REQ-0031#AC1
async function coreOnBig() {
  // ---------------------------------------------------------------- 12. core subset on BIG
  $(T("tab-requirements")).click();
  await until(() => pagerTotal() === 3040, 10000);
  setVal($(T("page-size")), "50");
  await until(() => rows().length === 50);
  ok("[REQ-0030#AC3] paging: page size 50", rows().length === 50, rows().length);
  const first = rows()[0].dataset.id;
  $(T("next-page")).click();
  await until(() => /^51–100 of/.test(txt(T("pager-range"))) && rows()[0]?.dataset.id !== first);
  ok("[REQ-0030#AC3] paging: next page", /^51–100 of 3,040/.test(txt(T("pager-range"))), txt(T("pager-range")));
  rows()[0].click();
  await until(() => $(T("drawer")) && /v\d+/.test(txt(T("drawer-title"))));
  ok("[REQ-0031#AC1] drawer opens", txt(T("drawer-title")).includes(rows()[0].dataset.id), txt(T("drawer-title")));
  await closeDrawer();
  $(T("tab-lint")).click();
  await until(() => /findings in/.test(txt(T("lint-summary"))), 15000);
  ok("[REQ-0030#AC6] lint view", $$(T("lint-row")).length > 0, txt(T("lint-summary")));
  $(T("tab-trace")).click();
  await until(() => $(T("trace-verdict")), 15000);
  ok("[REQ-0030#AC6] trace view", /PASS|FAIL/.test(txt(T("trace-verdict"))), txt(T("trace-verdict")));
  ok("projects switcher back to SHOP", await switchTo("SHOP") && await until(() => $(T("trace-verdict")) || $(T("list-view")), 8000), project());
  $(T("tab-verification")).click();
  ok("SHOP dashboard after switch shows SHOP data", await until(() => $(`${T("comp-row")}[data-key="web"]`), 8000));
  $(T("tab-requirements")).click(); await sleep(300);
}
