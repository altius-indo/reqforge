// Suite "panels-a11y": keyboard operation of the sidebar and chat resize handles (REQ-0064#AC3) on the 1500 px wide
// window. Keys are trusted key presses through the Chrome DevTools bridge (`pressKey`, lib/prelude.js).

const W = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
const side = () => $(T("sidebar"));
const rail = () => $(T("sidebar-rail"));
const chatPanel = () => $(T("chat-panel"));
const sh = () => $(T("sidebar-handle"));
const ch = () => $(T("chat-handle"));
const active = () => document.activeElement;
const focusDesc = () => { const a = active(); return a ? `${a.tagName.toLowerCase()}${a.dataset?.testid ? "#" + a.dataset.testid : ""}` : "none" };
const aria = (el) => el ? ["role", "aria-orientation", "aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-label"].map((a) => `${a}=${el.getAttribute(a)}`).join(" ") : "missing";
const now = (el) => +el.getAttribute("aria-valuenow");
const key = async (k, n = 1) => { for (let i = 0; i < n; i++) await pressKey(k); await sleep(120) };

async function suite() {
  ok("DevTools bridge available", await cdpReady());
  ok("SHOP list loaded", await until(() => $(T("list-view")) && rows().length > 0, 15000), location.hash);
  const vw = document.documentElement.clientWidth;

  // reqforge: verifies REQ-0064#AC3
  // ---------------------------------------------------------------- 1. the sidebar handle is a focusable separator
  const h = sh();
  ok("[REQ-0064#AC3] sidebar handle has role separator (vertical) and a label", h?.getAttribute("role") === "separator" && h.getAttribute("aria-orientation") === "vertical" && /sidebar/i.test(h.getAttribute("aria-label") || ""), aria(h));
  ok("[REQ-0064#AC3] sidebar handle reports aria-valuenow 270, aria-valuemin 200, aria-valuemax 480", now(h) === 270 && h.getAttribute("aria-valuemin") === "200" && h.getAttribute("aria-valuemax") === "480", aria(h));
  // Tab order: the sidebar's collapse button, …, then the handle right after the sidebar's contents
  const stops = [];
  $(T("sidebar-collapse")).focus();
  for (let i = 0; i < 80 && active() !== h; i++) { await pressKey("Tab"); stops.push(focusDesc()) }
  ok("[REQ-0064#AC3] the sidebar handle is reachable with Tab", active() === h && h.tabIndex === 0, `${stops.length} stops, at ${focusDesc()}`);

  // reqforge: verifies REQ-0064#AC3
  // ---------------------------------------------------------------- 2. arrow keys resize by 16 px, within the bounds
  await key("ArrowRight");
  ok("[REQ-0064#AC3] ArrowRight widens the sidebar by 16 px", now(h) === 286 && W(side()) === 286, `${aria(h)} width ${W(side())}`);
  await key("ArrowLeft", 2);
  ok("[REQ-0064#AC3] ArrowLeft narrows the sidebar by 16 px a press", now(h) === 254 && W(side()) === 254, `${aria(h)} width ${W(side())}`);
  await key("ArrowUp");
  ok("[REQ-0064#AC3] ArrowUp widens the sidebar by 16 px", now(h) === 270 && W(side()) === 270, aria(h));
  await key("ArrowDown");
  ok("[REQ-0064#AC3] ArrowDown narrows the sidebar by 16 px", now(h) === 254, aria(h));
  await key("End");
  await key("ArrowRight");
  ok("[REQ-0064#AC3] the keyboard cannot widen the sidebar past aria-valuemax", now(h) === 480 && W(side()) === 480, aria(h));
  await key("Home");
  await key("ArrowLeft");
  ok("[REQ-0064#AC3] the keyboard cannot narrow the sidebar below aria-valuemin", now(h) === 200 && W(side()) === 200, aria(h));
  await key("ArrowRight", 5);
  ok("sidebar at 280 px", now(h) === 280, aria(h));

  // reqforge: verifies REQ-0064#AC3
  // ---------------------------------------------------------------- 3. Enter toggles the sidebar's collapse
  await key("Enter");
  ok("[REQ-0064#AC3] Enter on the sidebar handle collapses the sidebar", await until(() => rail() && !side(), 3000), focusDesc());
  ok("[REQ-0064#AC3] focus moves to the rail's expand control", await until(() => active() === $(T("sidebar-expand")), 2000), focusDesc());
  await key("Enter");
  ok("[REQ-0064#AC3] Enter on the expand control brings the sidebar back at 280 px", await until(() => W(side()) === 280, 3000), `width ${W(side())}`);
  ok("[REQ-0064#AC3] focus returns to the sidebar handle", await until(() => active() === sh(), 2000), focusDesc());
  await key("Enter");
  ok("[REQ-0064#AC3] Enter on the handle again collapses the sidebar", await until(() => rail() && !side(), 3000));
  await key("Enter");
  await until(() => side() && active() === sh(), 3000);

  // reqforge: verifies REQ-0064#AC3
  // ---------------------------------------------------------------- 4. the chat handle
  $(T("chat-toggle")).click();
  await until(() => W(chatPanel()) === 410, 4000);
  const c = ch();
  const chatMax = Math.min(720, vw - 480 - 280);
  ok("[REQ-0064#AC3] chat handle has role separator (vertical) and a label", c?.getAttribute("role") === "separator" && c.getAttribute("aria-orientation") === "vertical" && /chat/i.test(c.getAttribute("aria-label") || "") && c.tabIndex === 0, aria(c));
  ok("[REQ-0064#AC3] chat handle reports aria-valuenow 410, aria-valuemin 320 and an aria-valuemax that keeps the main area ≥ 480 px", now(c) === 410 && c.getAttribute("aria-valuemin") === "320" && +c.getAttribute("aria-valuemax") === chatMax, `${aria(c)} (expected max ${chatMax})`);
  ok("[REQ-0064#AC3] the sidebar handle's aria-valuemax follows the open chat", +sh().getAttribute("aria-valuemax") === Math.min(480, vw - 480 - 410), aria(sh()));
  c.focus();
  await key("ArrowLeft");
  ok("[REQ-0064#AC3] ArrowLeft moves the chat's edge left: 16 px wider", now(c) === 426 && W(chatPanel()) === 426, `${aria(c)} width ${W(chatPanel())}`);
  await key("ArrowRight", 2);
  ok("[REQ-0064#AC3] ArrowRight moves the chat's edge right: 16 px narrower a press", now(c) === 394 && W(chatPanel()) === 394, aria(c));
  await key("End");
  ok("[REQ-0064#AC3] End widens the chat to aria-valuemax", now(c) === chatMax && W(chatPanel()) === chatMax, aria(c));
  await key("ArrowLeft");
  ok("[REQ-0064#AC3] the keyboard cannot widen the chat past aria-valuemax", now(c) === chatMax && W($(T("main"))) >= 480, aria(c));
  await key("Home");
  ok("[REQ-0064#AC3] Home narrows the chat to aria-valuemin", now(c) === 320 && W(chatPanel()) === 320, aria(c));

  // reqforge: verifies REQ-0064#AC3
  // ---------------------------------------------------------------- 5. Enter collapses the chat; the header button reopens it
  await key("Enter");
  ok("[REQ-0064#AC3] Enter on the chat handle collapses the chat panel", await until(() => !chatPanel(), 3000));
  ok("[REQ-0064#AC3] focus moves to the header Chat button", await until(() => active() === $(T("chat-toggle")), 2000), focusDesc());
  ok("the header Chat button reports the collapsed chat", $(T("chat-toggle")).getAttribute("aria-expanded") === "false");
  await key("Enter");
  ok("[REQ-0064#AC3] Enter on the header Chat button reopens the chat at its width", await until(() => W(chatPanel()) === 320, 3000), `width ${W(chatPanel())}`);
  $(T("chat-close")).click();
  await until(() => !chatPanel(), 3000);
}
