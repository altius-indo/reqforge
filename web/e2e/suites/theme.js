// Suite "theme": the UI follows prefers-color-scheme (light and dark, emulated through the Chrome DevTools bridge,
// `cdp` in lib/prelude.js) and every visible text in the list, the record drawer and the chat panel meets
// WCAG 2.2 AA contrast (1.4.3): 4.5:1 for normal text, 3:1 for large text (≥ 24px, or ≥ 18.66px bold).
// Runs on the BIG repository with the fake `claude -p`, so the chat holds choices and a changeset card.
// Disabled controls and text inside faded (opacity < 1) inactive UI are exempt, as in WCAG.

// ------------------------------------------------------------------ colour maths
const cvs = document.createElement("canvas");
cvs.width = cvs.height = 1;
const c2d = cvs.getContext("2d", { willReadFrequently: true });
/** any CSS colour (oklch, oklab, color-mix results, rgb, …) → [r, g, b, a] in sRGB 0–255, alpha 0–1 */
const rgba = (css) => {
  c2d.clearRect(0, 0, 1, 1);
  c2d.fillStyle = "rgba(0,0,0,0)";
  c2d.fillStyle = css;
  c2d.fillRect(0, 0, 1, 1);
  const d = c2d.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
};
const over = (top, bottom) => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
};
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) };

/** the opaque colour behind `el`: composite the background colours of its ancestors (canvas = white if none) */
const backdrop = (el) => {
  const layers = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const c = rgba(getComputedStyle(n).backgroundColor);
    if (c[3] > 0) layers.push(c);
    if (c[3] >= 1) break;
  }
  let bg = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
  return bg;
};

const inactive = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.matches(":disabled, [aria-disabled='true'], [data-disabled]")) return true;
    if (+getComputedStyle(n).opacity < 1) return true;
  }
  return false;
};
const visible = (el) => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr-only, [aria-hidden='true']");
};

/** elements under `root` that render text themselves (own text nodes, or a form control's value) */
const textElements = (root) => {
  const out = new Set();
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.nodeValue.trim() ? 1 : 3) });
  for (let t; (t = walk.nextNode());) if (t.parentElement) out.add(t.parentElement);
  root.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select").forEach((el) => { if (el.value) out.add(el) });
  return [...out].filter((el) => !["SCRIPT", "STYLE", "OPTION", "TITLE"].includes(el.tagName));
};

/** contrast failures in `root`: [{text, ratio, need, fg, bg}] and how many texts were measured */
const audit = (root) => {
  const fails = [];
  let measured = 0, exempt = 0;
  for (const el of textElements(root)) {
    if (!visible(el)) continue;
    if (inactive(el)) { exempt++; continue }
    const s = getComputedStyle(el);
    const bg = backdrop(el);
    const fg = over(rgba(s.color), bg);
    const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const r = ratio(fg, bg);
    measured++;
    if (r + 1e-6 < need) {
      const label = (el.value && el.matches("input,textarea,select") ? el.value : el.textContent).trim().replace(/\s+/g, " ").slice(0, 40);
      fails.push(`"${label}" ${r.toFixed(2)}:1 < ${need} (${s.color} on rgb(${bg.slice(0, 3).map(Math.round)}) ${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")})`);
    }
  }
  return { fails, measured, exempt };
};

// ------------------------------------------------------------------ scheme switching
const isDark = () => document.documentElement.classList.contains("dark");
const settle = async () => {
  await sleep(400);
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  await sleep(100);
};
const setScheme = async (scheme) => {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  const okSwitch = await until(() => matchMedia(`(prefers-color-scheme: ${scheme})`).matches && isDark() === (scheme === "dark"), 5000);
  await settle();
  return okSwitch;
};

const REGIONS = [
  ["list", () => [$("header"), $(T("sidebar")), $(T("list-view"))]],
  ["record drawer", () => [$(T("drawer"))]],
  ["chat panel", () => [$(T("chat-panel"))]],
];

async function checkScheme(scheme) {
  ok(`[REQ-0045#AC2] UI follows prefers-color-scheme: ${scheme}`, await setScheme(scheme), `dark class ${isDark()}`);
  const bodyL = lum(backdrop(document.body));
  ok(`[REQ-0045#AC2] ${scheme} scheme renders ${scheme} background`, scheme === "dark" ? bodyL < 0.05 : bodyL > 0.85, bodyL.toFixed(3));
  for (const [name, roots] of REGIONS) {
    const rs = roots().filter(Boolean);
    const res = rs.map(audit);
    const fails = res.flatMap((r) => r.fails), measured = res.reduce((n, r) => n + r.measured, 0);
    ok(`[REQ-0045#AC2] ${scheme}: ${name} text contrast ≥ 4.5:1 (AA)`, rs.length && measured > 5 && !fails.length,
      `${fails.length}/${measured} below AA: ${fails.slice(0, 6).join(" | ")}`);
  }
}

async function suite() {
  ok("DevTools bridge available", await cdpReady());
  await setScheme("light");
  await until(() => rows().length > 0, 15000);
  await until(() => $$(T("tree-type")).length > 0 && $(T("facet-chip")), 20000);

  // ---------------------------------------------------------------- state: filter pill, selection + bulk bar,
  // chat with choices / tool group / changeset card, record drawer open on the details form
  $(`${T("facet-chip")}[data-facet="status"][data-value="approved"]`)?.click();
  await until(() => /status: approved/.test(txt(T("crumbs"))), 8000); await sleep(400);
  rows()[1].querySelector(T("row-check")).click();
  await until(() => $(T("bulk-bar")), 4000);
  $(T("chat-toggle")).click();
  await until(() => $(T("chat-input")), 4000);
  setVal($(T("chat-input")), "Add an audit log retention requirement"); await sleep(100);
  $(T("chat-send")).click();
  await until(() => $$(T("choice-option")).length === 2 && !$(T("choice-option")).disabled, 20000);
  $(T("choice-option")).click();
  ok("chat holds a changeset card", await until(() => $(T("changeset-card")) && $(T("cs-apply")) && !$(T("chat-stop")), 20000));
  rows()[0].click();
  ok("record drawer open", await until(() => $(T("drawer")) && /v\d+/.test(txt(T("drawer-title"))) && $(T("details-form")), 8000));
  // let the focus ring settle somewhere neutral
  document.activeElement?.blur?.();

  // reqforge: verifies REQ-0045#AC2
  await checkScheme("light");
  // reqforge: verifies REQ-0045#AC2
  await checkScheme("dark");
  // reqforge: verifies REQ-0045#AC2
  // the links tab of the drawer in dark mode too (impact, acceptance criteria, lint lists)
  mdown($(T("drawer-tab-links")));
  await until(() => /Realised by stories/.test(txt(T("links-panel"))), 8000); await settle();
  const links = audit($(T("drawer")));
  ok("[REQ-0045#AC2] dark: drawer links & impact contrast ≥ 4.5:1 (AA)", links.measured > 5 && !links.fails.length, `${links.fails.length}/${links.measured}: ${links.fails.slice(0, 6).join(" | ")}`);
  await setScheme("light");
  const linksLight = audit($(T("drawer")));
  ok("[REQ-0045#AC2] light: drawer links & impact contrast ≥ 4.5:1 (AA)", linksLight.measured > 5 && !linksLight.fails.length, `${linksLight.fails.length}/${linksLight.measured}: ${linksLight.fails.slice(0, 6).join(" | ")}`);
  // switching back follows the OS change live
  ok("[REQ-0045#AC2] switching scheme at runtime follows the OS", await setScheme("dark") && isDark() && await setScheme("light") && !isDark());
}
