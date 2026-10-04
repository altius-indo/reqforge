// Browser-side helpers shared by every suite. run.mjs injects this file, then one suite file, into a copy of
// web/dist/index.html, wrapped in one async IIFE, after `window.__E2E = {suite, sessionsUrl, workspaceName}`.
//
// Reporting: `ok(name, cond, detail)` records a PASS/FAIL line. The log lives in sessionStorage so it survives
// page reloads (multi-phase suites) and so run.mjs can read a partial log over CDP when a suite times out.
// When the suite finishes, the log is POSTed as a session (`sessions/ELI-*.md`), which run.mjs waits for.

const E2E = window.__E2E || {};
const PHASE_KEY = "e2e.phase", LOG_KEY = "e2e.log";
const phase = sessionStorage.getItem(PHASE_KEY) || "1";
const log = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
const saveLog = () => sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
const ok = (n, c, x = "") => { log.push((c ? "PASS " : "FAIL ") + n + (c ? "" : " :: " + String(x).replace(/\s+/g, " ").slice(0, 300))); saveLog() };
window.addEventListener("error", (e) => { log.push("JSERROR " + e.message); saveLog() });
window.addEventListener("unhandledrejection", (e) => { log.push("JSERROR unhandled " + ((e.reason && e.reason.message) || e.reason)); saveLog() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return true } catch {} await sleep(80) } return false };
const T = (t) => `[data-testid="${t}"]`;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const txt = (s) => ($(s)?.textContent || "");
const setVal = (el, v) => {
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const press = (el, key) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
// Radix triggers (dropdowns, tabs) react to pointerdown/mousedown rather than click.
const pdown = (el) => {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
};
const mdown = (el) => { pdown(el); el.click() };
const rows = () => $$(T("row"));
const rowIds = () => rows().map((r) => r.dataset.id).join(",");
const pagerTotal = () => +(txt(T("pager-range")).match(/of ([\d,]+)/) || [0, "-1"])[1].replace(/,/g, "");
const getJ = async (u) => (await fetch(u)).json();
const project = () => txt(T("project"));
const toasts = () => $$("[data-sonner-toast]").map((t) => t.textContent).join(" | ");
/** JSON request from the page (same origin, so the server's CSRF guard accepts it): {status, body} */
const sendJ = async (method, u, body) => {
  const r = await fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// Chrome DevTools bridge (run.mjs binds window.__e2eCdp once it has attached): Emulation.* / Input.* commands only.
// `cdp` resolves when Chrome has executed the command (false after 5s); `pressKey` sends a trusted key press to
// the focused element.
const cdpReady = () => until(() => typeof window.__e2eCdp === "function", 15000);
const cdpWaiters = new Map();
let cdpSeq = 0;
window.__e2eCdpDone = (id) => { cdpWaiters.get(id)?.(true); cdpWaiters.delete(id) };
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++cdpSeq;
  cdpWaiters.set(id, resolve);
  window.__e2eCdp(JSON.stringify({ method, params, id }));
  setTimeout(() => { if (cdpWaiters.delete(id)) resolve(false) }, 5000);
});
const KEYS = { Escape: 27, Tab: 9, Enter: 13 };
const pressKey = async (k, shift = false) => {
  const base = { key: k, code: k, windowsVirtualKeyCode: KEYS[k], nativeVirtualKeyCode: KEYS[k], modifiers: shift ? 8 : 0 };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k === "Enter" ? { text: "\r" } : {}) });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const openSwitcher = async () => { if (!$(T("switcher-menu"))) pdown($(T("project-switcher"))); return until(() => $(T("switcher-menu")) && $$(T("switcher-item")).length > 0, 4000) };

let reloading = false, finished = false;
// Continue the suite in `next` phase after a page reload (the injected script runs again on load).
const reloadInto = (next, hash) => {
  reloading = true;
  sessionStorage.setItem(PHASE_KEY, String(next));
  saveLog();
  if (hash !== undefined) location.hash = hash;
  location.reload();
};
const finish = async () => {
  if (finished) return;
  finished = true;
  sessionStorage.setItem(PHASE_KEY, "done");
  saveLog();
  await fetch(E2E.sessionsUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "E2E-" + String(E2E.suite || "suite").toUpperCase(), markdown: log.join("\n") }) });
};
const runSuite = async (suite) => {
  if (phase === "done") return;
  try { await suite() } catch (e) { log.push("EXC " + e.message + " " + String(e.stack || "").replace(/\s+/g, " ")); saveLog() }
  if (!reloading) await finish();
};
