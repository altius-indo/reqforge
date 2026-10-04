// Suite "task-start": the Start button on todo tasks (list rows and record drawer) in single-repository mode on the
// SHOP demo (run.mjs seedTasks): TASK-0001..0003 todo under STORY-0001/EPIC-0001, TASK-0002 depends on TASK-0001,
// TASK-0004 done, TASK-0005 todo under STORY-0002 (done) / EPIC-0002 (blocked).
// run.mjs adds one harness check afterwards: the start of TASK-0001 was a single git commit of task + story + epic.

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const T1 = "TASK-0001", T2 = "TASK-0002", T3 = "TASK-0003", T4 = "TASK-0004", T5 = "TASK-0005";
const S1 = "STORY-0001", E1 = "EPIC-0001", S2 = "STORY-0002", E2 = "EPIC-0002";
// reqforge:on

const row = (id) => $(`${T("row")}[data-id="${id}"]`);
const rowStart = (id) => row(id)?.querySelector(T("start-task"));
const drawerStart = () => $(`${T("task-actions")} ${T("start-task")}`);
const rec = (id) => getJ(`/api/${id.startsWith("TASK") ? "tasks" : id.startsWith("STORY") ? "stories" : "epics"}/${id}`);
const openTask = async (id) => {
  row(id).click();
  return until(() => new RegExp(id + " · v").test(txt(T("drawer-title"))) && $(T("task-actions")), 8000);
};
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const showTasks = async () => {
  await until(() => $(T("tab-requirements")) && $(T("tab-tasks")), 15000);
  $(T("tab-requirements")).click();
  await until(() => $(T("list-view"))?.dataset.kind === "requirements", 8000);
  $(T("tab-tasks")).click();
  return until(() => $(T("list-view"))?.dataset.kind === "tasks" && rows().length === 5, 10000);
};

async function suite() {
  ok("tasks tab lists 5 tasks", await showTasks(), rowIds());
  await shownOnlyOnTodo();
  await blockedByDependencies();
  await startCascades();
  await parentsLeftAlone();
  await staleVersion();
  await unblocked();
  await dependsOnPicker();
}

// reqforge: verifies REQ-0050#AC1
async function shownOnlyOnTodo() {
  await until(() => rowStart(T1) && rowStart(T2), 8000);
  const shown = rows().filter((r) => r.querySelector(T("start-task"))).map((r) => r.dataset.id).join(",");
  ok("[REQ-0050#AC1] Start shown on todo rows only (not on the done task)", shown === [T1, T2, T3, T5].join(","), shown);
  ok("[REQ-0050#AC1] a todo row without dependencies has an enabled Start", rowStart(T1) && !rowStart(T1).disabled, rowStart(T1)?.outerHTML.slice(0, 200));
  ok("[REQ-0050#AC1] drawer of a todo task shows Start", await openTask(T3) && await until(() => drawerStart() && !drawerStart().disabled, 5000), txt(T("task-actions")));
  await closeDrawer();
  ok("[REQ-0050#AC1] drawer of a done task has no Start", await openTask(T4) && (await sleep(600), !drawerStart()) && /done/.test(txt(T("task-status"))), txt(T("task-actions")));
  await closeDrawer();
}

// reqforge: verifies REQ-0050#AC5
async function blockedByDependencies() {
  await until(() => rowStart(T2)?.dataset.blocked === "true", 8000);
  const b = row(T2)?.querySelector(T("start-blocked"));
  ok("[REQ-0050#AC5] Start disabled while a dependency is not done (list)", rowStart(T2)?.disabled === true, rowStart(T2)?.outerHTML.slice(0, 200));
  ok("[REQ-0050#AC5] row lists the unfinished dependency", b?.dataset.ids === T1 && b.textContent.includes(T1), b?.textContent);
  ok("[REQ-0050#AC5] disabled Start names the blocker for assistive tech", (rowStart(T2)?.getAttribute("aria-label") || "").includes(`${T1} (todo)`), rowStart(T2)?.getAttribute("aria-label"));
  ok("[REQ-0050#AC5] drawer: Start disabled with the unfinished dependency and its status", await openTask(T2) &&
    await until(() => drawerStart()?.disabled && /waits for\s*TASK-0001\s*\(todo\)/.test(txt(`${T("task-actions")} ${T("start-blocked")}`)), 5000), txt(T("task-actions")));
  await closeDrawer();
  const t2 = await rec(T2);
  const r = await sendJ("POST", `/api/tasks/${T2}/start`, { _version: t2.version });
  ok("[REQ-0050#AC5] start route refuses with 409 and lists the unfinished task", r.status === 409 && (r.body?.details || []).some((d) => d.id === T1), JSON.stringify(r));
  ok("[REQ-0050#AC5] refused start leaves the status unchanged", (await rec(T2)).status === "todo" && (await rec(T2)).version === t2.version);
}

// reqforge: verifies REQ-0050#AC2
// reqforge: verifies REQ-0050#AC3
async function startCascades() {
  const before = await rec(T1);
  rowStart(T1).click();
  ok("[REQ-0050#AC2] 1 click: toast names the task and the parents that moved", await until(() => /TASK-0001 started · STORY-0001, EPIC-0001 also moved to in-progress/.test(toasts()), 8000), toasts());
  const [t, s, e] = await Promise.all([rec(T1), rec(S1), rec(E1)]);
  ok("[REQ-0050#AC2] task is in-progress (one new version)", t.status === "in-progress" && t.version === before.version + 1, `${t.status} v${t.version}`);
  ok("[REQ-0050#AC3] todo story and epic moved to in-progress", s.status === "in-progress" && e.status === "in-progress", `${s.status} / ${e.status}`);
  ok("[REQ-0050#AC1] row refreshes: Start gone once the task is in-progress", await until(() => row(T1) && !rowStart(T1) && /in-progress/.test(row(T1).textContent), 8000), row(T1)?.textContent);
}

// reqforge: verifies REQ-0050#AC3
async function parentsLeftAlone() {
  await until(() => rowStart(T5) && !rowStart(T5).disabled, 8000);
  rowStart(T5).click();
  ok("[REQ-0050#AC3] start under a done story / blocked epic: toast says parents unchanged", await until(() => /TASK-0005 started · story and epic unchanged/.test(toasts()), 8000), toasts());
  const [t, s, e] = await Promise.all([rec(T5), rec(S2), rec(E2)]);
  ok("[REQ-0050#AC3] done story and blocked epic are left unchanged", t.status === "in-progress" && s.status === "done" && e.status === "blocked", `${t.status} / ${s.status} / ${e.status}`);
}

// reqforge: verifies REQ-0050#AC4
async function staleVersion() {
  // list row: the task changes behind the page's back, then Start is clicked with the loaded version
  await until(() => rowStart(T3) && !rowStart(T3).disabled, 8000);
  const loaded = +row(T3).dataset.version;
  const patched = await sendJ("PATCH", `/api/tasks/${T3}`, { estimate: "2d", _version: loaded });
  ok("task changed elsewhere (PATCH)", patched.status === 200 && patched.body.version === loaded + 1, JSON.stringify(patched).slice(0, 200));
  rowStart(T3).click();
  ok("[REQ-0050#AC4] stale Start in the list → 409 message shown", await until(() => /TASK-0003 was modified/.test(toasts()), 8000), toasts());
  const t = await rec(T3);
  ok("[REQ-0050#AC4] status unchanged after 409", t.status === "todo" && t.version === loaded + 1, `${t.status} v${t.version}`);
  ok("[REQ-0050#AC4] row refreshes to the current version", await until(() => +row(T3)?.dataset.version === loaded + 1, 8000), row(T3)?.dataset.version);
  // drawer: same, from the record drawer
  await openTask(T3);
  const v = (await rec(T3)).version;
  ok("drawer loaded the current version", new RegExp(`${T3} · v${v}`).test(txt(T("drawer-title"))), txt(T("drawer-title")));
  await sendJ("PATCH", `/api/tasks/${T3}`, { estimate: "3d", _version: v });
  await until(() => drawerStart() && !drawerStart().disabled, 5000);
  drawerStart().click();
  ok("[REQ-0050#AC4] stale Start in the drawer → 409 message, drawer reloads the record", await until(() => $$("[data-sonner-toast]").filter((x) => /TASK-0003 was modified/.test(x.textContent)).length >= 2 && new RegExp(`${T3} · v${v + 1}`).test(txt(T("drawer-title"))), 8000), txt(T("drawer-title")) + " | " + toasts());
  ok("[REQ-0050#AC4] status still todo, Start still offered", (await rec(T3)).status === "todo" && await until(() => !!drawerStart(), 3000));
  await closeDrawer();
}

// reqforge: verifies REQ-0050#AC5
async function unblocked() {
  const t1 = await rec(T1);
  const done = await sendJ("PATCH", `/api/tasks/${T1}`, { status: "done", _version: t1.version });
  ok("dependency finished elsewhere (PATCH status done)", done.status === 200 && done.body.status === "done", JSON.stringify(done).slice(0, 300));
  await showTasks();
  ok("[REQ-0050#AC5] once the dependency is done, Start is enabled", await until(() => rowStart(T2) && rowStart(T2).dataset.blocked === "false" && !rowStart(T2).disabled && !row(T2).querySelector(T("start-blocked")), 8000), row(T2)?.textContent);
  rowStart(T2).click();
  ok("[REQ-0050#AC2] unblocked task starts", await until(() => /TASK-0002 started/.test(toasts()), 8000), toasts());
  ok("[REQ-0050#AC5] start route accepted it", (await rec(T2)).status === "in-progress");
}

async function dependsOnPicker() {
  await openTask(T3);
  await until(() => $(T("depends-add")) && $$(`${T("depends-add")} option`).length > 1, 8000);
  const opts = $$(`${T("depends-add")} option`).map((o) => o.value).filter(Boolean);
  ok("drawer depends_on offers the other task ids", opts.includes(T1) && opts.includes(T5) && !opts.includes(T3), opts.join(","));
  setVal($(T("depends-add")), T1);
  ok("picking a task adds it to depends_on", await until(() => $(T("f_depends_on")).value === T1 && /TASK-0001 · (done|in-progress)/.test(txt(T("depends-list"))), 3000), $(T("f_depends_on")).value + " " + txt(T("depends-list")));
  setVal($(T("f_depends_on")), "TASK-9999");
  ok("unknown task id flagged", await until(() => /TASK-9999/.test(txt(T("depends-unknown"))), 3000));
  await closeDrawer();
}
