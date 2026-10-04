// Suite "agent-queue": the agent queue panel of the Tasks tab in single-repository mode on the SHOP demo with every
// requirement approved (run.mjs seedTasks). Eligible: TASK-0001, TASK-0003, TASK-0004 (TASK-0002 waits for TASK-0001;
// TASK-0005's story has no component). The server ticks every 500 ms (REQFORGE_QUEUE_TICK_MS); each queued run of
// web/e2e/fake-claude.py takes 6 s ("QWAIT" in the brief).

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const T1 = "TASK-0001", T3 = "TASK-0003", T4 = "TASK-0004";
// reqforge:on

const queue = () => getJ("/api/agent-queue");
const ids = (t) => $$(T(t)).map((e) => e.dataset.id).join(",");
const state = () => txt(T("queue-state"));
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };

async function suite() {
  await until(() => $(T("tab-tasks")), 15000);
  $(T("tab-tasks")).click();
  ok("tasks tab shows the agent queue panel", await until(() => $(T("queue-panel")) && rows().length === 5, 10000), txt(T("main")).slice(0, 200));
  await offByDefault();
  await turnOnWithConfirmation();
  await runningAndWaiting();
  await turnOff();
}

// reqforge: verifies REQ-0053#AC1
// reqforge: verifies REQ-0053#AC6
async function offByDefault() {
  const q = await queue();
  ok("[REQ-0053#AC1] queue is off by default", q.enabled === false && state() === "Off" && $(T("queue-toggle")).getAttribute("aria-checked") === "false" && /off by default/.test(txt(T("queue-changed"))), `${JSON.stringify(q)} ${state()} ${txt(T("queue-changed"))}`);
  ok("[REQ-0053#AC6] waiting eligible tasks listed in start order", await until(() => ids("queue-waiting-item") === [T1, T3, T4].join(","), 8000) && $$(T("queue-waiting-item")).map((e) => e.dataset.pos).join("") === "123", ids("queue-waiting-item"));
  ok("[REQ-0053#AC6] nothing running", txt(T("queue-running-count")) === "0" && !$(T("queue-running-item")), txt(T("queue-running")));
  ok("[REQ-0053#AC6] default concurrency limit 2 (choices 1–8)", $(T("queue-limit")).value === "2" && $$(`${T("queue-limit")} option`).map((o) => o.value).join("") === "12345678", $(T("queue-limit")).value);
  // limit change without turning the queue on needs no confirmation
  setVal($(T("queue-limit")), "1");
  ok("limit set to 1 (queue still off)", await until(() => /limit set to 1/.test(toasts()), 5000) && (await queue()).limit === 1 && (await queue()).enabled === false, JSON.stringify(await queue()));
  // the server refuses an unconfirmed switch (the UI always confirms first)
  const r = await sendJ("POST", "/api/agent-queue", { enabled: true });
  ok("[REQ-0053#AC1] server refuses turning on without confirmation, naming the eligible count", r.status === 400 && /needs confirmation \(3 eligible tasks\)/.test(r.body?.error || ""), JSON.stringify(r));
}

// reqforge: verifies REQ-0053#AC1
async function turnOnWithConfirmation() {
  $(T("queue-toggle")).click();
  ok("[REQ-0053#AC1] turning on asks for confirmation", await until(() => $(T("queue-dialog")), 5000));
  const d = $(T("queue-dialog-text"));
  ok("[REQ-0053#AC1] confirmation states the number of eligible tasks and the limit", d.dataset.eligible === "3" && /^3 eligible tasks will start automatically/.test(d.textContent) && /at most 1 at a time/.test(d.textContent), d.textContent);
  $(T("queue-cancel")).click();
  await until(() => !$(T("queue-dialog")), 3000);
  await sleep(1200);
  ok("[REQ-0053#AC1] dismissing the confirmation leaves the queue off and starts nothing", (await queue()).enabled === false && (await getJ(`/api/tasks/${T1}/runs`)).length === 0 && state() === "Off");
  $(T("queue-toggle")).click();
  await until(() => $(T("queue-confirm")), 5000);
  $(T("queue-confirm")).click();
  ok("[REQ-0053#AC1] confirmed: queue on", await until(() => state() === "On" && $(T("queue-toggle")).getAttribute("aria-checked") === "true", 8000), state());
  const q = await queue();
  ok("[REQ-0053#AC1] records the enabling user and time", q.enabled && !!q.changed_by && !!q.changed_at && txt(T("queue-changed")).includes(`turned on by ${q.changed_by}`) && txt(T("queue-changed")).includes(q.changed_at.replace("T", " ").slice(0, 16)), `${JSON.stringify(q)} | ${txt(T("queue-changed"))}`);
}

// reqforge: verifies REQ-0053#AC6
async function runningAndWaiting() {
  ok("[REQ-0053#AC6] running task shown (limit 1: the first in id order)", await until(() => ids("queue-running-item") === T1, 10000), `${ids("queue-running-item")} | ${txt(T("queue-panel"))}`);
  ok("[REQ-0053#AC6] remaining eligible tasks wait in start order", ids("queue-waiting-item") === [T3, T4].join(","), ids("queue-waiting-item"));
  $(`${T("queue-running-item")}[data-id="${T1}"]`).click();
  ok("[REQ-0053#AC6] running task opens the drawer on its live progress", await until(() => /TASK-0001 · v/.test(txt(T("drawer-title"))) && $(T("agent-run"))?.dataset.source === "live" && $(T("agent-run")).dataset.running === "true", 8000), txt(T("drawer")).slice(0, 300));
  ok("[REQ-0053#AC6] queued run shows its branch and finishes with a result", await until(() => $(T("agent-result"))?.dataset.exit === "0", 20000) && txt(T("agent-branch")) === `reqforge/${T1}`, txt(T("agent-run")).slice(-300));
  await closeDrawer();
  ok("[REQ-0053#AC6] next eligible task starts when the run ends", await until(() => ids("queue-running-item") === T3, 15000), ids("queue-running-item"));
  ok("[REQ-0053#AC6] the finished task left the queue", ids("queue-waiting-item") === T4 && !$$(T("queue-waiting-item")).some((e) => e.dataset.id === T1), ids("queue-waiting-item"));
}

// reqforge: verifies REQ-0053#AC1
// reqforge: verifies REQ-0053#AC6
async function turnOff() {
  $(T("queue-toggle")).click();
  await until(() => $(T("queue-dialog")), 5000);
  ok("[REQ-0053#AC1] turning off also asks for confirmation (active run keeps running)", /No new agent runs will start\. 1 active run keeps running; 1 eligible task stays waiting/.test(txt(T("queue-dialog-text"))), txt(T("queue-dialog-text")));
  $(T("queue-confirm")).click();
  ok("[REQ-0053#AC1] queue off, change recorded", await until(() => state() === "Off" && /turned off by/.test(txt(T("queue-changed"))), 8000), txt(T("queue-changed")));
  ok("[REQ-0053#AC6] active run still shown after turning off", ids("queue-running-item") === T3, ids("queue-running-item"));
  ok("[REQ-0053#AC6] run finishes, nothing else starts", await until(() => txt(T("queue-running-count")) === "0", 20000) && (await sleep(2000), ids("queue-waiting-item") === T4 && !$(T("queue-running-item"))), txt(T("queue-panel")));
  ok("no run of the waiting task", (await getJ(`/api/tasks/${T4}/runs`)).length === 0);
}
