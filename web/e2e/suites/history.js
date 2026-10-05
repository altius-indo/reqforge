// Suite "history": the gap prompt at session start and the pause action (REQ-0062#AC4) on the SHOP demo served with
// --repo, whose history/sessions.jsonl (written by run.mjs) holds one chat session that ended 30 days ago.
// Phase 1: the chat panel shows an unexplained 30-day gap; the project is paused with a reason on the Projects page.
// Phase 2 (after a reload): the same gap is now deliberate and shows the pause reason; the user records it with a
// reason, and the next session start shows no gap. run.mjs then checks the history file itself.
// Helpers (ok, until, T, $, $$, setVal, reloadInto, …) come from web/e2e/lib/prelude.js.

const PAUSE_REASON = "E2E: waiting for the security review";
const GAP_REASON = "E2E: the review took a month";

const openChat = async () => {
  if (!$(T("chat-panel"))) $(T("chat-toggle")).click();
  return until(() => $(T("chat-panel")), 5000);
};
const gapCard = () => $(T("gap-prompt"));

async function suite() {
  if (phase === "1") return phaseOne();
  if (phase === "2") return phaseTwo();
}

async function phaseOne() {
  await until(() => project().endsWith("SHOP") && $(T("chat-toggle")), 15000);
  await unexplainedGap();
  await pauseProject();
  reloadInto(2, "#/");
}

// reqforge: verifies REQ-0062#AC4
async function unexplainedGap() {
  ok("chat panel opens", await openChat(), txt(T("main")).slice(0, 200));
  ok("[REQ-0062#AC4] session start shows the gap since the last session", await until(gapCard, 15000), txt(T("chat-messages")).slice(0, 200));
  ok("[REQ-0062#AC4] gap length shown in days", txt(T("gap-days")).trim() === "30 days", txt(T("gap-days")));
  ok("[REQ-0062#AC4] gap without a pause is unexplained",
    gapCard()?.dataset.gap === "unexplained" && txt(T("gap-kind")).trim() === "unexplained", txt(T("gap-prompt")));
  ok("[REQ-0062#AC4] a field to give a reason", !!$(T("gap-reason")) && !!$(T("gap-save")), gapCard()?.innerHTML.slice(0, 300));
  const api = await getJ("/api/history/gap");
  ok("pending gap is not recorded by showing it", api.gap && api.gap.days === 30 && !(await getJ("/api/history")).gaps.length, JSON.stringify(api));
}

// reqforge: verifies REQ-0062#AC4
async function pauseProject() {
  location.hash = "#/projects";
  ok("projects page lists the project", await until(() => $(`${T("project-row")}[data-key="SHOP"]`), 8000), txt(T("main")).slice(0, 200));
  const btn = $(`${T("project-row")}[data-key="SHOP"] ${T("project-pause")}`);
  ok("[REQ-0062#AC4] project settings offer a pause action", !!btn && !btn.disabled, $(T("project-row"))?.innerHTML.slice(0, 300));
  btn?.click();
  ok("pause dialog opens", await until(() => $(T("pause-dialog")), 4000));
  ok("pause needs a reason", $(T("pause-save"))?.disabled === true, $(T("pause-save"))?.outerHTML);
  setVal($(T("pause-reason")), PAUSE_REASON);
  await until(() => !$(T("pause-save")).disabled, 2000);
  $(T("pause-save")).click();
  ok("pause dialog closes after saving", await until(() => !$(T("pause-dialog")), 6000), txt(T("pause-dialog")));
  const h = await getJ("/api/history");
  ok("[REQ-0062#AC4] project paused with the reason", h.pauses.length === 1 && h.pauses[0].reason === PAUSE_REASON, JSON.stringify(h.pauses));
}

async function phaseTwo() {
  await until(() => project().endsWith("SHOP") && $(T("chat-toggle")), 15000);
  await deliberateGap();
  await recordReason();
  await nextSession();
}

// reqforge: verifies REQ-0062#AC4
async function deliberateGap() {
  ok("chat panel opens after reload", await openChat());
  ok("[REQ-0062#AC4] gap shown again at the next session start", await until(gapCard, 15000), txt(T("chat-messages")).slice(0, 200));
  ok("[REQ-0062#AC4] gap after a pause with a reason is deliberate",
    gapCard()?.dataset.gap === "deliberate" && txt(T("gap-kind")).trim() === "deliberate", txt(T("gap-prompt")));
  ok("[REQ-0062#AC4] the pause reason is shown with the gap", txt(T("gap-pause-reason")) === PAUSE_REASON, txt(T("gap-prompt")));
}

// reqforge: verifies REQ-0062#AC4
async function recordReason() {
  setVal($(T("gap-reason")), GAP_REASON);
  await sleep(100);
  $(T("gap-save")).click();
  ok("[REQ-0062#AC4] the user's reason is recorded", await until(() => $(T("gap-recorded")), 6000), txt(T("gap-prompt")));
  ok("recorded note names the type and the reason",
    /deliberate gap/.test(txt(T("gap-recorded"))) && txt(T("gap-recorded")).includes(GAP_REASON), txt(T("gap-recorded")));
  const h = await getJ("/api/history");
  const g = h.gaps[0] || {};
  ok("[REQ-0062#AC4] gap stored as deliberate with both reasons",
    h.gaps.length === 1 && g.gap === "deliberate" && g.reason === GAP_REASON && g.pause_reason === PAUSE_REASON && g.days === 30, JSON.stringify(h.gaps));
  ok("[REQ-0062#AC4] no gap pending once recorded", !h.pending_gap, JSON.stringify(h.pending_gap));
}

// reqforge: verifies REQ-0062#AC4
async function nextSession() {
  $(T("chat-new")).click();
  await sleep(400);
  ok("[REQ-0062#AC4] a fresh session after the recorded gap shows no gap", !gapCard(), txt(T("gap-prompt")));
  $(T("chat-close")).click();
  await until(() => !$(T("chat-panel")), 3000);
  await openChat();
  await sleep(600);
  ok("reopening the chat shows no gap either", !gapCard(), txt(T("gap-prompt")));
}
