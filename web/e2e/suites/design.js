// Suite "design": the Design tab (REQ-0055) on a workspace holding SHOP (examples/seed_demo.py plus three design
// documents written by run.mjs: design/a-overview.md, checkout-flow.md and card-security.md) and BARE (the same demo
// data, no design/ directory). Phase 1 drives SHOP; phase 2 reloads into BARE for the empty state.
// Demo-data ids are spelled as "demo req N" in check names: a requirement id in a JUnit test name counts as evidence.
// Helpers (ok, until, T, $, $$, mdown, reloadInto, …) come from web/e2e/lib/prelude.js.

// reqforge:off (fixture ids from the seeded demo data and run.mjs's design documents, not reqforge's own requirements)
const R1 = "REQ-0001", R2 = "REQ-0002", R3 = "REQ-0003", R4 = "REQ-0004", S1 = "STORY-0001", T1 = "TASK-0001";
// reqforge:on
// slug order (titles are deliberately not in the same order)
const DOCS = [["a-overview", "Zeta overview"], ["card-security", "Card data security"], ["checkout-flow", "Checkout flow"]];

const items = () => $$(T("design-item"));
const docSlug = () => $(T("design-doc"))?.dataset.slug;
const bodyReady = () => until(() => $(`${T("design-body")} .md`), 8000);
const selectDoc = async (slug) => {
  $(`${T("design-item")}[data-slug="${slug}"]`).click();
  // until() returns a promise: await the slug first, or bodyReady() would see the previous document's body
  return (await until(() => docSlug() === slug, 4000)) && (await bodyReady());
};
const drawerShows = (id) => until(() => $(T("drawer")) && new RegExp(id + " · v").test(txt(T("drawer-title"))), 8000);
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const openDesignTab = async () => { $(T("tab-design")).click(); return until(() => $(T("design-view")) || $(T("design-empty")), 8000) };

async function suite() {
  if (phase === "1") return phaseOne();
  if (phase === "2") return phaseTwo();
}

async function phaseOne() {
  await until(() => project().endsWith("SHOP") && $(T("tab-design")), 15000);
  ok("Design tab in the header nav", !!$(T("tab-design")) && txt(T("tab-design")).trim() === "Design", txt(T("tabs")));
  ok("design tab opens", await openDesignTab(), txt(T("main")).slice(0, 200));
  await documentList();
  await markdown();
  await recordLinks();
  await drawerLinks();
  reloadInto(2, "#/p/BARE");
}

// reqforge: verifies REQ-0055#AC1
async function documentList() {
  await until(() => items().length === DOCS.length, 8000);
  const got = items().map((b) => [b.dataset.slug, b.textContent]);
  ok("[REQ-0055#AC1] every design document listed, sorted by slug",
    got.length === DOCS.length && DOCS.every(([s], i) => got[i][0] === s), got.map((g) => g[0]).join(","));
  ok("[REQ-0055#AC1] documents listed by title",
    DOCS.every(([, t], i) => got[i] && got[i][1].includes(t)), got.map((g) => g[1]).join(" | "));
  ok("first document selected by default", docSlug() === DOCS[0][0] && txt(T("design-title")).includes(DOCS[0][1]), `${docSlug()} ${txt(T("design-title"))}`);
}

// reqforge: verifies REQ-0055#AC2
async function markdown() {
  ok("selecting a document shows it", await selectDoc("checkout-flow"), `${docSlug()} ${txt(T("design-body")).slice(0, 120)}`);
  const md = $(`${T("design-body")} .md`);
  const table = md?.querySelector("table");
  ok("[REQ-0055#AC2] GFM table rendered",
    !!table && table.querySelectorAll("th").length === 2 && table.querySelectorAll("tbody tr").length === 2, md?.innerHTML.slice(0, 300));
  const code = md?.querySelector("pre code");
  ok("[REQ-0055#AC2] fenced code block rendered", !!code && /place_order\(cart\)/.test(code.textContent), md?.innerHTML.slice(0, 300));
  ok("[REQ-0055#AC2] headings and lists rendered", !!md?.querySelector("h2") && !!md?.querySelector("ul li"), md?.innerHTML.slice(0, 300));
  ok("[REQ-0055#AC2] front matter not shown in the body", !/realises:|^\s*---/m.test(md?.textContent || ""), (md?.textContent || "").slice(0, 120));
}

// reqforge: verifies REQ-0055#AC3
async function recordLinks() {
  const realises = $$(`${T("design-realises")} ${T("id-link")}`).map((a) => a.dataset.id);
  ok("[REQ-0055#AC3] realises list shown with linked ids", realises.join(",") === [R1, R3].join(","), realises.join(","));
  const bodyIds = $$(`${T("design-body")} ${T("id-link")}`).map((a) => a.dataset.id);
  ok("[REQ-0055#AC3] REQ-, STORY- and TASK- ids in the body are links",
    [R2, S1, T1].every((x) => bodyIds.includes(x)), bodyIds.join(","));
  ok("ids inside code blocks stay plain text", !$(`${T("design-body")} pre ${T("id-link")}`), $(`${T("design-body")} pre`)?.innerHTML);

  // one click on each kind of id opens that record in the drawer
  const cases = [["realises", `${T("design-realises")} ${T("id-link")}[data-id="${R3}"]`, R3],
    ["body requirement", `${T("design-body")} ${T("id-link")}[data-id="${R2}"]`, R2],
    ["body story", `${T("design-body")} ${T("id-link")}[data-id="${S1}"]`, S1],
    ["body task", `${T("design-body")} ${T("id-link")}[data-id="${T1}"]`, T1]];
  for (const [where, sel, id] of cases) {
    const a = $(sel);
    a?.click();
    ok(`[REQ-0055#AC3] one click on a ${where} id opens the record in the drawer`, !!a && await drawerShows(id), `${where}: ${txt(T("drawer-title"))}`);
    await closeDrawer();
  }
  ok("design view still shown after closing the drawer", docSlug() === "checkout-flow", docSlug());
}

// reqforge: verifies REQ-0055#AC4
async function drawerLinks() {
  // demo req 1 is realised by a-overview and checkout-flow
  $(`${T("design-realises")} ${T("id-link")}[data-id="${R1}"]`).click();
  await drawerShows(R1);
  mdown($(T("drawer-tab-links")));
  await until(() => $(T("links-panel")), 8000);
  const links = () => $$(T("drawer-design-link")).map((b) => b.dataset.slug);
  await until(() => links().length > 0, 4000);
  ok("[REQ-0055#AC4] Links & impact lists the design documents that realise demo req 1",
    links().sort().join(",") === "a-overview,checkout-flow", links().join(",") || txt(T("links-panel")).slice(0, 200));
  ok("[REQ-0055#AC4] design documents listed by title",
    txt(T("drawer-design-docs")).includes("Zeta overview") && txt(T("drawer-design-docs")).includes("Checkout flow"), txt(T("drawer-design-docs")));
  $(`${T("drawer-design-link")}[data-slug="a-overview"]`).click();
  ok("[REQ-0055#AC4] a design document link opens it on the Design tab",
    await until(() => $(`${T("tab-design")}[aria-current="page"]`) && docSlug() === "a-overview", 6000), `${docSlug()} ${location.hash}`);
  await bodyReady();

  // demo req 4 is realised by no document
  $(T("tab-requirements")).click();
  await until(() => $(`${T("row")}[data-id="${R4}"]`), 8000);
  $(`${T("row")}[data-id="${R4}"]`).click();
  await drawerShows(R4);
  mdown($(T("drawer-tab-links")));
  ok("[REQ-0055#AC4] a requirement no document realises says so",
    await until(() => $(T("drawer-design-none")) && !$(T("drawer-design-link")), 8000), txt(T("links-panel")).slice(0, 300));
  await closeDrawer();
}

// reqforge: verifies REQ-0055#AC1
async function phaseTwo() {
  await until(() => project().endsWith("BARE") && $(T("tab-design")), 15000);
  ok("switched to the project without design documents", project().endsWith("BARE"), project());
  await openDesignTab();
  ok("[REQ-0055#AC1] empty state when there are no design documents", !!$(T("design-empty")) && !items().length, txt(T("main")).slice(0, 200));
  ok("[REQ-0055#AC1] empty state shows the expected design/ path",
    /\/bare\/design\/<slug>\.md$/.test(txt(T("design-path"))), txt(T("design-path")));
}
