#!/usr/bin/env node
// End-to-end UI tests: drive the built web UI (web/dist) in headless Chrome against a real reqforge server.
//
//   node web/e2e/run.mjs [--suite core|projects|code|help|help-a11y|theme|task-start|agent-start|agent-queue|task-complete|design|snapshot|history|decisions|next-action|all] [--junit <file>] [--keep] [--timeout <seconds>]
//
// For each suite: seed fresh data with the repo's seeders (examples/*.py) in a new os.tmpdir() directory, copy
// web/dist and inject lib/prelude.js + suites/<suite>.js into its index.html, serve that copy with the reqforge
// binary (REQFORGE_UI_DIR), open it in headless Chrome, and wait for the injected script to POST its PASS/FAIL
// log as a session (sessions/ELI-*.md). Prints a summary, optionally writes JUnit XML, exits 1 on any failure.
// Node >= 22 built-ins only (global fetch/WebSocket); needs python3, git and Chrome/Chromium.
//
// Environment: REQFORGE_BIN (reqforge binary; default server/target/release/reqforge, built if missing),
// CHROME (browser executable), PYTHON (default python3).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const ROOT = path.resolve(WEB, "..");
const PYTHON = process.env.PYTHON || "python3";
const SUITE_NAMES = ["core", "projects", "code", "help", "help-a11y", "theme", "task-start", "agent-start", "agent-queue", "task-complete", "design", "snapshot", "history", "decisions", "next-action"];

// ------------------------------------------------------------------------------------------------ arguments
function parseArgs(argv) {
  const o = { suite: "all", junit: null, keep: false, timeout: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]; if (v === undefined) die(`${a} needs a value`); return v };
    if (a === "--suite" || a.startsWith("--suite=")) o.suite = val();
    else if (a === "--junit" || a.startsWith("--junit=")) o.junit = val();
    else if (a === "--timeout" || a.startsWith("--timeout=")) o.timeout = +val();
    else if (a === "--keep") o.keep = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node web/e2e/run.mjs [--suite core|projects|code|help|help-a11y|theme|task-start|agent-start|agent-queue|task-complete|design|snapshot|history|decisions|next-action|all] [--junit <file>] [--keep] [--timeout <seconds>]");
      process.exit(0);
    } else die(`unknown argument: ${a}`);
  }
  const suites = o.suite === "all" ? SUITE_NAMES : o.suite.split(",");
  for (const s of suites) if (!SUITE_NAMES.includes(s)) die(`unknown suite: ${s} (${SUITE_NAMES.join(", ")}, all)`);
  if (o.timeout !== null && !(o.timeout > 0)) die("--timeout must be a positive number of seconds");
  return { ...o, suites };
}

function die(msg) {
  console.error(`e2e: ${msg}`);
  process.exit(2);
}

// ------------------------------------------------------------------------------------------------ processes
const children = new Set();

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} exited ${r.status}\n${(r.stderr || "") + (r.stdout || "")}`.trim());
  return r.stdout;
}

function start(cmd, args, logFile, env) {
  const fd = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, { env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.exited = new Promise((r) => child.once("exit", (code, sig) => { children.delete(child); r(code ?? sig) }));
  child.once("error", () => {});
  children.add(child);
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await Promise.race([child.exited.then(() => true), sleep(4000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([child.exited, sleep(2000)]);
}

function killAll() {
  for (const c of children) try { c.kill("SIGKILL") } catch {}
}

process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAll(); process.exit(130) });

const shortPath = (p) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith("..") ? r : p };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)) });
  });
}

function tail(file, n = 25) {
  try { return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n") } catch { return "" }
}

// ------------------------------------------------------------------------------------------------ prerequisites
function findBinary() {
  if (process.env.REQFORGE_BIN) {
    const b = path.resolve(process.env.REQFORGE_BIN);
    if (!fs.existsSync(b)) die(`REQFORGE_BIN=${b} does not exist`);
    return b;
  }
  const b = path.join(ROOT, "server", "target", "release", "reqforge");
  if (!fs.existsSync(b)) {
    console.log("e2e: building the reqforge release binary (cargo build --release)…");
    const r = spawnSync("cargo", ["build", "--release", "--manifest-path", path.join(ROOT, "server", "Cargo.toml")], { stdio: "inherit" });
    if (r.status !== 0 || !fs.existsSync(b)) die("cargo build failed (install Rust from https://rustup.rs or set REQFORGE_BIN)");
  }
  return b;
}

function ensureDist() {
  const index = path.join(WEB, "dist", "index.html");
  if (fs.existsSync(index)) return;
  console.log("e2e: web/dist/index.html missing, running npm run build…");
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: WEB, stdio: "inherit" });
  if (r.status !== 0 || !fs.existsSync(index)) die("npm run build failed");
}

function onPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch {}
  }
  return null;
}

function findChrome() {
  if (process.env.CHROME) {
    const c = fs.existsSync(process.env.CHROME) ? process.env.CHROME : onPath(process.env.CHROME);
    if (!c) die(`CHROME=${process.env.CHROME} not found`);
    return c;
  }
  const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium",
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
  for (const base of ["/Applications", path.join(os.homedir(), "Applications")])
    for (const a of apps) if (fs.existsSync(path.join(base, a))) return path.join(base, a);
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) { const p = onPath(n); if (p) return p }
  die("Chrome not found: set CHROME to a Chrome/Chromium executable");
}

// An x64 Node on an Apple-silicon Mac runs under Rosetta, and a universal Chrome it spawns inherits the x86_64 slice:
// translated V8 runs the UI one to two orders of magnitude slower (the help panel's first render took ~20 s instead
// of well under 1 s), so timing checks fail for reasons unrelated to the UI. Launch the native arm64 slice instead.
function chromeCommand(chrome, args) {
  if (process.platform !== "darwin" || process.arch !== "x64" || !fs.existsSync("/usr/bin/arch")) return [chrome, args];
  const arm = spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" });
  return arm.stdout?.trim() === "1" ? ["/usr/bin/arch", ["-arm64", chrome, ...args]] : [chrome, args];
}

// ------------------------------------------------------------------------------------------------ test data
function makeCtx(bin, tmp) {
  const env = { ...process.env, REQFORGE_CLI: bin, REQFORGE_BIN: bin, PYTHONDONTWRITEBYTECODE: "1" };
  delete env.REQFORGE_TOKEN;
  const seed = (script, ...args) => run(PYTHON, [path.join(ROOT, "examples", script), ...args], { env });
  return {
    bin, tmp, env,
    seedLarge: (dir) => { seed("seed_large.py", dir, "3000"); return dir },
    seedDemo: (dir, ...flags) => { seed("seed_demo.py", dir, ...flags); return dir },
    importProject: (ws, dir, key) => run(bin, ["--workspace", ws, "project", "import", dir, ...(key ? ["--key", key] : [])], { env }),
    /** `reqforge --repo <dir> <args…>` (add/edit records before serving) */
    cli: (dir, ...args) => run(bin, ["--repo", dir, ...args], { env }),
    git: (dir, ...args) => run("git", ["-C", dir, ...args], { env }),
  };
}

// Task-flow data on top of the SHOP demo (examples/seed_demo.py: REQ-0001..4, EPIC-0001, STORY-0001 with component
// `web` = the git repo <dir>-code, TASK-0001..4 todo): dependencies, a second epic/story, and task descriptions that
// steer web/e2e/fake-claude.py in coding-agent mode ("SLOW" runs until cancelled, "QWAIT" takes 6 s).
function seedTasks(ctx, dir, { deps = {}, edits = {}, extra = true } = {}) {
  ctx.seedDemo(dir);
  for (const [t, d] of Object.entries(deps)) ctx.cli(dir, "edit", t, "-s", `depends_on=${d}`);
  for (const [id, sets] of Object.entries(edits)) ctx.cli(dir, "edit", id, ...sets.flatMap((x) => ["-s", x]));
  if (extra) {
    // EPIC-0002 (blocked) > STORY-0002 (done, no component) > TASK-0005 (todo)
    ctx.cli(dir, "add", "epics", "-s", "title=Parked epic", "-s", "status=blocked", "-s", "requirements=REQ-0001");
    ctx.cli(dir, "add", "stories", "-s", "title=Finished story", "-s", "epic=EPIC-0002", "-s", "status=done", "-s", "requirements=REQ-0001", "-s", "deliverable=code");
    ctx.cli(dir, "add", "tasks", "-s", "title=Follow-up without a component", "-s", "story=STORY-0002", "-s", "kind=code");
  }
  return dir;
}

// Design documents (design/<slug>.md, REQ-0054) for the SHOP demo. Slug order differs from title order; checkout-flow
// has a table, a code block and story/task ids in its body.
// reqforge:off (fixture ids from the seeded demo data)
function writeDesignDocs(repo) {
  const d = path.join(repo, "design");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "checkout-flow.md"), [
    "---", "title: Checkout flow", "realises: [REQ-0001, REQ-0003]", "---",
    "## Placing an order", "",
    "STORY-0001 delivers the guest flow; TASK-0001 builds it. Card data stays out of scope (see REQ-0002).", "",
    "- the cart is validated", "- the PSP authorises the card", "",
    "| step | budget |", "| --- | --- |", "| validate | 50 ms |", "| authorise | 600 ms |", "",
    "```python", "order = place_order(cart)  # REQ-0001 in code is not a link", "```", ""].join("\n"));
  fs.writeFileSync(path.join(d, "card-security.md"), [
    "---", "title: Card data security", "realises: [REQ-0002]", "---",
    "Card numbers only ever enter the PSP-hosted fields.", ""].join("\n"));
  fs.writeFileSync(path.join(d, "a-overview.md"), [
    "---", "title: Zeta overview", "realises: [REQ-0001]", "---",
    "How the shop fits together.", ""].join("\n"));
}
// reqforge:on

// Code and tests tagged with decision ids (REQ-0061) in the SHOP demo's code component `web` (<repo>-code): scanned,
// then a JUnit run in which the first decision's test passes and the second one's fails. The third and fourth
// decisions have no tags. The decisions themselves are created by the suite, through a changeset.
// reqforge:off (fixture ids: the decisions the e2e suite creates, not reqforge's own decisions)
function writeDecisionCode(ctx, repo) {
  const code = repo + "-code";
  const files = {
    "shop/orders.py": ["# reqforge: implements DEC-0001", "def save_order(order):", "    return db.insert(\"orders\", order)", "",
      "# reqforge: implements DEC-0002", "def retry_charge(token):", "    return backoff(lambda: PSP.charge(token))", ""],
    "tests/test_decisions.py": ["# reqforge: verifies DEC-0001", "def test_orders_are_persisted():", "    assert save_order(order()).id", "",
      "# reqforge: verifies DEC-0002", "def test_charge_retries_with_backoff():", "    assert retry_charge(\"tok_flaky\").ok", ""],
  };
  for (const [rel, lines] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(code, rel)), { recursive: true });
    fs.writeFileSync(path.join(code, rel), lines.join("\n"));
  }
  ctx.git(code, "add", ...Object.keys(files));
  ctx.git(code, "-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-qm", "e2e: code relying on decisions");
  ctx.cli(repo, "scan");
  const junit = path.join(path.dirname(repo), "junit-decisions.xml");
  const tc = (name, fail) => `<testcase classname="tests.test_decisions" name="${name}" file="tests/test_decisions.py">${fail ? '<failure message="no retry">assert False</failure>' : ""}</testcase>`;
  fs.writeFileSync(junit, `<?xml version="1.0"?><testsuites><testsuite name="pytest">${tc("test_orders_are_persisted", false)}${tc("test_charge_retries_with_backoff", true)}</testsuite></testsuites>`);
  ctx.cli(repo, "evidence", "ingest", junit, "-c", "web");
}
// reqforge:on

// Each suite: build its data under `dir`, return how to serve it and where the result session lands.
const SUITES = {
  core: {
    timeout: 180,
    setup(ctx, dir) {
      const big = ctx.seedLarge(path.join(dir, "big"));
      return { serve: ["--repo", big], sessionsDir: path.join(big, "sessions"), sessionsUrl: "/api/sessions", route: "/" };
    },
  },
  projects: {
    timeout: 300,
    setup(ctx, dir) {
      const ws = path.join(dir, "ws");
      fs.mkdirSync(ws);
      ctx.seedDemo(path.join(ws, "shop"), "--no-code");
      ctx.seedLarge(path.join(ws, "big"));
      ctx.importProject(ws, path.join(ws, "shop")); // first import becomes the default project
      ctx.importProject(ws, path.join(ws, "big"));
      return { serve: ["--workspace", ws], sessionsDir: path.join(ws, "shop", "sessions"), sessionsUrl: "/api/p/SHOP/sessions", route: "/",
        workspaceName: "ws",
        // checks only the harness can make (the browser cannot see the disk)
        after: () => [{ name: "[REQ-0033#AC3] deleted project's directory removed from disk", ok: !fs.existsSync(path.join(ws, "test")), detail: `${path.join(ws, "test")} still exists` }] };
    },
  },
  code: {
    timeout: 300,
    setup(ctx, dir) {
      const ws = path.join(dir, "ws");
      fs.mkdirSync(ws);
      ctx.seedDemo(path.join(ws, "shop")); // also creates ws/shop-code, the tagged component `web`
      // a code change after the last scan: impact analysis must map it to the demo checkout requirement and its tests
      fs.appendFileSync(path.join(ws, "shop-code", "shop", "checkout.py"), "\n# touched by web/e2e/run.mjs\n");
      ctx.seedLarge(path.join(ws, "big"));
      ctx.importProject(ws, path.join(ws, "shop"));
      ctx.importProject(ws, path.join(ws, "big"));
      return { serve: ["--workspace", ws], sessionsDir: path.join(ws, "shop", "sessions"), sessionsUrl: "/api/p/SHOP/sessions", route: "/#/p/SHOP",
        workspaceName: "ws" };
    },
  },
  // Start button (REQ-0050): single repository, SHOP demo + task dependencies
  "task-start": {
    timeout: 180,
    setup(ctx, dir) {
      const shop = seedTasks(ctx, path.join(dir, "shop"), { deps: { "TASK-0002": "TASK-0001" }, edits: { "TASK-0004": ["status=done"] } });
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        after: () => {
          // AC2/AC3: one commit moved the task, its story and its epic
          const log = ctx.git(shop, "log", "--format=%H%x09%s").split("\n").map((l) => l.split("\t"));
          const c = log.find(([, msg]) => /^TASK-0001: start/.test(msg || ""));
          const files = c ? ctx.git(shop, "show", "--name-only", "--format=", c[0]).trim().split("\n").sort() : [];
          const want = ["epics/EPIC-0001", "stories/STORY-0001", "tasks/TASK-0001"];
          return [{ name: "[REQ-0050#AC2] [REQ-0050#AC3] Start was one git commit touching the task, its story and its epic",
            ok: !!c && files.length === 3 && want.every((w) => files.some((f) => f.startsWith(w))), detail: `${c ? c[1] : "no 'TASK-0001: start' commit"}: ${files.join(", ")}` }];
        } };
    },
  },
  // Start with agent (REQ-0051): SHOP demo with its git component; fake-claude.py acts as the coding agent
  "agent-start": {
    timeout: 240,
    setup(ctx, dir) {
      const shop = seedTasks(ctx, path.join(dir, "shop"), { deps: { "TASK-0002": "TASK-0001" },
        edits: { "TASK-0003": ["description=SLOW: a long-running agent task (cancelled by the suite)"],
                 "TASK-0004": ["description=SLOW: a run started outside the drawer"] } });
      const worktrees = path.join(dir, "worktrees");
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        env: { REQFORGE_WORKTREES: worktrees },
        after: () => {
          const code = shop + "-code";
          const branch = ctx.git(code, "branch", "--list", "reqforge/TASK-0001").trim();
          const msgs = branch ? ctx.git(code, "log", "--format=%s", "main..reqforge/TASK-0001") : "";
          return [{ name: "[REQ-0051#AC4] agent commit is on branch reqforge/TASK-0001 in a worktree under REQFORGE_WORKTREES",
            ok: /TASK-0001: add agent-task-0001\.txt/.test(msgs) && fs.existsSync(path.join(worktrees, "SHOP", "TASK-0001", "agent-task-0001.txt")),
            detail: `branch: ${branch || "missing"}; commits: ${msgs.trim()}` }];
        } };
    },
  },
  // Review & Complete (REQ-0056) and the parallel-task warning (REQ-0051#AC7): SHOP demo with its git component; the
  // fake agent commits agent-task-0001.txt on reqforge/TASK-0001. TASK-0002/0004 done, so completing TASK-0001 (after
  // the suite sets TASK-0003 done) finishes STORY-0001 and EPIC-0001. STORY-0001's evals: E1 passes only in the task
  // worktree; E6 always fails with 61 lines of output (the suite drops it to let Complete through).
  "task-complete": {
    timeout: 300,
    setup(ctx, dir) {
      const shop = seedTasks(ctx, path.join(dir, "shop"), { edits: { "TASK-0002": ["status=done"], "TASK-0004": ["status=done"] } });
      const story = JSON.parse(ctx.cli(shop, "show", "STORY-0001"));
      const evals = story.evals.map((e) => (e.id === "E1" ? { ...e, command: "test -f agent-task-0001.txt && echo agent file present" } : e));
      evals.push({ id: "E6", name: "release gate", kind: "smoke",
        command: "sleep 2; for i in $(seq 1 60); do echo \"gate line $i\"; done; echo 'E2E-GATE: the release gate is closed'; exit 3" });
      ctx.cli(shop, "edit", "STORY-0001", "--data", JSON.stringify({ evals }));
      // the demo leaves shop/psp.py modified in the checkout (for impact analysis); Complete refuses a dirty checkout
      ctx.git(shop + "-code", "-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-qam", "e2e: commit the demo's pending change");
      const worktrees = path.join(dir, "worktrees");
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        env: { REQFORGE_WORKTREES: worktrees },
        after: () => {
          const code = shop + "-code";
          const head = ctx.git(code, "rev-parse", "--abbrev-ref", "HEAD").trim();
          const [parents, subject] = ctx.git(code, "log", "-1", "--format=%P%x09%s", "main").trim().split("\t");
          const landed = ctx.git(code, "ls-tree", "--name-only", "main").split("\n").includes("agent-task-0001.txt");
          const branch = ctx.git(code, "branch", "--list", "reqforge/TASK-0001").trim();
          const wt = path.join(worktrees, "SHOP", "TASK-0001");
          return [
            { name: "[REQ-0056#AC5] the --no-ff merge commit of TASK-0001 is on the checkout's main",
              ok: head === "main" && /^TASK-0001: complete/.test(subject || "") && (parents || "").split(" ").length === 2 && landed,
              detail: `HEAD ${head}; main: ${subject} (parents: ${parents}); agent-task-0001.txt on main: ${landed}` },
            { name: "[REQ-0056#AC5] branch reqforge/TASK-0001 and its worktree are removed",
              ok: !branch && !fs.existsSync(wt), detail: `branch: ${branch || "gone"}; worktree exists: ${fs.existsSync(wt)}` },
          ];
        } };
    },
  },
  // Agent queue (REQ-0053): every SHOP requirement approved, so STORY-0001's tasks are eligible; runs take 6 s
  "agent-queue": {
    timeout: 240,
    setup(ctx, dir) {
      const shop = seedTasks(ctx, path.join(dir, "shop"), { deps: { "TASK-0002": "TASK-0001" },
        edits: { "REQ-0004": ["status=approved"], ...Object.fromEntries(["TASK-0001", "TASK-0003", "TASK-0004"].map((t) => [t, ["description=QWAIT: queued agent run"]])) } });
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        env: { REQFORGE_WORKTREES: path.join(dir, "worktrees"), REQFORGE_QUEUE_TICK_MS: "500" } };
    },
  },
  // Design tab (REQ-0055): SHOP demo with three design documents, BARE (same demo data) with none
  design: {
    timeout: 180,
    setup(ctx, dir) {
      const ws = path.join(dir, "ws");
      fs.mkdirSync(ws);
      const shop = ctx.seedDemo(path.join(ws, "shop"), "--no-code");
      writeDesignDocs(shop);
      ctx.seedDemo(path.join(ws, "bare"), "--no-code");
      ctx.importProject(ws, shop);
      ctx.importProject(ws, path.join(ws, "bare"), "BARE");
      return { serve: ["--workspace", ws], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/p/SHOP/sessions", route: "/#/p/SHOP",
        workspaceName: "ws" };
    },
  },
  // Next action per task (REQ-0059): SHOP demo with its git component. TASK-0001 has a next action; the fake agent
  // ends its final message with a NEXT: line for TASK-0001/0003/0004 ("PROPOSE-NEXT"); the chat applies a changeset
  // ("NEXT-DEMO") so closing the panel / New asks for the wrap-up.
  "next-action": {
    timeout: 300,
    setup(ctx, dir) {
      const desc = "description=PROPOSE-NEXT: implement the checkout step";
      const shop = seedTasks(ctx, path.join(dir, "shop"), { extra: false, edits: {
        "TASK-0001": [desc, "next_action=Open shop/checkout.py and read place_order", "next_action_set=2026-10-01"],
        "TASK-0003": [desc], "TASK-0004": [desc] } });
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        env: { REQFORGE_WORKTREES: path.join(dir, "worktrees") } };
    },
  },
  // Project snapshot (REQ-0057/REQ-0058): SHOP demo without state/HOT.md; fake-claude.py drafts one as a changeset
  snapshot: {
    timeout: 180,
    setup(ctx, dir) {
      const shop = ctx.seedDemo(path.join(dir, "shop"), "--no-code");
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        after: () => {
          // AC2: the file on disk is the applied content, and the only commit that wrote it is the apply commit
          const log = ctx.git(shop, "log", "--format=%s", "--", "state/HOT.md").trim().split("\n").filter(Boolean);
          const file = path.join(shop, "state", "HOT.md");
          const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          return [{ name: "[REQ-0057#AC2] Apply committed state/HOT.md and 0 other commits wrote it",
            ok: log.length === 1 && /^CS-\d+: apply — Draft project snapshot$/.test(log[0]) && /^## Next$/m.test(text) && /- Ship guest checkout/.test(text),
            detail: `commits touching state/HOT.md: ${JSON.stringify(log)}; file: ${text.slice(0, 120)}` }];
        } };
    },
  },
  // Session history gaps (REQ-0062#AC4): SHOP demo whose history holds one chat session that ended 30 days ago, so
  // the next session start shows an unexplained gap; the suite pauses the project, then records the (now deliberate)
  // gap with a reason.
  history: {
    timeout: 180,
    setup(ctx, dir) {
      const shop = ctx.seedDemo(path.join(dir, "shop"), "--no-code");
      const at = (days) => new Date(Date.now() - days * 86400e3).toISOString().replace(/\.\d+Z$/, "+00:00");
      const entry = { type: "entry", kind: "chat", id: "e2e-old-session", project: "SHOP", user: "e2e", start: at(30.1), end: at(30),
        outcome: "discussed", changesets_proposed: [], changesets_applied: [], records_touched: [] };
      fs.mkdirSync(path.join(shop, "history"), { recursive: true });
      fs.writeFileSync(path.join(shop, "history", "sessions.jsonl"), JSON.stringify(entry) + "\n");
      ctx.git(shop, "add", "history");
      ctx.git(shop, "-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-qm", "e2e: a chat session 30 days ago");
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/",
        after: () => {
          const lines = fs.readFileSync(path.join(shop, "history", "sessions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
          const pauses = lines.filter((l) => l.type === "pause"), gaps = lines.filter((l) => l.type === "gap");
          const g = gaps[0] || {};
          return [
            { name: "[REQ-0062#AC4] the pause and its reason are in history/sessions.jsonl",
              ok: pauses.length === 1 && pauses[0].reason === "E2E: waiting for the security review", detail: JSON.stringify(pauses) },
            { name: "[REQ-0062#AC4] one gap recorded: deliberate, 30 days, with the pause reason and the user's reason",
              ok: gaps.length === 1 && g.gap === "deliberate" && g.days === 30 && g.pause_reason === "E2E: waiting for the security review"
                && g.reason === "E2E: the review took a month",
              detail: JSON.stringify(gaps) },
          ];
        } };
    },
  },
  // Decisions tab (REQ-0061#AC4): SHOP demo with its code component and decision-tagged code (writeDecisionCode)
  decisions: {
    timeout: 180,
    setup(ctx, dir) {
      const shop = ctx.seedDemo(path.join(dir, "shop"));
      writeDecisionCode(ctx, shop);
      return { serve: ["--repo", shop], sessionsDir: path.join(shop, "sessions"), sessionsUrl: "/api/sessions", route: "/" };
    },
  },
  // help panel, its keyboard behaviour, and colour schemes: same BIG repository as core
  help: { timeout: 180, setup: (ctx, dir) => SUITES.core.setup(ctx, dir) },
  "help-a11y": { timeout: 180, setup: (ctx, dir) => SUITES.core.setup(ctx, dir) },
  theme: { timeout: 240, setup: (ctx, dir) => SUITES.core.setup(ctx, dir) },
};

function injectedDist(name, dir, cfg) {
  const dist = path.join(dir, "dist");
  fs.cpSync(path.join(WEB, "dist"), dist, { recursive: true });
  const index = path.join(dist, "index.html");
  const html = fs.readFileSync(index, "utf8");
  if (!html.includes("</body>")) throw new Error("web/dist/index.html has no </body>");
  const code = [
    `window.__E2E = ${JSON.stringify(cfg)};`,
    "(async () => {",
    fs.readFileSync(path.join(HERE, "lib", "prelude.js"), "utf8"),
    fs.readFileSync(path.join(HERE, "suites", `${name}.js`), "utf8"),
    "await runSuite(suite);",
    "})();",
  ].join("\n").replace(/<\/script/gi, "<\\/script");
  // a replacer function: a replacement string would expand `$$`, `$&`, … in the injected code
  fs.writeFileSync(index, html.replace("</body>", () => `<script>\n${code}\n</script>\n</body>`));
  return dist;
}

// ------------------------------------------------------------------------------------------------ Chrome DevTools
// Attach to the page to collect uncaught exceptions/console errors, and to read a partial log on timeout.
// Also exposes `window.__e2eCdp(json)` to suites: a bridge for Emulation.* and Input.* commands (colour-scheme
// emulation, trusted key presses) that calls `window.__e2eCdpDone(id)` when done; see `cdp()` in lib/prelude.js.
async function cdpAttach(userDataDir, chrome, deadline) {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port;
  while (!port && Date.now() < deadline && chrome.exitCode === null) {
    try { port = +fs.readFileSync(portFile, "utf8").split("\n")[0] } catch {}
    if (!port) await sleep(100);
  }
  if (!port) return null;
  let page;
  while (!page && Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page") } catch {}
    if (!page) await sleep(150);
  }
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }) });
  const pending = new Map(), diagnostics = [];
  let id = 0;
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      diagnostics.push(`exception: ${d.exception?.description || d.text}`.split("\n")[0]);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      diagnostics.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 500));
    } else if (m.method === "Runtime.bindingCalled" && m.params.name === "__e2eCdp") {
      try {
        const c = JSON.parse(m.params.payload);
        if (/^(Emulation|Input)\./.test(c.method))
          send(c.method, c.params || {}).then(() => send("Runtime.evaluate", { expression: `window.__e2eCdpDone?.(${+c.id || 0})` }));
      } catch {}
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      diagnostics.push(`log: ${m.params.entry.text} ${m.params.entry.url || ""}`.trim().slice(0, 500));
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) return resolve({});
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.delete(i)) resolve({}) }, 5000);
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Runtime.addBinding", { name: "__e2eCdp" });
  return {
    diagnostics,
    evaluate: async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value,
    close: () => { try { ws.close() } catch {} },
  };
}

// ------------------------------------------------------------------------------------------------ one suite
function parseLog(text) {
  const checks = [], jsErrors = [];
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^PASS (.*)$/))) checks.push({ name: m[1].trim(), ok: true });
    else if ((m = line.match(/^FAIL (.*?)(?: :: (.*))?$/))) checks.push({ name: m[1].trim(), ok: false, detail: m[2] || "" });
    else if ((m = line.match(/^EXC (.*)$/))) checks.push({ name: "suite script ran to completion", ok: false, detail: m[1] });
    else if ((m = line.match(/^JSERROR (.*)$/))) jsErrors.push(m[1]);
  }
  if (jsErrors.length) checks.push({ name: "no uncaught errors in the page", ok: false, detail: jsErrors.join(" | ") });
  return checks;
}

async function runSuite(name, ctx, opts) {
  const spec = SUITES[name];
  const timeoutS = opts.timeout ?? spec.timeout;
  const dir = path.join(ctx.tmp, name);
  fs.mkdirSync(dir);
  const t0 = Date.now();
  const res = { name, checks: [], diagnostics: [], seconds: 0, timedOut: false, logs: dir };
  let server, chrome, cdp;
  try {
    const s = spec.setup(ctx, dir);
    const dist = injectedDist(name, dir, { suite: name, sessionsUrl: s.sessionsUrl, workspaceName: s.workspaceName || "" });
    const fakeClaude = path.join(dir, "fake-claude");
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nexec "${PYTHON}" "${path.join(HERE, "fake-claude.py")}" "$@"\n`, { mode: 0o755 });

    const port = await freePort();
    const serverLog = path.join(dir, "server.log");
    server = start(ctx.bin, [...s.serve, "serve", "--port", String(port)], serverLog,
      { ...ctx.env, REQFORGE_UI_DIR: dist, REQFORGE_CLAUDE_BIN: fakeClaude, ...(s.env || {}) });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (const until = Date.now() + 20000; !up && Date.now() < until && server.exitCode === null;) {
      try { up = (await fetch(base + "/")).ok } catch { await sleep(150) }
    }
    if (!up) throw new Error(`server did not start on ${base}\n${tail(serverLog)}`);

    const profile = path.join(dir, "chrome-profile");
    const chromeArgs = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1500,950",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync",
      "--disable-features=Translate,MediaRouter", "--password-store=basic", "--use-mock-keychain"];
    if (process.platform === "linux") chromeArgs.push("--disable-dev-shm-usage", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []));
    chrome = start(...chromeCommand(ctx.chrome, [...chromeArgs, base + s.route]), path.join(dir, "chrome.log"), process.env);

    const deadline = Date.now() + timeoutS * 1000;
    cdp = await cdpAttach(profile, chrome, Math.min(deadline, Date.now() + 30000)).catch(() => null);
    let resultFile = null;
    while (!resultFile && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode})\n${tail(serverLog)}`);
      if (chrome.exitCode !== null) throw new Error(`Chrome exited (${chrome.exitCode})\n${tail(path.join(dir, "chrome.log"))}`);
      const syntax = cdp?.diagnostics.find((d) => /SyntaxError/.test(d));
      if (syntax) throw new Error(`injected test script failed to parse: ${syntax}`);
      const f = fs.existsSync(s.sessionsDir) && fs.readdirSync(s.sessionsDir).find((n) => /^ELI-.*\.md$/.test(n));
      if (f) resultFile = path.join(s.sessionsDir, f);
      else await sleep(500);
    }
    if (resultFile) {
      await sleep(200);
      res.checks = parseLog(fs.readFileSync(resultFile, "utf8"));
      if (s.after) res.checks.push(...s.after());
    } else {
      res.timedOut = true;
      const partial = cdp ? await cdp.evaluate(`sessionStorage.getItem("e2e.log")`).catch(() => null) : null;
      res.checks = parseLog(partial ? JSON.parse(partial).join("\n") : "");
      res.checks.push({ name: `suite finished within ${timeoutS}s`, ok: false, detail: `no result session in ${s.sessionsDir} (partial log: ${res.checks.length} checks)` });
    }
  } catch (e) {
    res.checks.push({ name: "suite harness", ok: false, detail: e.message });
  } finally {
    if (cdp) { res.diagnostics = cdp.diagnostics.slice(0, 200); cdp.close() }
    await stop(chrome);
    await stop(server);
  }
  res.seconds = (Date.now() - t0) / 1000;
  return res;
}

// ------------------------------------------------------------------------------------------------ reporting
const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function junit(results) {
  const all = results.flatMap((r) => r.checks);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="reqforge-e2e" tests="${all.length}" failures="${all.filter((c) => !c.ok).length}" errors="0" time="${results.reduce((a, r) => a + r.seconds, 0).toFixed(1)}">`];
  for (const r of results) {
    const fails = r.checks.filter((c) => !c.ok).length;
    out.push(`  <testsuite name="${r.name}" tests="${r.checks.length}" failures="${fails}" errors="0" skipped="0" time="${r.seconds.toFixed(1)}" timestamp="${new Date().toISOString().slice(0, 19)}">`);
    for (const c of r.checks) {
      const open = `    <testcase classname="e2e.${r.name}" name="${xmlEsc(c.name)}" time="0"`;
      if (c.ok) out.push(open + "/>");
      else out.push(open + ">", `      <failure message="${xmlEsc(c.detail || "check failed")}" type="AssertionError">${xmlEsc(c.detail || "")}</failure>`, "    </testcase>");
    }
    if (r.diagnostics.length) out.push(`    <system-out>${xmlEsc(r.diagnostics.join("\n"))}</system-out>`);
    out.push("  </testsuite>");
  }
  out.push("</testsuites>", "");
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (+process.versions.node.split(".")[0] < 22) die(`Node >= 22 required (have ${process.version})`);
  const bin = findBinary();
  ensureDist();
  const chrome = findChrome();
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reqforge-e2e-"));
  const ctx = { ...makeCtx(bin, tmp), chrome };
  console.log(`e2e: binary ${shortPath(bin)}\ne2e: chrome ${chrome}\ne2e: data   ${tmp}`);

  const results = [];
  for (const name of opts.suites) {
    process.stdout.write(`\n== ${name} `);
    const r = await runSuite(name, ctx, opts);
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok);
    console.log(`${r.checks.length - failed.length}/${r.checks.length} passed in ${r.seconds.toFixed(1)}s${r.timedOut ? " (TIMED OUT)" : ""}`);
    for (const c of failed) console.log(`   FAIL ${c.name}${c.detail ? "\n        " + c.detail.split("\n").join("\n        ") : ""}`);
    if (failed.length && r.diagnostics.length) console.log(`   page diagnostics:\n     ${r.diagnostics.slice(0, 10).join("\n     ")}`);
  }

  const total = results.reduce((a, r) => a + r.checks.length, 0);
  const failures = results.reduce((a, r) => a + r.checks.filter((c) => !c.ok).length, 0);
  console.log(`\n${failures ? "FAILED" : "PASSED"}: ${total - failures}/${total} checks (${results.map((r) => `${r.name} ${r.checks.filter((c) => c.ok).length}/${r.checks.length}`).join(", ")})`);
  if (opts.junit) {
    const file = path.resolve(opts.junit);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, junit(results));
    console.log(`JUnit: ${shortPath(file)}`);
  }
  if (opts.keep) console.log(`kept: ${tmp} (server.log, chrome.log and data per suite)`);
  else if (failures) console.log("(re-run with --keep to inspect server.log, chrome.log and the data of each suite)");
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e.stack || e.message); killAll(); process.exit(2) });
