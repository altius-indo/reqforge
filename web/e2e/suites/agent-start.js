// Suite "agent-start": Start with agent (confirmation dialog, streamed run view, cancel, runs list, live progress of a
// run started elsewhere) in single-repository mode on the SHOP demo (run.mjs seedTasks). STORY-0001's component `web`
// is the git repo <dir>-code; web/e2e/fake-claude.py plays the coding agent (writes + commits a file; briefs with
// "SLOW" run until cancelled). TASK-0002 depends on TASK-0001; TASK-0005's story has no component.
// run.mjs adds one harness check afterwards: the agent's commit is on branch reqforge/TASK-0001 in its worktree.

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const T1 = "TASK-0001", T2 = "TASK-0002", T3 = "TASK-0003", T4 = "TASK-0004", T5 = "TASK-0005";
// reqforge:on

const row = (id) => $(`${T("row")}[data-id="${id}"]`);
const task = (id) => getJ(`/api/tasks/${id}`);
const agentBtn = () => $(T("agent-start"));
const openTask = async (id) => {
  row(id).click();
  return until(() => new RegExp(id + " · v").test(txt(T("drawer-title"))) && $(T("task-actions")) && $(T("agent-start")), 8000);
};
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const agentTab = async () => { mdown($(T("drawer-tab-agent"))); return until(() => $(T("agent-panel")) && $(T("runs-list")), 5000) };
const events = (type) => $$(`${T("agent-log")} ${T("agent-event")}${type ? `[data-type="${type}"]` : ""}`);

async function suite() {
  await until(() => $(T("tab-tasks")), 15000);
  $(T("tab-tasks")).click();
  ok("tasks tab lists 5 tasks", await until(() => $(T("list-view"))?.dataset.kind === "tasks" && rows().length === 5, 10000), rowIds());
  await disabledWithReasons();
  await confirmDialog();
  await streamedRun();
  await cancelRun();
  await runStartedElsewhere();
}

async function disabledWithReasons() {
  await openTask(T2);
  ok("Start with agent disabled while a dependency is unfinished, reason shown",
    await until(() => agentBtn().disabled && /waiting for TASK-0001 \(todo\)/.test(txt(T("agent-reasons"))), 5000), txt(T("task-actions")));
  await closeDrawer();
  await openTask(T5);
  ok("Start with agent disabled when the story has no component, reason shown",
    await until(() => agentBtn().disabled && /the story has no component/.test(txt(T("agent-reasons"))), 5000), txt(T("task-actions")));
  await closeDrawer();
}

// reqforge: verifies REQ-0051#AC1
async function confirmDialog() {
  await openTask(T1);
  await until(() => agentBtn().dataset.ready === "true" && !agentBtn().disabled, 5000);
  ok("[REQ-0051#AC1] Start with agent enabled for a ready task", !agentBtn().disabled && !$(T("agent-reasons")), txt(T("task-actions")));
  const plan = await getJ(`/api/tasks/${T1}/agent`);
  agentBtn().click();
  ok("[REQ-0051#AC1] confirmation dialog opens", await until(() => $(T("agent-dialog")) && $(T("agent-brief")), 5000));
  ok("[REQ-0051#AC1] dialog shows the component path", txt(T("agent-dialog-path")).includes(plan.component_path) && /web · .*shop-code$/.test(txt(T("agent-dialog-path"))), txt(T("agent-dialog-path")));
  ok("[REQ-0051#AC1] dialog shows branch reqforge/TASK-NNNN", txt(T("agent-dialog-branch")) === `reqforge/${T1}`, txt(T("agent-dialog-branch")));
  ok("[REQ-0051#AC1] dialog shows the worktree", txt(T("agent-dialog-worktree")) === plan.worktree && /\/worktrees\/SHOP\/TASK-0001$/.test(plan.worktree), txt(T("agent-dialog-worktree")));
  const brief = $(T("agent-brief"));
  ok("[REQ-0051#AC1] dialog shows the full brief", brief.textContent === plan.brief && /^# Task TASK-0001/.test(brief.textContent) && /## Requirements/.test(brief.textContent) && /## Conventions/.test(brief.textContent), brief.textContent.slice(0, 200));
  const cs = getComputedStyle(brief);
  ok("[REQ-0051#AC1] brief is monospace and scrollable", /mono|Menlo|Consolas/i.test(cs.fontFamily) && /auto|scroll/.test(cs.overflowY), `${cs.fontFamily} ${cs.overflowY} ${brief.scrollHeight}/${brief.clientHeight}`);
  await sleep(1500);
  const [runs, live, t] = await Promise.all([getJ(`/api/tasks/${T1}/runs`), getJ(`/api/tasks/${T1}/agent/live`), task(T1)]);
  ok("[REQ-0051#AC1] nothing runs before confirming (no run, no live events, still todo)", runs.length === 0 && !live.running && live.total === 0 && t.status === "todo", JSON.stringify({ runs: runs.length, live, status: t.status }));
  $(T("agent-dialog-cancel")).click();
  await until(() => !$(T("agent-dialog")), 3000);
  await sleep(800);
  const [runs2, t2] = await Promise.all([getJ(`/api/tasks/${T1}/runs`), task(T1)]);
  ok("[REQ-0051#AC1] Cancel in the dialog starts nothing", !$(T("agent-dialog")) && runs2.length === 0 && t2.status === "todo" && !$(T("agent-run")), `${runs2.length} ${t2.status}`);
}

// reqforge: verifies REQ-0051#AC4
async function streamedRun() {
  agentBtn().click();
  await until(() => $(T("agent-confirm")), 5000);
  $(T("agent-confirm")).click();
  ok("[REQ-0051#AC4] confirming switches the drawer to the run view", await until(() => $(T("agent-panel")) && $(T("agent-run")), 5000), txt(T("drawer")).slice(0, 200));
  ok("[REQ-0051#AC4] progress streams into the drawer (tool activity + text)", await until(() => events("tool").length >= 2 && events("text").length >= 1, 15000), txt(T("agent-log")).slice(0, 300));
  ok("[REQ-0051#AC4] run started on its branch", events("run")[0]?.textContent.includes(`reqforge/${T1}`), events("run")[0]?.textContent);
  ok("[REQ-0051#AC4] result: exit status 0", await until(() => $(T("agent-result"))?.dataset.exit === "0", 20000), txt(T("agent-run")).slice(-300));
  ok("[REQ-0051#AC4] result: branch and commit listed", txt(T("agent-branch")) === `reqforge/${T1}` && $$(T("agent-commit")).some((c) => /TASK-0001: add agent-task-0001\.txt/.test(c.textContent)), txt(T("agent-result")));
  ok("[REQ-0051#AC4] result: no violations, task not marked done", !$(T("agent-violations")) && /not marked done automatically \(status: in-progress\)/.test(txt(T("agent-not-done"))), txt(T("agent-result")));
  ok("[REQ-0051#AC4] Cancel hidden once the run ended", !$(T("agent-cancel")) && $(T("agent-run")).dataset.running === "false");
  ok("[REQ-0051#AC4] Runs section lists the run", await until(() => $$(T("run-row")).length === 1 && $(T("run-row")).dataset.exit === "0", 8000), txt(T("runs-list")));
  ok("[REQ-0051#AC4] task status in the drawer refreshed to in-progress", await until(() => txt(T("task-status")) === "in-progress", 5000), txt(T("task-status")));
  await closeDrawer();
}

// reqforge: verifies REQ-0051#AC4
async function cancelRun() {
  await openTask(T3);
  await until(() => !agentBtn().disabled, 5000);
  agentBtn().click();
  await until(() => $(T("agent-confirm")), 5000);
  ok("brief of the slow task is shown", /SLOW/.test(txt(T("agent-brief"))));
  $(T("agent-confirm")).click();
  ok("[REQ-0051#AC4] long run: running state with a Cancel button", await until(() => $(T("agent-running")) && $(T("agent-cancel")) && events("tool").length >= 2, 15000), txt(T("agent-run")).slice(0, 300));
  ok("[REQ-0051#AC4] drawer actions show the run in progress", agentBtn().disabled && /Agent running/.test(agentBtn().textContent), agentBtn().textContent);
  $(T("agent-cancel")).click();
  ok("[REQ-0051#AC4] Cancel ends the run as cancelled", await until(() => $(T("agent-result"))?.dataset.exit === "cancelled", 15000), txt(T("agent-run")).slice(-300));
  ok("[REQ-0051#AC4] cancelled run listed in Runs", await until(() => $(T("run-row"))?.dataset.exit === "cancelled", 8000), txt(T("runs-list")));
  ok("[REQ-0051#AC4] cancelled task is not done", (await task(T3)).status === "in-progress");
  await closeDrawer();
}

// reqforge: verifies REQ-0051#AC4
async function runStartedElsewhere() {
  // a run the drawer did not start (as the agent queue would): only the live buffer shows its progress
  const ctrl = new AbortController();
  fetch(`/api/tasks/${T4}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: ctrl.signal })
    .then((r) => r.body?.getReader().read()).catch(() => {});
  let live = { running: false };
  for (let i = 0; i < 50 && !live.running; i++) { await sleep(200); live = await getJ(`/api/tasks/${T4}/agent/live`) }
  ctrl.abort(); // the run continues without its streaming client
  ok("run started outside the drawer", live.running, JSON.stringify(live).slice(0, 200));
  await openTask(T4);
  ok("[REQ-0051#AC4] drawer shows a run started elsewhere as running", await until(() => /Agent running/.test(agentBtn().textContent) && $(T("agent-progress-link")), 8000), txt(T("task-actions")));
  $(T("agent-progress-link")).click();
  ok("[REQ-0051#AC4] live progress polled into the run view", await until(() => $(T("agent-run"))?.dataset.source === "live" && $(T("agent-run")).dataset.running === "true" && /started elsewhere/.test(txt(T("agent-running"))), 8000), txt(T("agent-panel")).slice(0, 300));
  const n0 = events("tool").length;
  ok("[REQ-0051#AC4] live progress keeps updating", await until(() => events("tool").length > n0, 8000), `${n0} -> ${events("tool").length}`);
  $(T("agent-cancel")).click();
  ok("[REQ-0051#AC4] cancel works for a run started elsewhere", await until(() => $(T("agent-result"))?.dataset.exit === "cancelled" && $(T("agent-run")).dataset.running === "false", 15000), txt(T("agent-run")).slice(-300));
  await closeDrawer();
}
