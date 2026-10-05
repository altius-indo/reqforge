// Suite "decisions": the Decisions tab (REQ-0061#AC4) on the SHOP demo (examples/seed_demo.py) whose code component
// carries decision tags written by run.mjs (writeDecisionCode): the first decision's code and passing test, the second
// one's code and failing test. The suite starts with no decisions (empty state), then creates four through changesets,
// the only way decisions are written: 1 accepted and exercised, 2 accepted with a failing test, 3 proposed with no
// tags, 4 superseded by 1.
// Demo-data and decision ids are spelled as "demo req N" / "decision N" in check names: a record id in a JUnit test
// name counts as evidence. Helpers (ok, until, T, $, $$, sendJ, mdown, …) come from web/e2e/lib/prelude.js.

// reqforge:off (fixture ids from the seeded demo data and the decisions this suite creates)
const R1 = "REQ-0001", R2 = "REQ-0002", R3 = "REQ-0003";
const D1 = "DEC-0001", D2 = "DEC-0002", D3 = "DEC-0003", D4 = "DEC-0004";
// reqforge:on
const DECISIONS = [
  { title: "Store orders in Postgres", context: "Orders need transactions.", decision: "Postgres 16 holds orders.", status: "accepted", requirements: [R1, R3] },
  { title: "Retry PSP charges with backoff", context: "The PSP times out under load.", decision: "Three retries, exponential backoff.", status: "accepted", requirements: [R1] },
  { title: "Hosted card fields only", context: "PCI scope.", decision: "Card data only in PSP-hosted fields.", requirements: [R2] },
];
const SUPERSEDED = { title: "Store orders in MySQL", context: "Early prototype.", decision: "MySQL 8 holds orders.", status: "superseded", superseded_by: D1, requirements: [R1] };

const row = (id) => $(`${T("decision-row")}[data-id="${id}"]`);
const cell = (id, t) => row(id)?.querySelector(T(t));
const drawerShows = (id) => until(() => $(T("drawer")) && new RegExp(id + " · v").test(txt(T("drawer-title"))), 8000);
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const openTab = async () => {
  $(T("tab-decisions")).click();
  return until(() => $(T("decisions-view")) || $(T("decisions-empty")), 8000);
};

/** propose + apply one changeset creating `rows` as decisions */
async function createDecisions(rows) {
  const p = await sendJ("POST", "/api/changesets", { title: "e2e decisions", ops: rows.map((data) => ({ op: "create", kind: "decisions", data })) });
  if (p.status !== 201 || !p.body?.valid) return `propose ${p.status}: ${JSON.stringify(p.body).slice(0, 300)}`;
  const a = await sendJ("POST", `/api/changesets/${p.body.changeset_id}/apply`, {});
  return a.status === 200 ? "" : `apply ${a.status}: ${JSON.stringify(a.body).slice(0, 300)}`;
}

async function suite() {
  await until(() => $(T("tab-decisions")), 15000);
  ok("[REQ-0061#AC4] Decisions tab in the header nav", txt(T("tab-decisions")).trim() === "Decisions", txt(T("tabs")));
  await emptyState();
  // switch away so the Decisions tab loads fresh data when it is opened again
  $(T("tab-requirements")).click();
  await until(() => rows().length > 0, 8000);
  const err = (await createDecisions(DECISIONS)) || (await createDecisions([SUPERSEDED]));
  ok("decisions created through changesets", !err, err);
  ok("[REQ-0061#AC4] tab opens with the decisions", await openTab() && await until(() => $$(T("decision-row")).length === 4, 8000),
    txt(T("main")).slice(0, 200));
  await listing();
  await drawer();
}

// reqforge: verifies REQ-0061#AC4
async function emptyState() {
  ok("tab opens", await openTab(), txt(T("main")).slice(0, 200));
  ok("[REQ-0061#AC4] empty state when there are no decisions", !!$(T("decisions-empty")) && !$(T("decision-row")), txt(T("main")).slice(0, 200));
}

// reqforge: verifies REQ-0061#AC4
async function listing() {
  const ids = $$(T("decision-row")).map((r) => r.dataset.id);
  ok("[REQ-0061#AC4] every decision listed, sorted by id", ids.join(",") === [D1, D2, D3, D4].join(","), ids.join(","));
  ok("[REQ-0061#AC4] decisions listed with their titles",
    [...DECISIONS, SUPERSEDED].every((d, i) => row(ids[i])?.textContent.includes(d.title)), $$(T("decision-row")).map((r) => r.textContent).join(" | "));

  const statuses = [D1, D2, D3, D4].map((id) => cell(id, "decision-status")?.textContent);
  ok("[REQ-0061#AC4] status of each decision shown", statuses.join(",") === "accepted,accepted,proposed,superseded", statuses.join(","));
  ok("[REQ-0061#AC4] a superseded decision names the decision that superseded it",
    !!row(D4)?.querySelector(`${T("id-link")}[data-id="${D1}"]`), row(D4)?.textContent);

  const flags = [D1, D2, D3, D4].map((id) => cell(id, "decision-exercised")?.dataset.exercised);
  ok("[REQ-0061#AC4] exercised flag: yes only for the decision with tagged code and a passing tagged test",
    flags.join(",") === "yes,no,no,no", flags.join(","));
  ok("[REQ-0061#AC4] exercised flag reads yes / no", cell(D1, "decision-exercised")?.textContent === "yes" && cell(D2, "decision-exercised")?.textContent === "no",
    `${cell(D1, "decision-exercised")?.textContent} ${cell(D2, "decision-exercised")?.textContent}`);
  ok("not exercised: a failing tagged test is the reason (decision 2)", /failing/.test(cell(D2, "decision-reason")?.textContent || ""), cell(D2, "decision-reason")?.textContent);
  ok("not exercised: no tagged code is the reason (decision 3)", /no code is tagged/.test(cell(D3, "decision-reason")?.textContent || ""), cell(D3, "decision-reason")?.textContent);
  ok("an exercised decision shows no reason", !cell(D1, "decision-reason"), cell(D1, "decision-reason")?.textContent);

  const reqs = (id) => [...(cell(id, "decision-reqs")?.querySelectorAll(T("id-link")) || [])].map((a) => a.dataset.id).join(",");
  ok("[REQ-0061#AC4] linked requirements shown as record links",
    reqs(D1) === [R1, R3].join(",") && reqs(D2) === R1 && reqs(D3) === R2 && reqs(D4) === R1, [D1, D2, D3, D4].map(reqs).join(" | "));

  ok("summary counts: 4 decisions, 1 exercised, 1 accepted but not exercised",
    /^4/.test(txt(T("decisions-count"))) && /^1/.test(txt(T("decisions-exercised-count"))) && /^1/.test(txt(T("decisions-unexercised-accepted"))),
    `${txt(T("decisions-count"))} ${txt(T("decisions-exercised-count"))} ${txt(T("decisions-unexercised-accepted"))}`);

  // a linked requirement opens the requirement, not the decision
  cell(D3, "decision-reqs").querySelector(`${T("id-link")}[data-id="${R2}"]`).click();
  ok("a linked requirement opens demo req 2 in the drawer", await drawerShows(R2), txt(T("drawer-title")));
  await closeDrawer();
}

// reqforge: verifies REQ-0061#AC4
async function drawer() {
  // decision 1: exercised, with its implementing code and passing test
  row(D1).querySelector("td:nth-child(2)").click();
  ok("a row opens the decision in the drawer", await drawerShows(D1), txt(T("drawer-title")));
  ok("drawer opens on the Exercised tab", await until(() => $(T("exercised-panel")), 8000), txt(T("drawer")).slice(0, 300));
  const panel = () => $(T("exercised-panel"));
  ok("drawer: decision 1 exercised yes", panel()?.querySelector(T("decision-exercised"))?.dataset.exercised === "yes", panel()?.textContent);
  const files = (t) => $$(T(t)).map((l) => l.dataset.file).join(",");
  ok("drawer shows the tagged implementing location", files("decision-impl-loc") === "shop/orders.py" && /save_order/.test(txt(T("exercised-implements"))),
    txt(T("exercised-implements")));
  ok("drawer shows the tagged test location with its status",
    files("decision-test-loc") === "tests/test_decisions.py" && $$(T("decision-test")).map((t) => t.dataset.status).join(",") === "passed"
      && /test_orders_are_persisted/.test(txt(T("exercised-tests"))), txt(T("exercised-tests")));
  mdown($(T("drawer-tab-details")));
  ok("decision details are read-only (changesets only)",
    await until(() => $(T("decision-readonly")), 4000) && !$(T("drawer-save")) && !$(T("drawer-delete")) && $(T("details-form"))?.disabled === true,
    txt(T("drawer")).slice(0, 300));
  await closeDrawer();

  // decision 2: failing tagged test
  row(D2).querySelector("td:nth-child(2)").click();
  await drawerShows(D2);
  await until(() => $(T("exercised-panel")), 8000);
  ok("drawer: decision 2 not exercised, with the failing test and the reason",
    $(T("exercised-panel"))?.querySelector(T("decision-exercised"))?.dataset.exercised === "no"
      && $$(T("decision-test")).map((t) => t.dataset.status).join(",") === "failing" && /failing/.test(txt(T("exercised-reason"))),
    txt(T("exercised-panel")));
  await closeDrawer();

  // decision 3: nothing tagged
  row(D3).querySelector("td:nth-child(2)").click();
  await drawerShows(D3);
  await until(() => $(T("exercised-panel")), 8000);
  ok("drawer: decision 3 says no code and no test is tagged",
    !!$(T("exercised-no-impl")) && !!$(T("exercised-no-tests")) && !$(T("decision-impl-loc")), txt(T("exercised-panel")));
  await closeDrawer();

  // the superseded decision's link opens the decision that replaced it
  row(D4).querySelector(`${T("id-link")}[data-id="${D1}"]`).click();
  ok("the superseded-by link opens decision 1", await drawerShows(D1), txt(T("drawer-title")));
  await closeDrawer();
  ok("Decisions tab still shown after closing the drawer", !!$(T("decisions-view")), txt(T("main")).slice(0, 200));
}
