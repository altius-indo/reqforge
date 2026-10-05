// Suite "snapshot": the project snapshot (state/HOT.md, REQ-0057/REQ-0058) in the UI, on the SHOP demo
// (examples/seed_demo.py, --no-code) which starts without a snapshot. The chat panel shows "No project snapshot" with
// an action that asks Claude to draft one; web/e2e/fake-claude.py answers that by proposing a changeset with a
// snapshot op; its card shows the diff; Apply writes the file. A second snapshot changeset, proposed over the API,
// shows a diff against the applied content. run.mjs then checks on disk that only the apply commit wrote the file.
// Helpers (ok, until, T, $, $$, setVal, sendJ, getJ, …) come from web/e2e/lib/prelude.js.

const SNAP_URL = E2E.sessionsUrl.replace(/sessions$/, "snapshot");
const CS_URL = E2E.sessionsUrl.replace(/sessions$/, "changesets");
const card = (id) => $(`${T("changeset-card")}[data-id="${id}"]`);
const diffLines = (root) => [...(root?.querySelectorAll(T("cs-diff-line")) || [])].map((l) => [l.dataset.t, l.textContent.slice(1)]);

async function suite() {
  await until(() => project().endsWith("SHOP") && $(T("chat-toggle")), 15000);
  const csId = await emptyState();
  if (!csId) return;
  const applied = await draftCard(csId);
  if (!applied) return;
  await diffAgainstApplied(applied);
}

// reqforge: verifies REQ-0058#AC4
async function emptyState() {
  const before = await getJ(SNAP_URL);
  ok("[REQ-0058#AC4] demo project starts without a snapshot", before.exists === false, JSON.stringify(before));
  if (!$(T("chat-input"))) $(T("chat-toggle")).click();
  await until(() => $(T("chat-input")) && $(T("chat-no-snapshot")), 8000);
  ok("[REQ-0058#AC4] chat panel shows 'No project snapshot'", /No project snapshot/.test(txt(T("chat-no-snapshot"))), txt(T("chat-panel")).slice(0, 200));
  const action = $(T("chat-draft-snapshot"));
  ok("[REQ-0058#AC4] notice has an action to ask Claude to draft one", !!action && /Ask Claude to draft/.test(action.textContent), action?.textContent);
  action?.click();
  await until(() => /^Draft a project snapshot/.test($(T("chat-input"))?.value || ""), 3000);
  const draft = $(T("chat-input"))?.value || "";
  ok("[REQ-0058#AC4] the action puts a draft request in the chat input", /^Draft a project snapshot \(state\/HOT\.md\)/.test(draft) && /snapshot op/.test(draft), draft);
  $(T("chat-send")).click();
  await until(() => $(T("changeset-card")) && !$(T("chat-stop")), 20000);
  ok("[REQ-0058#AC4] a session starts normally without a snapshot",
    $$(T("msg-asst")).some((m) => /Drafted the snapshot/.test(m.textContent)), txt(T("chat-messages")).slice(0, 300));
  return $(T("changeset-card"))?.dataset.id;
}

// reqforge: verifies REQ-0057#AC2
async function draftCard(id) {
  const c = card(id);
  const op = c?.querySelector(T("cs-op"));
  ok("[REQ-0057#AC2] changeset card lists the snapshot op", op?.dataset.op === "snapshot" && /state\/HOT\.md/.test(op.textContent) && /1 operations/.test(c.textContent), c?.textContent.slice(0, 200));
  const lines = diffLines(c);
  ok("[REQ-0057#AC2] card shows the diff of a new file: every line added",
    lines.length > 8 && lines.every(([t]) => t === "+"), JSON.stringify(lines).slice(0, 300));
  const added = lines.map(([, l]) => l);
  ok("[REQ-0057#AC2] diff holds the Now, Next and Watch headings and the date",
    ["## Now", "## Next", "## Watch"].every((h) => added.includes(h)) && added.some((l) => /^Last reconciled: \d{4}-\d{2}-\d{2}$/.test(l)), added.join(" / "));
  ok("[REQ-0057#AC2] snapshot op summary says new file", /new file/.test(txt(T("cs-snapshot-meta"))) && /\+\d+/.test(txt(T("cs-snapshot-meta"))), txt(T("cs-snapshot-meta")));
  ok("valid snapshot changeset", /valid/.test(c?.querySelector(T("cs-verdicts"))?.textContent || "") && !c.querySelector(T("cs-apply"))?.disabled, c?.querySelector(T("cs-verdicts"))?.textContent);
  const pending = await getJ(SNAP_URL);
  ok("[REQ-0057#AC2] proposing does not write state/HOT.md", pending.exists === false, JSON.stringify(pending).slice(0, 200));

  c.querySelector(T("cs-apply")).click();
  await until(() => card(id)?.dataset.status === "applied", 15000);
  ok("[REQ-0057#AC2] Apply applies the snapshot changeset", card(id)?.dataset.status === "applied", card(id)?.dataset.status);
  const after = await getJ(SNAP_URL);
  ok("[REQ-0057#AC2] Apply writes state/HOT.md with the proposed content",
    after.exists && after.content.trimEnd().split("\n").join("\n") === added.join("\n") && !(after.errors || []).length, JSON.stringify(after).slice(0, 300));
  ok("[REQ-0058#AC4] notice goes away once a snapshot exists", await until(() => !$(T("chat-no-snapshot")), 8000), txt(T("chat-panel")).slice(0, 120));
  await until(() => /Verified/.test(txt(T("chat-messages"))), 15000);
  return after.exists ? after.content : null;
}

// reqforge: verifies REQ-0057#AC2
async function diffAgainstApplied(old) {
  const next = old.replace("- Ship guest checkout", "- Harden card data handling");
  const r = await sendJ("POST", CS_URL, { title: "Move Next to card data", summary: "e2e: second snapshot", ops: [{ op: "snapshot", content: next, reason: "e2e" }] });
  const id = r.body?.changeset_id;
  ok("second snapshot changeset proposed over the API", r.status === 201 && !!id, JSON.stringify(r).slice(0, 300));
  $(T("chat-close"))?.click();
  $(T("tab-changes")).click();
  await until(() => $(`${T("changeset-row")}[data-id="${id}"]`), 10000);
  $(`${T("changeset-row")}[data-id="${id}"]`)?.click();
  await until(() => $(`${T("changes-view")} ${T("changeset-card")}[data-id="${id}"] ${T("cs-snapshot-diff")}`), 10000);
  const c = $(`${T("changes-view")} ${T("changeset-card")}[data-id="${id}"]`);
  const lines = diffLines(c);
  const of = (t) => lines.filter(([x]) => x === t).map(([, l]) => l);
  ok("[REQ-0057#AC2] card diff against the applied snapshot: one line removed, one added",
    of("-").join() === "- Ship guest checkout" && of("+").join() === "- Harden card data handling", JSON.stringify(lines).slice(0, 400));
  ok("[REQ-0057#AC2] unchanged lines kept as context", of(" ").includes("## Next") && of(" ").length === lines.length - 2, of(" ").join(" / "));
  ok("snapshot op summary counts +1 −1", /\+1\s*−1/.test(c?.querySelector(T("cs-snapshot-meta"))?.textContent || "") && !/new file/.test(c?.textContent || ""),
    c?.querySelector(T("cs-snapshot-meta"))?.textContent);
  const still = await getJ(SNAP_URL);
  ok("[REQ-0057#AC2] a pending snapshot changeset leaves the file as applied", still.content === old, (still.content || "").slice(0, 200));
}
