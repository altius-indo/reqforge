// Suite "next-action": one next action per task (REQ-0059) on the SHOP demo (run.mjs "next-action"). TASK-0001 has a
// next action set 2026-10-01; web/e2e/fake-claude.py, as the coding agent, ends its final message with
// "NEXT: Run `pytest tests/test_checkout.py` and review agent-task-NNNN.txt" for TASK-0001/0003/0004. In the chat,
// "NEXT-DEMO" proposes an estimate for TASK-0002 and the wrap-up message proposes TASK-0002's next action + a snapshot.

// reqforge:off (fixture ids from the seeded demo data, not reqforge's own requirements)
const T1 = "TASK-0001", T3 = "TASK-0003", T4 = "TASK-0004";
// reqforge:on
const WRAP = "Wrap-up: next actions";

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
const row = (id) => $(`${T("row")}[data-id="${id}"]`);
const task = (id) => getJ(`/api/tasks/${id}`);
const proposalFor = (id) => `Run \`pytest tests/test_checkout.py\` and review agent-${id.toLowerCase()}.txt`;
const openTask = async (id) => {
  row(id).click();
  return until(() => new RegExp(id + " · v").test(txt(T("drawer-title"))) && $(T("next-action")) && $(T("agent-start")), 8000);
};
const closeDrawer = async () => { press(document.body, "Escape"); await until(() => !$(T("drawer")), 3000) };
const runAgent = async (id) => {
  await until(() => $(T("agent-start"))?.dataset.ready === "true" && !$(T("agent-start")).disabled, 8000);
  $(T("agent-start")).click();
  await until(() => $(T("agent-confirm")), 5000);
  $(T("agent-confirm")).click();
  return until(() => $(T("agent-result"))?.dataset.exit === "0", 25000);
};
/** like until(), for an async condition (server state) */
const untilAsync = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true } catch {} await sleep(200) } return false };
const wrapCount = async () => (await getJ("/api/changesets")).filter((c) => c.title === WRAP).length;
const wrapMsgs = () => $$(T("msg-user")).filter((m) => /^Before we stop:/.test(m.textContent.trim())).length;
const chatIdle = () => until(() => $(T("chat-panel")) && !$(T("chat-stop")) && !$(T("chat-send")).disabled, 15000);
const openChat = async () => {
  if (!$(T("chat-panel"))) $(T("chat-toggle")).click();
  await until(() => $(T("chat-input")), 5000);
};
const closeChat = async () => { $(T("chat-close")).click(); await until(() => !$(T("chat-panel")), 3000) };
const say = async (text) => {
  setVal($(T("chat-input")), text);
  await sleep(100);
  $(T("chat-send")).click();
  await sleep(300);
  return chatIdle();
};
/** Send NEXT-DEMO, apply the estimate changeset it proposes, wait for the "I applied" follow-up. */
const applyInChat = async (label) => {
  await say(`NEXT-DEMO ${label}`);
  const btn = () => $$(T("cs-apply")).filter((b) => !b.disabled).pop();
  ok(`[${label}] chat proposed a changeset`, await until(() => btn(), 10000), txt(T("chat-messages")).slice(-300));
  const sent = $$(T("msg-user")).length;
  btn()?.click();
  await until(() => $$(T("msg-user")).length > sent, 10000);
  ok(`[${label}] changeset applied and the agent followed up`, await until(() => /Verified/.test(txt(T("chat-messages"))), 15000) && await chatIdle(), txt(T("chat-messages")).slice(-300));
};

async function suite() {
  await until(() => $(T("tab-tasks")), 15000);
  $(T("tab-tasks")).click();
  await until(() => $(T("list-view"))?.dataset.kind === "tasks" && rows().length >= 4, 10000);
  await nextActionFirst();
  await acceptProposal();
  await rejectProposal();
  await editProposal();
  await wrapUpOnClose();
  await wrapUpOnNew();
}

// reqforge: verifies REQ-0059#AC3
async function nextActionFirst() {
  await openTask(T1);
  ok("[REQ-0059#AC3] drawer shows the next action", txt(T("next-action-text")) === "Open shop/checkout.py and read place_order", txt(T("next-action")));
  ok("[REQ-0059#AC3] drawer shows the date it was set", txt(T("next-action-set")) === "set 2026-10-01", txt(T("next-action-set")));
  const na = $(T("next-action"));
  const before = (el) => !!el && !!(na.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  ok("[REQ-0059#AC3] next action comes first: above the task actions and the details (description)",
    before($(T("task-actions"))) && before($(T("details-form"))));
  const brief = (await getJ(`/api/tasks/${T1}/agent`)).brief || "";
  ok("[REQ-0059#AC3] brief: next action with its date is the first section",
    brief.startsWith(`# Task ${T1}: `) && brief.split("\n").slice(2, 4).join("\n") === "## Next action (set 2026-10-01)\nOpen shop/checkout.py and read place_order", brief.slice(0, 200));
  await until(() => $(T("agent-start"))?.dataset.ready === "true" && !$(T("agent-start")).disabled, 8000);
  $(T("agent-start")).click();
  ok("[REQ-0059#AC3] the confirmation dialog shows that brief", await until(() => /## Next action \(set 2026-10-01\)/.test(txt(T("agent-brief"))), 5000), txt(T("agent-brief")).slice(0, 200));
  $(T("agent-dialog-cancel")).click();
  await until(() => !$(T("agent-dialog")), 3000);
}

// reqforge: verifies REQ-0059#AC2
async function acceptProposal() {
  ok("agent run on TASK-0001 finished", await runAgent(T1), txt(T("agent-run")).slice(-300));
  const want = proposalFor(T1);
  ok("[REQ-0059#AC2] the NEXT: line becomes a pending proposal in the drawer", await until(() => txt(T("next-proposal-text")) === want, 8000), txt(T("next-action")));
  let t = await task(T1);
  ok("[REQ-0059#AC2] pending on the task, next action unchanged until the user decides",
    t.next_action_proposal === want && /^RUN-TASK-0001-/.test(t.next_action_proposal_run || "") && t.next_action === "Open shop/checkout.py and read place_order", JSON.stringify(t));
  ok("[REQ-0059#AC2] Accept, Edit and Reject offered", !!($(T("next-proposal-accept")) && $(T("next-proposal-edit")) && $(T("next-proposal-reject"))));
  $(T("next-proposal-accept")).click();
  ok("[REQ-0059#AC2] Accept: the proposal is the next action", await until(() => txt(T("next-action-text")) === want && !$(T("next-proposal")), 8000), txt(T("next-action")));
  ok("[REQ-0059#AC3] the drawer shows the new date", txt(T("next-action-set")) === `set ${today()}`, txt(T("next-action-set")));
  t = await task(T1);
  ok("[REQ-0059#AC2] accepted on the server, proposal cleared", t.next_action === want && t.next_action_set === today() && !t.next_action_proposal, JSON.stringify(t));
  const brief = (await getJ(`/api/tasks/${T1}/agent`)).brief || "";
  ok("[REQ-0059#AC3] the next brief starts from the accepted next action", brief.includes(`\n\n## Next action (set ${today()})\n${want}\n\nKind:`), brief.slice(0, 250));
  await closeDrawer();
}

// reqforge: verifies REQ-0059#AC2
async function rejectProposal() {
  await openTask(T3);
  ok("TASK-0003 has no next action yet", !!$(T("next-action-none")), txt(T("next-action")));
  ok("agent run on TASK-0003 finished", await runAgent(T3), txt(T("agent-run")).slice(-300));
  ok("[REQ-0059#AC2] proposal shown for TASK-0003", await until(() => txt(T("next-proposal-text")) === proposalFor(T3), 8000), txt(T("next-action")));
  $(T("next-proposal-reject")).click();
  ok("[REQ-0059#AC2] Reject: the proposal goes, no next action is set", await until(() => !$(T("next-proposal")) && $(T("next-action-none")), 8000), txt(T("next-action")));
  const t = await task(T3);
  ok("[REQ-0059#AC2] rejected on the server", !t.next_action && !t.next_action_proposal, JSON.stringify(t));
  await closeDrawer();
}

// reqforge: verifies REQ-0059#AC1
// reqforge: verifies REQ-0059#AC2
async function editProposal() {
  await openTask(T4);
  ok("agent run on TASK-0004 finished", await runAgent(T4), txt(T("agent-run")).slice(-300));
  await until(() => $(T("next-proposal-edit")), 8000);
  $(T("next-proposal-edit")).click();
  await until(() => $(T("next-proposal-input")), 3000);
  ok("[REQ-0059#AC2] Edit starts from the proposed text", $(T("next-proposal-input")).value === proposalFor(T4), $(T("next-proposal-input"))?.value);
  ok("[REQ-0059#AC1] the editor holds at most 280 characters", $(T("next-proposal-input")).maxLength === 280);
  setVal($(T("next-proposal-input")), "think about it some more");
  await sleep(100);
  $(T("next-proposal-save")).click();
  ok("[REQ-0059#AC1] a next action that names no file, command or id is refused",
    await until(() => /must name a file path, command or record id/.test(txt(T("next-proposal-error"))), 5000), txt(T("next-proposal")));
  ok("[REQ-0059#AC2] the refused edit keeps the proposal", (await task(T4)).next_action_proposal === proposalFor(T4));
  setVal($(T("next-proposal-input")), "Fix the rounding in shop/checkout.py, then rerun TASK-0004's evals");
  await sleep(100);
  $(T("next-proposal-save")).click();
  ok("[REQ-0059#AC2] Edit: the edited text is the next action",
    await until(() => txt(T("next-action-text")) === "Fix the rounding in shop/checkout.py, then rerun TASK-0004's evals" && !$(T("next-proposal")), 8000), txt(T("next-action")));
  const t = await task(T4);
  ok("[REQ-0059#AC2] edit stored with today's date", t.next_action_set === today() && !t.next_action_proposal, JSON.stringify(t));
  await closeDrawer();
}

// reqforge: verifies REQ-0059#AC4
async function wrapUpOnClose() {
  await openChat();
  // a session with no applied changeset is never asked
  await say("hello");
  await closeChat();
  await sleep(2500);
  ok("[REQ-0059#AC4] closing a session without an applied changeset asks nothing", (await wrapCount()) === 0, `${await wrapCount()} wrap-up changesets`);
  await openChat();
  ok("[REQ-0059#AC4] no wrap-up message in that session", wrapMsgs() === 0, txt(T("chat-messages")).slice(-200));
  await applyInChat("close");
  await closeChat();
  ok("[REQ-0059#AC4] closing the panel after an apply asks the chat agent for next actions",
    await untilAsync(async () => (await wrapCount()) === 1), `${await wrapCount()} wrap-up changesets`);
  await openChat();
  await chatIdle();
  ok("[REQ-0059#AC4] the wrap-up turn is in the log with its changeset card",
    await until(() => wrapMsgs() === 1 && $$(T("cs-apply")).length === 1 && /Wrap-up: next actions/.test(txt(T("chat-messages"))), 8000),
    txt(T("chat-messages")).slice(-300));
  const cs = (await getJ("/api/changesets")).find((c) => c.title === WRAP);
  ok("[REQ-0059#AC4] it proposes next actions and a snapshot Next in one changeset",
    !!cs && JSON.stringify(await getJ(`/api/changesets/${cs.id}`)).includes("next_action") && JSON.stringify(await getJ(`/api/changesets/${cs.id}`)).includes("\"snapshot\""), JSON.stringify(cs));
  // close twice more: still asked only once
  await closeChat();
  await openChat();
  await closeChat();
  await sleep(2500);
  await openChat();
  ok("[REQ-0059#AC4] asked once per session, however often the panel closes", wrapMsgs() === 1 && (await wrapCount()) === 1, `${wrapMsgs()} messages, ${await wrapCount()} changesets`);
  // applying the wrap-up changeset changes the task (nothing changed before Apply)
  ok("[REQ-0059#AC4] nothing changes before Apply", !(await task("TASK-0002")).next_action);
  const sent = $$(T("msg-user")).length;
  $$(T("cs-apply")).filter((b) => !b.disabled).pop()?.click();
  // the card then sends its "I applied …" follow-up; let that turn finish before starting a new chat
  await until(() => $$(T("msg-user")).length > sent, 10000);
  ok("[REQ-0059#AC4] applying it sets TASK-0002's next action, dated today", await untilAsync(async () => {
    const t = await task("TASK-0002");
    return t.next_action === "Run `pytest tests/test_checkout.py`" && t.next_action_set === today();
  }, 10000), JSON.stringify(await task("TASK-0002")));
  await chatIdle();
}

// reqforge: verifies REQ-0059#AC4
async function wrapUpOnNew() {
  // New in a session that was already asked: no second wrap-up, the new session starts at once
  $(T("chat-new")).click();
  ok("New after the wrap-up starts a fresh session", await until(() => $$(T("msg-user")).length === 0, 5000) && (await wrapCount()) === 1, `${$$(T("msg-user")).length}`);
  await applyInChat("new");
  const n0 = await wrapCount();
  $(T("chat-new")).click();
  ok("[REQ-0059#AC4] New after an apply wraps up first (Wrapping up…)", await until(() => /Wrapping up/.test(txt(T("chat-new"))), 3000),
    `${txt(T("chat-new"))} wrap=${localStorage.getItem("reqforge.chat.wrap.SHOP")} session=${localStorage.getItem("reqforge.chat.session.SHOP")}`);
  ok("[REQ-0059#AC4] then the new session starts with an empty log", await until(() => $$(T("msg-user")).length === 0 && /New/.test(txt(T("chat-new"))), 20000), txt(T("chat-messages")).slice(-200));
  ok("[REQ-0059#AC4] exactly one wrap-up for that session", (await wrapCount()) === n0 + 1, `${n0} -> ${await wrapCount()}`);
  await closeChat();
  await sleep(2000);
  ok("[REQ-0059#AC4] the fresh session (nothing applied) is not asked on close", (await wrapCount()) === n0 + 1, `${await wrapCount()}`);
}
