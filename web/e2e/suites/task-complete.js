// Suite "task-complete": review an agent branch and Complete it from the task drawer (REQ-0056), and the parallel-task
// warning of Start with agent (REQ-0051#AC7), in single-repository mode on the SHOP demo (run.mjs seedTasks).
// STORY-0001's component `web` is the git repo <dir>-code; web/e2e/fake-claude.py plays the coding agent (writes and
// commits agent-task-NNNN.txt on reqforge/TASK-NNNN). run.mjs seeds TASK-0002 and TASK-0004 done and sets STORY-0001's
// evals: E1 `test -f agent-task-0001.txt` (passes in the worktree) and E6, a gate that prints 61 lines and fails.
// run.mjs adds a disk check afterwards: the --no-ff merge landed on the checkout's main and the task branch is gone.

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const T1 = "TASK-0001", T3 = "TASK-0003", S1 = "STORY-0001", E1 = "EPIC-0001";
// reqforge:on

const row = (id) => $(`${T("row")}[data-id="${id}"]`);
const rec = (id) => getJ(`/api/${id.startsWith("TASK") ? "tasks" : id.startsWith("STORY") ? "stories" : "epics"}/${id}`);
const agentBtn = () => $(T("agent-start"));
const completeBtn = () => $(T("task-complete"));
const openTask = async (id) => {
  row(id).click();
  return until(() => new RegExp(id + " · v").test(txt(T("drawer-title"))) && $(T("task-actions")) && $(T("agent-start")), 8000);
};
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const showList = async (kind, n) => {
  $(T(`tab-${kind}`)).click();
  return until(() => $(T("list-view"))?.dataset.kind === kind && (n == null || rows().length === n), 10000);
};
const statusCell = (id) => row(id)?.querySelector('[data-col="status"]')?.textContent.trim();
const branchTab = async () => { mdown($(T("drawer-tab-branch"))); return until(() => $(T("branch-panel")), 5000) };
const agentTab = async () => { mdown($(T("drawer-tab-agent"))); return until(() => $(T("agent-panel")) && $(T("runs-list")), 5000) };

async function suite() {
  await until(() => $(T("tab-tasks")), 15000);
  ok("tasks tab lists 5 tasks", await showList("tasks", 5), rowIds());
  // an agent run on TASK-0001 (as "Start with agent" does): its branch is the one to review and complete
  const r = await fetch(`/api/tasks/${T1}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const stream = await r.text();
  ok("setup: agent run of TASK-0001 committed on its branch", r.ok && /"exit_status":0/.test(stream) && (await rec(T1)).status === "in-progress", stream.slice(-300));
  await parallelWarning();
  await branchReview();
  await evalsRefusal();
  await completeLands();
}

// reqforge: verifies REQ-0051#AC7
async function parallelWarning() {
  await openTask(T3);
  await until(() => agentBtn().dataset.ready === "true" && !agentBtn().disabled, 6000);
  agentBtn().click();
  ok("[REQ-0051#AC7] confirmation dialog warns about the parallel unmerged branch before confirming",
    await until(() => $(T("agent-dialog")) && $(T("agent-parallel")), 5000) &&
      /1 other task of this story has an unmerged agent branch; their changes may conflict with this run/.test(txt(T("agent-parallel-text"))),
    txt(T("agent-dialog")).slice(0, 300));
  const items = $$(T("agent-parallel-task"));
  ok("[REQ-0051#AC7] the parallel task is listed with its branch and a checked checkbox",
    items.length === 1 && items[0].dataset.id === T1 && /reqforge\/TASK-0001 · 1 commit ahead/.test(items[0].textContent) &&
      items[0].querySelector(T("agent-parallel-check"))?.getAttribute("aria-checked") === "true",
    items.map((i) => i.textContent).join(" | "));
  ok("[REQ-0051#AC7] dialog offers Add to depends_on and Start anyway",
    $(T("agent-add-depends")) && !$(T("agent-add-depends")).disabled && /Start anyway/.test(txt(T("agent-confirm"))), txt(T("agent-dialog")).slice(-200));
  const v0 = (await rec(T3)).version;
  $(T("agent-add-depends")).click();
  ok("[REQ-0051#AC7] Add to depends_on closes the dialog without starting a run", await until(() => !$(T("agent-dialog")), 5000));
  const [t3, runs] = await Promise.all([rec(T3), getJ(`/api/tasks/${T3}/runs`)]);
  ok("[REQ-0051#AC7] depends_on now holds TASK-0001 (one versioned update), task still todo, nothing ran",
    (t3.depends_on || []).includes(T1) && t3.version === v0 + 1 && t3.status === "todo" && runs.length === 0,
    JSON.stringify({ depends_on: t3.depends_on, v: [v0, t3.version], status: t3.status, runs: runs.length }));
  ok("[REQ-0051#AC7] Start with agent is then disabled with “waiting for TASK-0001”",
    await until(() => agentBtn().disabled && /waiting for TASK-0001/.test(txt(T("agent-reasons"))), 6000), txt(T("task-actions")));
  await closeDrawer();
  // TASK-0003 is out of the way for the cascade below (STORY-0001 is done once its last open task is)
  const d = await sendJ("PATCH", `/api/tasks/${T3}`, { status: "done" });
  ok("setup: TASK-0003 set done by hand", d.status === 200, JSON.stringify(d.body).slice(0, 200));
}

// reqforge: verifies REQ-0056#AC1
async function branchReview() {
  await openTask(T1);
  ok("[REQ-0056#AC1] drawer of a task with an agent branch offers Complete and a Branch tab",
    await until(() => completeBtn() && $(T("drawer-tab-branch")), 6000), txt(T("task-actions")));
  await branchTab();
  ok("[REQ-0056#AC1] branch section shows the branch, its target and ahead/behind",
    await until(() => $(T("branch-review")), 5000) && txt(T("branch-name")) === `reqforge/${T1}` && txt(T("branch-target")) === "main" &&
      /1 ahead · 0 behind/.test(txt(T("branch-ahead-behind"))), txt(T("branch-review")).slice(0, 300));
  const commits = $$(T("branch-commit"));
  ok("[REQ-0056#AC1] branch section lists the commit message", commits.length === 1 && /TASK-0001: add agent-task-0001\.txt/.test(commits[0].textContent), commits.map((c) => c.textContent).join(" | "));
  const files = $$(T("branch-file"));
  ok("[REQ-0056#AC1] branch section lists the changed file with its status",
    files.length === 1 && files[0].dataset.path === "agent-task-0001.txt" && files[0].dataset.status === "A", files.map((f) => f.textContent).join(" | "));
  const df = $(`${T("branch-diff-file")}[data-path="agent-task-0001.txt"]`);
  const pre = df?.querySelector("pre");
  ok("[REQ-0056#AC1] branch section shows the diff text (monospace)",
    !!pre && /\+work for TASK-0001/.test(pre.textContent) && /mono|Menlo|Consolas/i.test(getComputedStyle(pre).fontFamily), txt(T("branch-diff")).slice(0, 300));
  df.querySelector("button").click();
  const collapsed = await until(() => df.dataset.open === "false" && !df.querySelector("pre"), 3000);
  df.querySelector("button").click();
  ok("[REQ-0056#AC1] the diff is collapsible per file", collapsed && await until(() => df.querySelector("pre"), 3000), df.outerHTML.slice(0, 200));
  ok("[REQ-0056#AC1] Complete is enabled for a ready branch (no reasons shown)",
    completeBtn().dataset.ready === "true" && !completeBtn().disabled && !$(T("complete-reasons")), txt(T("branch-panel")).slice(0, 200));
}

// reqforge: verifies REQ-0056#AC5
async function evalsRefusal() {
  completeBtn().click();
  ok("[REQ-0056#AC5] Complete asks for confirmation naming the target branch",
    await until(() => $(T("complete-dialog")), 4000) && txt(T("complete-dialog-target")) === "main" && /--no-ff/.test(txt(T("complete-steps"))) &&
      /evals of STORY-0001/.test(txt(T("complete-steps"))), txt(T("complete-dialog")).slice(0, 400));
  $(T("complete-confirm")).click();
  ok("[REQ-0056#AC5] progress (spinner, elapsed time) while Complete runs",
    await until(() => $(T("complete-progress")) && /\d+:\d\d/.test(txt(T("complete-elapsed"))) && completeBtn()?.disabled, 4000), txt(T("branch-panel")).slice(0, 200));
  ok("refusal: failing eval renders the evals step",
    await until(() => $(T("complete-refusal"))?.dataset.step === "evals", 60000), txt(T("branch-panel")).slice(0, 300));
  const f = $$(T("complete-failed-eval"));
  ok("refusal: the failing eval is listed with its output tail visible",
    f.length === 1 && f[0].dataset.eval === "E6" && /E2E-GATE: the release gate is closed/.test(f[0].querySelector(T("complete-eval-tail"))?.textContent || "") &&
      !/gate line 1\n/.test(f[0].querySelector(T("complete-eval-tail")).textContent), f.map((x) => x.textContent.slice(-200)).join(" | "));
  // the server sends the last 4000 characters of the output (complete.rs); the drawer shows the last 40 lines, expandable
  const tail = txt(T("complete-eval-tail")).split("\n");
  ok("refusal: the collapsed output tail shows the last 40 lines",
    tail.length === 40 && tail[0] === "gate line 22" && tail[39] === "E2E-GATE: the release gate is closed", `${tail.length} lines: ${tail[0]} … ${tail[tail.length - 1]}`);
  const toggle = $(T("complete-eval-tail-toggle"));
  ok("refusal: the full output tail is available behind the expand control", !!toggle, txt(T("complete-failed-eval")).slice(-200));
  if (toggle) {
    toggle.click();
    ok("refusal: expanded, the tail starts at the first line of the eval's output",
      await until(() => txt(T("complete-eval-tail")).split("\n")[0] === "gate line 1", 3000), txt(T("complete-eval-tail")).slice(0, 80));
    $(T("complete-eval-tail-toggle"))?.click();
  }
  ok("refusal: task still in progress, branch section still there",
    (await rec(T1)).status === "in-progress" && await until(() => txt(T("task-status")) === "in-progress", 3000) && $(T("branch-review")) && !completeBtn().disabled,
    txt(T("task-actions")));
  await agentTab();
  ok("[REQ-0056#AC5] Runs lists the refused Complete attempt",
    await until(() => $$(`${T("run-row")}[data-kind="complete"]`).some((x) => x.dataset.outcome === "refused: evals failed"), 6000), txt(T("runs-list")));
}

// reqforge: verifies REQ-0056#AC5
async function completeLands() {
  // make the gate pass: drop E6 from the story's evals
  const story = await rec(S1);
  const p = await sendJ("PATCH", `/api/stories/${S1}`, { evals: story.evals.filter((e) => e.id !== "E6"), _version: story.version });
  ok("setup: STORY-0001's failing eval removed", p.status === 200, JSON.stringify(p.body).slice(0, 200));
  await branchTab();
  await until(() => completeBtn() && !completeBtn().disabled, 5000);
  completeBtn().click();
  await until(() => $(T("complete-confirm")), 4000);
  $(T("complete-confirm")).click();
  ok("[REQ-0056#AC5] Complete succeeds and shows the merge commit",
    await until(() => $(T("complete-result")) && /^[0-9a-f]{7,}$/.test(txt(T("complete-merge-commit"))), 60000), txt(T("branch-panel")).slice(0, 300));
  const changed = txt(T("complete-changed"));
  ok("[REQ-0056#AC5] result lists the task, story and epic that moved to done",
    [T1, S1, E1].every((id) => changed.includes(id)), changed);
  ok("[REQ-0056#AC5] success toast names the merge commit", await until(() => /TASK-0001 completed · merged as [0-9a-f]{7,}/.test(toasts()), 4000), toasts());
  ok("[REQ-0056#AC5] task shows done in the drawer", await until(() => txt(T("task-status")) === "done", 6000), txt(T("task-status")));
  ok("[REQ-0056#AC5] branch section and Complete button are gone", await until(() => !$(T("branch-review")) && !completeBtn(), 6000), txt(T("drawer")).slice(0, 300));
  const mc = txt(T("complete-merge-commit"));
  const [t1, s1, e1] = await Promise.all([rec(T1), rec(S1), rec(E1)]);
  ok("[REQ-0056#AC5] server: task, story and epic done", t1.status === "done" && s1.status === "done" && e1.status === "done", `${t1.status} ${s1.status} ${e1.status}`);
  await agentTab();
  ok("[REQ-0056#AC5] Runs lists the completed attempt with its merge commit",
    await until(() => $$(`${T("run-row")}[data-kind="complete"]`).some((x) => x.dataset.outcome === "completed" && x.textContent.includes(mc)), 6000), txt(T("runs-list")));
  await closeDrawer();
  ok("[REQ-0056#AC5] tasks list shows TASK-0001 done", await until(() => statusCell(T1) === "done", 6000), statusCell(T1));
  ok("[REQ-0056#AC5] stories list shows STORY-0001 done", await showList("stories") && await until(() => statusCell(S1) === "done", 6000), statusCell(S1));
  ok("[REQ-0056#AC5] epics list shows EPIC-0001 done", await showList("epics") && await until(() => statusCell(E1) === "done", 6000), statusCell(E1));
}
