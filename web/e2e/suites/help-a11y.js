// Suite "help-a11y": keyboard operation of the help panel (REQ-0048#AC6) on the BIG repository.
// Keys are trusted key presses sent through the Chrome DevTools bridge (`pressKey`, lib/prelude.js), so focus
// trapping, Enter activation and Esc behave as for a real keyboard.

const panel = () => $(T("help-panel"));
const active = () => document.activeElement;
const inPanel = () => !!panel() && panel().contains(active());
const focusDesc = () => { const a = active(); return a ? `${a.tagName.toLowerCase()}${a.dataset?.testid ? "#" + a.dataset.testid : ""}` : "none" };

async function suite() {
  ok("DevTools bridge available", await cdpReady());
  await until(() => rows().length > 0, 15000);

  // reqforge: verifies REQ-0048#AC6
  // ---------------------------------------------------------------- 1. open from the keyboard, focus moves in
  const btn = $(T("help-button"));
  ok("[REQ-0048#AC6] Help button is a focusable button with an accessible name", btn?.tagName === "BUTTON" && /help/i.test(btn.textContent) && btn.getAttribute("aria-haspopup") === "dialog");
  btn.focus();
  await pressKey("Enter");
  ok("[REQ-0048#AC6] Enter on the focused Help button opens the panel", await until(() => panel(), 5000));
  await until(() => $$(T("help-section")).length > 0, 8000);
  ok("[REQ-0048#AC6] focus moves into the panel on open (search box)", await until(() => active() === $(T("help-search")), 3000), focusDesc());
  ok("[REQ-0048#AC6] Help button reports the expanded state", btn.getAttribute("aria-expanded") === "true", btn.getAttribute("aria-expanded"));
  const titleId = panel().getAttribute("aria-labelledby");
  ok("[REQ-0048#AC6] panel is a labelled dialog", panel().getAttribute("role") === "dialog" && !!titleId && document.getElementById(titleId)?.textContent === "Help", titleId);
  ok("[REQ-0048#AC6] search box has an accessible name", !!$(T("help-search")).getAttribute("aria-label"));

  // reqforge: verifies REQ-0048#AC6
  // ---------------------------------------------------------------- 2. Tab stays inside, contents are operable
  const seen = new Set();
  let escaped = "";
  for (let i = 0; i < 14; i++) {
    await pressKey("Tab"); await sleep(60);
    if (!inPanel()) { escaped = focusDesc(); break }
    seen.add(active());
  }
  ok("[REQ-0048#AC6] Tab keeps focus inside the open panel", !escaped && seen.size >= 3, escaped || `${seen.size} stops`);
  for (let i = 0; i < 4; i++) { await pressKey("Tab", true); await sleep(60); if (!inPanel()) { escaped = focusDesc(); break } }
  ok("[REQ-0048#AC6] Shift+Tab keeps focus inside the open panel", !escaped, escaped);
  const toc = $(`${T("help-toc-item")}[data-section="projects"]`);
  toc.focus();
  await pressKey("Enter"); await sleep(250);
  ok("[REQ-0048#AC6] contents entries work from the keyboard", $(T("help-body"))?.dataset.section === "projects" && toc.getAttribute("aria-current") === "true", $(T("help-body"))?.dataset.section);
  $(T("help-search")).focus();
  setVal($(T("help-search")), "lint"); await sleep(150);

  // reqforge: verifies REQ-0048#AC6
  // ---------------------------------------------------------------- 3. Esc closes, focus returns to the Help button
  await pressKey("Escape");
  ok("[REQ-0048#AC6] Esc closes the panel", await until(() => !panel(), 4000));
  ok("[REQ-0048#AC6] focus returns to the Help button", await until(() => active() === $(T("help-button")), 3000), focusDesc());
  ok("[REQ-0048#AC6] Help button reports the collapsed state", $(T("help-button")).getAttribute("aria-expanded") === "false");

  // ---------------------------------------------------------------- 4. reopening starts fresh (empty search)
  await pressKey("Enter");
  await until(() => panel() && $(T("help-search")), 5000);
  ok("reopened panel starts with an empty search", $(T("help-search"))?.value === "" && $$(T("help-section")).length >= 6, $(T("help-search"))?.value);
  await pressKey("Escape");
  await until(() => !panel(), 4000);

  // reqforge: verifies REQ-0048#AC6
  // ---------------------------------------------------------------- 5. Esc with the record drawer open beneath
  rows()[0].click();
  await until(() => $(T("drawer")) && /v\d+/.test(txt(T("drawer-title"))), 8000);
  $(T("help-button")).click();
  await until(() => panel(), 5000);
  ok("[REQ-0048#AC6] focus moves into the panel over the record drawer", await until(() => active() === $(T("help-search")), 3000), focusDesc());
  await pressKey("Escape");
  await until(() => !panel(), 4000); await sleep(300);
  ok("[REQ-0048#AC6] Esc closes only the help panel, not the drawer beneath", !panel() && !!$(T("drawer")));
  ok("[REQ-0048#AC6] focus returns to the Help button (drawer open)", active() === $(T("help-button")), focusDesc());
  await pressKey("Escape");
  ok("next Esc closes the record drawer", await until(() => !$(T("drawer")), 3000));

  // ---------------------------------------------------------------- 6. the chat panel's help button
  $(T("chat-toggle")).click();
  await until(() => $(T("chat-help")), 4000);
  $(T("chat-help")).focus();
  await pressKey("Enter");
  await until(() => panel(), 5000);
  ok("chat help opens the panel with focus inside", await until(() => active() === $(T("help-search")), 3000), focusDesc());
  await pressKey("Escape");
  await until(() => !panel(), 4000);
  ok("focus returns to the chat panel's help button", await until(() => active() === $(T("chat-help")), 3000), focusDesc());
}
