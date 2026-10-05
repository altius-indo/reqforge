// Suite "panels": collapsible, resizable sidebar and chat panel (REQ-0064) in a workspace with SHOP and BARE, on the
// harness's 1500×950 window. Drags are trusted mouse input through the DevTools bridge; narrow screens are emulated.
// Phase 1 collapses and resizes; phase 2 (after a reload) checks persistence and a project switch; phase 3 (after a
// second reload) checks collapsed states, double-click reset and the narrow-screen behaviour.

const W = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
const side = () => $(T("sidebar"));
const rail = () => $(T("sidebar-rail"));
const chatPanel = () => $(T("chat-panel"));
const mainW = () => W($(T("main")));
const listW = () => W($(T("list-view")));
const shown = (el) => !!el && getComputedStyle(el).display !== "none";
const sizes = () => `sidebar ${W(side())} rail ${W(rail())} chat ${W(chatPanel())} main ${mainW()} list ${listW()}`;
const ready = () => until(() => $(T("list-view")) && rows().length > 0, 15000);

/** drag a handle horizontally by dx px with trusted mouse events */
async function drag(handle, dx) {
  const r = handle.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 4; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + Math.round((dx * i) / 4), y, button: "left", buttons: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}
const dblclick = async (el) => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 })); await sleep(150) };
const openChat = async () => { if (!chatPanel()) $(T("chat-toggle")).click(); return until(() => chatPanel() && W(chatPanel()) > 0, 4000) };
const closeChat = async () => { $(T("chat-close"))?.click(); return until(() => !chatPanel(), 4000) };
const viewport = (width) => cdp("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });

async function phase1() {
  ok("DevTools bridge available", await cdpReady());
  ok("SHOP list loaded", await ready(), location.hash);
  ok("defaults: sidebar 270 px, chat closed", W(side()) === 270 && !chatPanel(), sizes());

  // reqforge: verifies REQ-0064#AC1
  // ---------------------------------------------------------------- 1. collapse and expand the sidebar
  const [main0, list0] = [mainW(), listW()];
  $(T("sidebar-collapse")).click();
  ok("[REQ-0064#AC1] sidebar collapse control leaves a rail", await until(() => rail() && !side(), 3000), sizes());
  ok("[REQ-0064#AC1] collapsed sidebar rail is at most 48 px wide", W(rail()) > 0 && W(rail()) <= 48, sizes());
  ok("[REQ-0064#AC1] the rail has an expand control", shown($(T("sidebar-expand"))) && /expand/i.test($(T("sidebar-expand")).getAttribute("aria-label")));
  ok("[REQ-0064#AC1] the list takes the width the sidebar freed", mainW() - main0 === 270 - W(rail()) && listW() > list0, `${main0}/${list0} → ${sizes()}`);
  $(T("sidebar-expand")).click();
  ok("[REQ-0064#AC1] expand restores the sidebar at its width", await until(() => W(side()) === 270 && !rail(), 3000) && mainW() === main0, sizes());

  // reqforge: verifies REQ-0064#AC1
  // ---------------------------------------------------------------- 2. collapse the chat, reopen from the header
  ok("chat opens at 410 px", await openChat() && W(chatPanel()) === 410, sizes());
  const mainOpen = mainW(), listOpen = listW();
  ok("[REQ-0064#AC1] the chat panel has a collapse control", shown($(T("chat-close"))) && /collapse/i.test($(T("chat-close")).getAttribute("aria-label")));
  ok("[REQ-0064#AC1] collapsing the chat removes the panel", await closeChat(), sizes());
  ok("[REQ-0064#AC1] the list takes the width the chat freed", mainW() - mainOpen === 410 && listW() > listOpen, `${mainOpen}/${listOpen} → ${sizes()}`);
  $(T("chat-toggle")).click();
  ok("[REQ-0064#AC1] the header Chat button reopens the collapsed chat panel", await until(() => W(chatPanel()) === 410, 4000), sizes());

  // reqforge: verifies REQ-0064#AC2
  // ---------------------------------------------------------------- 3. drag the sidebar edge: 200–480 px
  const sh = () => $(T("sidebar-handle")), ch = () => $(T("chat-handle"));
  ok("[REQ-0064#AC2] the sidebar's resize handle sits on its inner edge", Math.abs(sh().getBoundingClientRect().left + sh().getBoundingClientRect().width / 2 - side().getBoundingClientRect().right) <= 2, `${sh().getBoundingClientRect().left} vs ${side().getBoundingClientRect().right}`);
  await drag(sh(), 100);
  ok("[REQ-0064#AC2] dragging the sidebar edge right widens it", W(side()) === 370, sizes());
  await drag(sh(), -1000);
  ok("[REQ-0064#AC2] the sidebar stops at 200 px", W(side()) === 200, sizes());
  await closeChat();
  await drag(sh(), 1000);
  ok("[REQ-0064#AC2] the sidebar stops at 480 px", W(side()) === 480, sizes());

  // ---------------------------------------------------------------- 4. drag the chat edge: 320–720 px, main ≥ 480 px
  await openChat();
  await drag(sh(), -280);
  ok("sidebar back to 200 px", W(side()) === 200, sizes());
  ok("[REQ-0064#AC2] the chat's resize handle sits on its inner edge", Math.abs(ch().getBoundingClientRect().left + ch().getBoundingClientRect().width / 2 - chatPanel().getBoundingClientRect().left) <= 2);
  await drag(ch(), -100);
  ok("[REQ-0064#AC2] dragging the chat edge left widens it", W(chatPanel()) === 510, sizes());
  await drag(ch(), -1000);
  ok("[REQ-0064#AC2] the chat stops at 720 px", W(chatPanel()) === 720, sizes());
  await drag(ch(), 1000);
  ok("[REQ-0064#AC2] the chat stops at 320 px", W(chatPanel()) === 320, sizes());
  await drag(sh(), 1000);
  await drag(ch(), -1000);
  ok("[REQ-0064#AC2] with a 480 px sidebar the chat grows only until the main area is 480 px", W(side()) === 480 && W(chatPanel()) === 540 && mainW() === 480, sizes());
  await drag(sh(), 100);
  ok("[REQ-0064#AC2] the sidebar cannot squeeze the main area below 480 px", W(side()) === 480 && mainW() === 480, sizes());
  await viewport(1100); await sleep(300);
  ok("[REQ-0064#AC2] a narrower window shrinks the panels, never the main area below 480 px", mainW() >= 480 && W(side()) >= 200 && W(chatPanel()) >= 320, sizes());
  await cdp("Emulation.clearDeviceMetricsOverride"); await sleep(300);
  ok("the chosen widths return when the window is wide again", W(side()) === 480 && W(chatPanel()) === 540, sizes());

  // the layout phase 2 expects after the reload: sidebar 334 px (collapsed), chat 500 px (open)
  await drag(sh(), -146);
  await drag(ch(), 40);
  ok("layout set: sidebar 334 px, chat 500 px", W(side()) === 334 && W(chatPanel()) === 500, sizes());
  $(T("sidebar-collapse")).click();
  await until(() => rail(), 3000);
  reloadInto(2);
}

async function phase2() {
  ok("SHOP list loaded after reload", await ready(), location.hash);

  // reqforge: verifies REQ-0064#AC4
  // ---------------------------------------------------------------- 5. persisted across a reload
  ok("[REQ-0064#AC4] the collapsed sidebar stays collapsed after a reload", !!rail() && !side(), sizes());
  ok("[REQ-0064#AC4] the chat panel stays open at its width after a reload", W(chatPanel()) === 500, sizes());
  $(T("sidebar-expand")).click();
  ok("[REQ-0064#AC4] the sidebar's width survives a reload", await until(() => W(side()) === 334, 3000), sizes());

  // reqforge: verifies REQ-0064#AC4
  // ---------------------------------------------------------------- 6. persisted across a project switch
  location.hash = "#/p/BARE";
  ok("switched to BARE", await until(() => /BARE/.test(project()) && $(T("list-view")) && rows().length > 0, 10000), location.hash + " " + project());
  ok("[REQ-0064#AC4] widths survive a project switch", W(side()) === 334 && W(chatPanel()) === 500, sizes());
  $(T("sidebar-collapse")).click();
  await until(() => rail(), 3000);
  await closeChat();
  location.hash = "#/p/SHOP";
  ok("switched back to SHOP", await until(() => /SHOP/.test(project()) && $(T("list-view")) && rows().length > 0, 10000), location.hash + " " + project());
  ok("[REQ-0064#AC4] collapsed states survive a project switch", !!rail() && !chatPanel(), sizes());
  reloadInto(3);
}

async function phase3() {
  ok("DevTools bridge available after reload", await cdpReady());
  ok("SHOP list loaded after second reload", await ready(), location.hash);
  ok("[REQ-0064#AC4] collapsed sidebar and chat stay collapsed after a reload", !!rail() && !chatPanel(), sizes());

  // reqforge: verifies REQ-0064#AC5
  // ---------------------------------------------------------------- 7. below lg: sheet and full-screen chat
  await viewport(900); await sleep(300);
  ok("[REQ-0064#AC5] below lg no sidebar column, rail or resize handle is shown", !shown(side()) && !shown(rail()) && !$$('[role="separator"]').some(shown), sizes());
  const menu = $('button[aria-label="open sidebar"]');
  ok("[REQ-0064#AC5] below lg the header has the sidebar menu button", shown(menu));
  menu.click();
  const sheet = () => $$('[role="dialog"]').find((d) => /Browse/.test(d.textContent));
  ok("[REQ-0064#AC5] below lg the sidebar opens as a sheet (even when collapsed on wide screens)", await until(() => sheet() && sheet().querySelector(T("tree")), 4000));
  await pressKey("Escape");
  await until(() => !sheet(), 3000);
  ok("[REQ-0064#AC5] main area spans the full width below lg", mainW() === 900, sizes());
  await openChat();
  const r = chatPanel().getBoundingClientRect();
  ok("[REQ-0064#AC5] below lg the chat opens full-screen", getComputedStyle(chatPanel()).position === "fixed" && Math.round(r.width) === 900 && Math.round(r.height) === 950 && !shown($(T("chat-handle"))), `${r.width}×${r.height}`);
  await closeChat();
  await cdp("Emulation.clearDeviceMetricsOverride"); await sleep(300);
  ok("wide again: the collapsed layout is back", !!rail() && W(rail()) <= 48 && !chatPanel(), sizes());

  // reqforge: verifies REQ-0064#AC4
  // ---------------------------------------------------------------- 8. double-click restores the default widths
  $(T("sidebar-expand")).click();
  await until(() => side(), 3000);
  await openChat();
  ok("widths before reset: sidebar 334, chat 500", W(side()) === 334 && W(chatPanel()) === 500, sizes());
  await dblclick($(T("sidebar-handle")));
  ok("[REQ-0064#AC4] double-clicking the sidebar handle restores 270 px", W(side()) === 270, sizes());
  await dblclick($(T("chat-handle")));
  ok("[REQ-0064#AC4] double-clicking the chat handle restores 410 px", W(chatPanel()) === 410, sizes());
  const saved = JSON.parse(localStorage.getItem("reqforge.panels") || "null");
  ok("[REQ-0064#AC4] the reset widths are stored in the browser", saved?.side === 270 && saved?.chat === 410 && saved?.sideCollapsed === false, JSON.stringify(saved));
  await closeChat();
}

async function suite() {
  if (phase === "1") await phase1();
  else if (phase === "2") await phase2();
  else if (phase === "3") await phase3();
}
