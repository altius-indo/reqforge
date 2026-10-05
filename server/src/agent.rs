//! Agent runs: start a task with a sandboxed Claude Code coding agent (docs/agent-runs.md).
//!
//! The agent works in a git worktree of the story's component on branch `reqforge/TASK-NNNN`,
//! briefed with the task, story and requirements. It can edit only inside the worktree, cannot
//! push or switch branches, and has no reqforge write tools. The server checks the default
//! branch, the component checkout and the requirements repo before and after the run, and
//! records every run in `agent-runs/` of the requirements repo. A task is never marked done
//! automatically.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

use crate::chat::{claude_bin, plugin_root, translate, MCP};
use crate::codetrace::{component_by_key, component_root};
use crate::model::{objs, s, strs, Kind, Rec};
use crate::store::{dump, now, Res, Store, StoreError};

pub const CODING_PROMPT: &str = include_str!("agent_prompt.md");

const READ_TOOLS: &[&str] = &[
    "taxonomy", "search", "get", "context", "verification", "eval_registry", "lint", "trace", "impact", "list_projects", "get_changeset", "list_changesets",
];
const WRITE_TOOLS: &[&str] = &[
    "create", "update", "delete", "bulk_update", "upsert_many", "propose_changeset", "apply_changeset", "reject_changeset",
    "simulate_changeset", "config", "sync", "init_repo", "scan_code", "ingest_evidence", "create_project", "save_session",
];
const BASH_ALLOWED: &[&str] = &[
    "cargo", "npm", "npx", "node", "python3", "pytest", "go", "make", "git status", "git diff", "git log", "git show", "git add", "git commit",
    // file moves inside the worktree
    "git rm", "git mv", "mkdir", "ls", "chmod +x",
    // read-only reqforge commands; never plain bin/reqforge, whose edit/bulk/import would write records
    "bin/reqforge lint", "bin/reqforge trace", "bin/reqforge verify", "bin/reqforge show", "bin/reqforge list",
    "./bin/reqforge lint", "./bin/reqforge trace", "./bin/reqforge verify", "./bin/reqforge show", "./bin/reqforge list",
];
const BASH_DENIED: &[&str] = &[
    "git push", "git checkout", "git switch", "git reset", "git rebase", "git merge", "git worktree", "rm -rf", "curl", "wget",
];

/// Tools the coding agent may use.
// reqforge: implements REQ-0052
pub fn allowed_tools() -> Vec<String> {
    ["Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "TodoWrite"]
        .iter()
        .map(|t| t.to_string())
        .chain(BASH_ALLOWED.iter().map(|c| format!("Bash({c}:*)")))
        .chain(READ_TOOLS.iter().map(|t| format!("{MCP}{t}")))
        .collect()
}

/// Tools the coding agent must never use.
pub fn denied_tools() -> Vec<String> {
    WRITE_TOOLS
        .iter()
        .map(|t| format!("{MCP}{t}"))
        .chain(BASH_DENIED.iter().map(|c| format!("Bash({c}:*)")))
        .chain(["WebFetch", "WebSearch", "NotebookEdit"].map(String::from))
        .collect()
}

pub fn branch_for(task: &str) -> String {
    format!("reqforge/{task}")
}

pub fn worktrees_root() -> PathBuf {
    std::env::var_os("REQFORGE_WORKTREES")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join(".reqforge/worktrees"))
}

/// The task section of a brief or a task-focused chat: title, next action (if any), kind,
/// what to do and done when.
pub fn task_section(t: &Rec) -> String {
    let mut out = vec![format!("# Task {}: {}", s(t, "id"), s(t, "title")), String::new()];
    if let Some(n) = crate::taskflow::next_action_block(t) {
        out.extend([n, String::new()]);
    }
    out.extend([
        format!("Kind: {}", s(t, "kind")),
        String::new(),
        format!("## What to do\n{}", if s(t, "description").is_empty() { "(no description)" } else { s(t, "description") }),
        String::new(),
        format!("## Done when\n{}", if s(t, "done_when").is_empty() { "(not specified)" } else { s(t, "done_when") }),
    ]);
    out.join("\n")
}

/// The brief handed to the agent (REQ-0051#AC3): the task section, then the project snapshot
/// (REQ-0058#AC2), then story, evals, requirements and conventions.
// reqforge: implements REQ-0051
// reqforge: implements REQ-0058
pub fn brief(store: &Store, task_id: &str) -> Res<String> {
    let t = store.get(Kind::Tasks, task_id)?;
    let st = store.get(Kind::Stories, s(&t, "story"))?;
    let snap = match crate::snapshot::read(&store.root) {
        Some(c) => crate::snapshot::context_block(&c),
        None => format!("(none: this project has no {} yet)", crate::snapshot::PATH),
    };
    let mut out = vec![
        task_section(&t),
        String::new(),
        format!("## Project snapshot\n{snap}"),
        String::new(),
        format!("## Story {}: {}", s(&st, "id"), s(&st, "title")),
        s(&st, "narrative").to_string(),
    ];
    for ac in objs(&st, "acceptance_criteria") {
        out.push(format!("- story {}: {}", s(ac, "id"), s(ac, "text")));
    }
    let evals: Vec<String> = objs(&st, "evals").iter().map(|e| format!("- {} ({}): `{}` covers {}", s(e, "id"), s(e, "kind"), s(e, "command"), strs(e, "covers").join(", "))).collect();
    if !evals.is_empty() {
        out.push(String::new());
        out.push("## Evals that must pass".into());
        out.extend(evals);
    }
    out.push(String::new());
    out.push("## Requirements".into());
    for rid in strs(&st, "requirements") {
        if let Ok(r) = store.get(Kind::Requirements, rid) {
            out.push(format!("### {rid}: {}\n{}", s(&r, "title"), s(&r, "statement")));
            for ac in objs(&r, "acceptance_criteria") {
                out.push(format!("- {rid}#{}: {}", s(ac, "id"), s(ac, "text")));
            }
        }
    }
    out.push(String::new());
    // reqforge:off  (the convention text below is part of the brief, not a tag)
    out.push(
        "## Conventions\n- Tag implementation entry points with a comment `reqforge: implements REQ-XXXX` and every test with `reqforge: verifies REQ-XXXX#ACn` (one per line, above the function).\n\
         - Work only in this directory, on the current branch. Commit with clear messages. Do not push, switch branches or edit anything outside this worktree.\n\
         - Run the evals listed above (or the narrowest tests that cover your change) before finishing, and report what passed."
            .into(),
    );
    // reqforge:on
    Ok(out.join("\n"))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).trim().to_string())
    }
}

pub struct Plan {
    pub task: String,
    pub story: String,
    pub component: String,
    pub component_root: PathBuf,
    pub branch: String,
    pub worktree: PathBuf,
    pub brief: String,
}

/// Readiness + plan for the confirmation dialog (REQ-0051#AC1, AC6).
pub fn plan(store: &Store, task_id: &str) -> Res<Value> {
    let rd = crate::taskflow::readiness(store, task_id)?;
    let mut v = json!({"task": task_id, "ready": rd["can_start_agent"], "reasons": rd["agent_reasons"], "component": rd["component"],
                       "branch": branch_for(task_id), "unfinished": rd["unfinished"]});
    v["parallel"] = json!(crate::complete::parallel_branches(store, task_id));
    if let Ok(p) = resolve(store, task_id) {
        v["component_path"] = json!(p.component_root.display().to_string());
        v["worktree"] = json!(p.worktree.display().to_string());
        v["brief"] = json!(p.brief);
    }
    Ok(v)
}

pub fn resolve(store: &Store, task_id: &str) -> Res<Plan> {
    let t = store.get(Kind::Tasks, task_id)?;
    let st = store.get(Kind::Stories, s(&t, "story"))?;
    let key = s(&st, "component").to_string();
    let comp = component_by_key(store, &key).ok_or_else(|| StoreError::bad(format!("story {} has no defined component", s(&st, "id"))))?;
    let root = component_root(store, &comp).ok_or_else(|| StoreError::bad(format!("component '{key}' has no local path")))?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let project = store.config_value()["key"].as_str().unwrap_or("PROJECT").to_string();
    Ok(Plan {
        task: task_id.into(),
        story: s(&st, "id").into(),
        component: key,
        component_root: root,
        branch: branch_for(task_id),
        worktree: worktrees_root().join(project).join(task_id),
        brief: brief(store, task_id)?,
    })
}

/// Create (or reuse) the task worktree on its branch; returns the base commit.
// reqforge: implements REQ-0051
pub fn prepare_worktree(p: &Plan) -> Res<String> {
    let top = git(&p.component_root, &["rev-parse", "--show-toplevel"]).map_err(|e| StoreError::bad(format!("component '{}' is not a git checkout: {e}", p.component)))?;
    let top = PathBuf::from(top);
    let base = git(&top, &["rev-parse", "HEAD"]).map_err(StoreError::bad)?;
    if p.worktree.join(".git").exists() {
        let b = git(&p.worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(StoreError::bad)?;
        if b != p.branch {
            return Err(StoreError::bad(format!("{} exists but is on {b}, not {}", p.worktree.display(), p.branch)));
        }
        return Ok(git(&top, &["merge-base", "HEAD", &p.branch]).unwrap_or(base));
    }
    std::fs::create_dir_all(p.worktree.parent().unwrap()).map_err(|e| StoreError::bad(e.to_string()))?;
    let wt = p.worktree.display().to_string();
    let exists = git(&top, &["rev-parse", "--verify", "--quiet", &p.branch]).is_ok();
    let r = if exists { git(&top, &["worktree", "add", &wt, &p.branch]) } else { git(&top, &["worktree", "add", "-b", &p.branch, &wt, &base]) };
    r.map_err(|e| StoreError::bad(format!("git worktree add failed: {e}")))?;
    Ok(if exists { git(&top, &["merge-base", "HEAD", &p.branch]).unwrap_or(base) } else { base })
}

/// What must not change during a run.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub default_head: String,
    pub component_status: String,
    /// uncommitted files in the requirements repository: path -> content hash
    pub requirements_dirty: BTreeMap<String, String>,
    /// foreign changes seen at reqforge's write-lock boundaries since the run began (see `Store::watch_foreign`)
    pub requirements_seen: BTreeSet<(String, String)>,
    /// the component checkout's top level, and the requirements folder inside it (if any)
    pub top: PathBuf,
    pub requirements_rel: Option<String>,
}

/// Snapshot taken under the store's write lock (no reqforge write is half done) that starts
/// watching for foreign changes reqforge's own commits might sweep up; pair with `snapshot_end`.
// reqforge: implements REQ-0052
pub fn snapshot_begin(component_root: &Path, store: &Store) -> (Snapshot, u64) {
    let _g = store.lock();
    (snapshot(component_root, &store.root), store.watch_foreign())
}

pub fn snapshot_end(component_root: &Path, store: &Store, watch: u64) -> Snapshot {
    let _g = store.lock();
    let mut s = snapshot(component_root, &store.root);
    s.requirements_seen = store.unwatch_foreign(watch);
    s
}

// reqforge: implements REQ-0052
pub fn snapshot(component_root: &Path, requirements_root: &Path) -> Snapshot {
    let top = git(component_root, &["rev-parse", "--show-toplevel"]).map(PathBuf::from).unwrap_or_else(|_| component_root.to_path_buf());
    // git reports canonical paths (e.g. /private/var on macOS); compare like with like
    let top = std::fs::canonicalize(&top).unwrap_or(top);
    let canon = std::fs::canonicalize(requirements_root).unwrap_or_else(|_| requirements_root.to_path_buf());
    let requirements_root = canon.as_path();
    // ignore the requirements folder when it lives inside the component checkout: the server writes the run log there
    let rel = requirements_root.strip_prefix(&top).ok().map(|r| format!(":(exclude){}", r.display()));
    let mut args = vec!["status", "--porcelain", "--", "."];
    if let Some(x) = rel.as_deref() {
        args.push(x);
    }
    Snapshot {
        top: top.clone(),
        requirements_rel: requirements_root.strip_prefix(&top).ok().map(|r| r.display().to_string()).filter(|r| !r.is_empty()),
        default_head: git(&top, &["rev-parse", "HEAD"]).unwrap_or_default(),
        component_status: git(&top, &args).unwrap_or_default(),
        requirements_dirty: crate::store::git::dirty(requirements_root),
        requirements_seen: BTreeSet::new(),
    }
}

pub fn violations(before: &Snapshot, after: &Snapshot) -> Vec<String> {
    let mut v = vec![];
    // reqforge's own commits (task start, run logs, evidence) touch only the requirements folder
    // when it lives inside the component checkout: those are not the agent's doing
    let only_requirements = before.default_head != after.default_head
        && before.requirements_rel.as_ref().is_some_and(|rel| {
            git(&before.top, &["diff", "--name-only", &before.default_head, &after.default_head])
                .map(|names| names.lines().all(|f| f.starts_with(&format!("{rel}/"))))
                .unwrap_or(false)
        });
    if before.default_head != after.default_head && !only_requirements {
        v.push(format!("the component's checked-out branch moved from {} to {}", &before.default_head[..before.default_head.len().min(10)], &after.default_head[..after.default_head.len().min(10)]));
    }
    if before.component_status != after.component_status {
        v.push("files changed in the component checkout outside the task worktree".into());
    }
    // what reqforge commits (run logs, history, record updates from other runs or users) is
    // never left uncommitted at a write-lock boundary; any other change is, until something commits it
    let changed: BTreeSet<&str> = after
        .requirements_dirty
        .iter()
        .chain(after.requirements_seen.iter().map(|(p, h)| (p, h)))
        .filter(|(p, h)| before.requirements_dirty.get(*p) != Some(*h))
        .map(|(p, _)| p.as_str())
        .collect();
    if !changed.is_empty() {
        let mut names: Vec<&str> = changed.iter().take(5).copied().collect();
        if changed.len() > 5 {
            names.push("…");
        }
        v.push(format!("files changed in the requirements repository: {}", names.join(", ")));
    }
    v
}

pub fn commits_since(worktree: &Path, base: &str) -> Vec<Value> {
    git(worktree, &["log", "--format=%h%x09%s", &format!("{base}..HEAD")])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(h, msg)| json!({"sha": h, "message": msg}))
        .collect()
}

pub fn runs(store: &Store, task_id: &str) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(store.root.join("agent-runs"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with(&format!("RUN-{task_id}-")) || n.starts_with(&format!("COMPLETE-{task_id}-"))
        })
        .filter_map(|e| serde_json::from_str::<Value>(&std::fs::read_to_string(e.path()).ok()?).ok())
        .map(|mut v| {
            if let Some(o) = v.as_object_mut() {
                o.remove("events");
                o.entry("kind").or_insert(json!("agent"));
            }
            v
        })
        .collect();
    out.sort_by(|a, b| b["started"].as_str().cmp(&a["started"].as_str()));
    out
}

pub struct AgentRunner {
    /// a run still going after this long is stopped and logged as "timeout"
    pub timeout: std::time::Duration,
    /// running (or starting) runs by task id; also the cancel signal
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    /// live progress per task (the last run's events, newest 500) and how many were dropped before them
    live: Mutex<HashMap<String, (usize, Vec<Value>)>>,
    /// tasks a scheduler has committed to start but whose run hasn't taken its slot yet
    pending: Mutex<std::collections::HashSet<String>>,
}

impl Default for AgentRunner {
    fn default() -> Self {
        let mins = std::env::var("REQFORGE_AGENT_TIMEOUT_MIN").ok().and_then(|v| v.parse().ok()).unwrap_or(60u64);
        AgentRunner {
            timeout: std::time::Duration::from_secs(mins * 60),
            cancels: Mutex::new(HashMap::new()),
            live: Mutex::new(HashMap::new()),
            pending: Mutex::new(Default::default()),
        }
    }
}

/// Releases a run's slot however the run ends.
struct Reservation<'a> {
    map: &'a Mutex<HashMap<String, Arc<Notify>>>,
    key: String,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.map.lock().unwrap().remove(&self.key);
    }
}

/// Arguments for the agent's `claude -p`. With `REQFORGE_SNAPSHOT_RESUPPLY=system` the system
/// prompt also carries the task's next action and the snapshot (fallback for the compaction hook).
// reqforge: implements REQ-0058
pub fn command_args(store: &Store, task_id: &str) -> Vec<String> {
    let mut system = CODING_PROMPT.to_string();
    if crate::snapshot::resupply_in_system_prompt() {
        if let Some(c) = crate::snapshot::read(&store.root) {
            if let Some(n) = store.get(Kind::Tasks, task_id).ok().and_then(|t| crate::taskflow::next_action_block(&t)) {
                system.push_str(&format!("\n\n{n}"));
            }
            system.push_str(&format!("\n\n{}", crate::snapshot::context_block(&c)));
        }
    }
    let mut a: Vec<String> = vec![
        "-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into(),
        "--append-system-prompt".into(), system,
        "--permission-mode".into(), "acceptEdits".into(),
        "--allowedTools".into(), allowed_tools().join(","),
        "--disallowedTools".into(), denied_tools().join(","),
    ];
    if let Some(p) = plugin_root() {
        a.extend(["--plugin-dir".into(), p.display().to_string()]);
    }
    if let Ok(m) = std::env::var("REQFORGE_AGENT_MODEL") {
        if !m.is_empty() {
            a.extend(["--model".into(), m]);
        }
    }
    a
}

impl AgentRunner {
    pub fn cancel(&self, task_id: &str) -> bool {
        match self.cancels.lock().unwrap().get(task_id) {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        }
    }

    pub fn running(&self, task_id: &str) -> bool {
        self.cancels.lock().unwrap().contains_key(task_id)
    }

    /// Running, starting and scheduler-reserved tasks.
    pub fn running_tasks(&self) -> Vec<String> {
        let mut v: Vec<String> = self.cancels.lock().unwrap().keys().cloned().collect();
        v.extend(self.pending.lock().unwrap().iter().cloned());
        v.sort();
        v.dedup();
        v
    }

    /// Reserve a slot synchronously (scheduler); the run releases it when it starts.
    pub fn reserve(&self, task_id: &str) -> bool {
        !self.running(task_id) && self.pending.lock().unwrap().insert(task_id.to_string())
    }

    /// Live events of the task's current or last run in this server process.
    /// `total` counts every event of the run, so `since` keeps advancing past the buffer cap.
    pub fn live(&self, task_id: &str, since: usize) -> Value {
        let (dropped, ev) = self.live.lock().unwrap().get(task_id).cloned().unwrap_or_default();
        let skip = since.saturating_sub(dropped);
        json!({"running": self.running(task_id), "total": dropped + ev.len(), "events": ev.into_iter().skip(skip).collect::<Vec<_>>()})
    }

    pub fn record(&self, task_id: &str, ev: &Value) {
        let mut l = self.live.lock().unwrap();
        let (dropped, v) = l.entry(task_id.to_string()).or_default();
        v.push(ev.clone());
        if v.len() > 500 {
            v.remove(0);
            *dropped += 1;
        }
    }

    /// Run the agent for a task, streaming UI events to `tx`; always writes a run log.
    // reqforge: implements REQ-0051
    // reqforge: implements REQ-0052
    pub async fn run(&self, store: Arc<Store>, task_id: String, user: String, tx: mpsc::Sender<Value>) {
        let send = |v: Value| {
            let tx = tx.clone();
            self.record(&task_id, &v);
            async move {
                let _ = tx.send(v).await;
            }
        };
        let reserved: Option<Arc<Notify>> = {
            let mut m = self.cancels.lock().unwrap();
            if m.contains_key(&task_id) {
                None
            } else {
                let n = Arc::new(Notify::new());
                m.insert(task_id.clone(), n.clone());
                Some(n)
            }
        };
        let Some(notify) = reserved else {
            self.pending.lock().unwrap().remove(&task_id);
            send(json!({"type": "error", "text": format!("an agent is already running for {task_id}")})).await;
            return;
        };
        let _slot = Reservation { map: &self.cancels, key: task_id.clone() };
        self.pending.lock().unwrap().remove(&task_id);
        self.live.lock().unwrap().insert(task_id.clone(), (0, vec![]));
        let rd = match crate::taskflow::readiness(&store, &task_id) {
            Ok(r) => r,
            Err(e) => return send(json!({"type": "error", "text": e.message})).await,
        };
        if rd["can_start_agent"] != json!(true) {
            let reasons: Vec<&str> = rd["agent_reasons"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            return send(json!({"type": "error", "text": format!("cannot start an agent: {}", reasons.join("; "))})).await;
        }
        let Some(bin) = claude_bin() else {
            return send(json!({"type": "error", "text": "The `claude` CLI was not found on PATH. Install Claude Code or set REQFORGE_CLAUDE_BIN."})).await;
        };
        let p = match resolve(&store, &task_id) {
            Ok(p) => p,
            Err(e) => return send(json!({"type": "error", "text": e.message})).await,
        };
        let s2 = store.clone();
        let p_task = task_id.clone();
        let (base, started_task) = match tokio::task::spawn_blocking(move || {
            let base = prepare_worktree(&resolve(&s2, &p_task)?)?;
            let started = if crate::taskflow::readiness(&s2, &p_task)?["status"] == json!("todo") {
                crate::taskflow::start(&s2, &p_task, None).map(|_| true)?
            } else {
                false
            };
            Ok::<_, StoreError>((base, started))
        })
        .await
        .unwrap_or_else(|e| Err(StoreError::bad(e.to_string())))
        {
            Ok(x) => x,
            Err(e) => return send(json!({"type": "error", "text": e.message})).await,
        };
        let run_id = format!("RUN-{task_id}-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S%3f"));
        let (before, watch) = snapshot_begin(&p.component_root, &store);
        let started = now();
        send(json!({"type": "run", "run_id": run_id, "branch": p.branch, "worktree": p.worktree.display().to_string(),
                    "component": p.component, "base": base, "task_started": started_task})).await;

        let mut events: Vec<Value> = vec![];
        let child = Command::new(&bin)
            .args(command_args(&store, &task_id))
            .current_dir(&p.worktree)
            .env("REQFORGE_REPO", &store.root)
            .env("REQFORGE_TASK", &task_id)
            .env_remove("REQFORGE_PROJECT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0) // own group: cancel kills the agent and everything it spawned
            .spawn();
        let mut exit_status = json!("error");
        match child {
            Err(e) => send(json!({"type": "error", "text": format!("could not start claude: {e}")})).await,
            Ok(mut child) => {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(p.brief.as_bytes()).await;
                }
                let mut stderr = child.stderr.take().unwrap();
                let err_task = tokio::spawn(async move {
                    let mut buf = String::new();
                    let _ = stderr.read_to_string(&mut buf).await;
                    buf
                });
                let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
                let mut tool_names = HashMap::new();
                let mut cancelled = false;
                let mut timed_out = false;
                let deadline = tokio::time::sleep(self.timeout);
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        _ = &mut deadline => {
                            timed_out = true;
                            if let Some(pid) = child.id() {
                                let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
                            }
                            let _ = child.kill().await;
                            let ev = json!({"type": "error", "text": format!("agent run stopped after the {} min time limit", self.timeout.as_secs() / 60)});
                            self.record(&task_id, &ev);
                            events.push(ev.clone());
                            let _ = tx.send(ev).await;
                            break;
                        }
                        line = lines.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                            for ev in translate(&msg, &mut tool_names) {
                                if ev["type"] == json!("changeset") { continue; }
                                events.push(ev.clone());
                                if events.len() > 200 { events.remove(0); }
                                self.record(&task_id, &ev);
                                if tx.send(ev).await.is_err() { /* client gone: keep running to completion */ }
                            }
                        }
                        _ = notify.notified() => {
                            cancelled = true;
                            if let Some(pid) = child.id() {
                                // signal the whole process group (negative pid)
                                let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
                            }
                            let _ = child.kill().await;
                            break;
                        }
                    }
                }
                let wait = std::time::Duration::from_secs(5);
                let status = tokio::time::timeout(wait, child.wait()).await.ok().and_then(|r| r.ok());
                let err = tokio::time::timeout(wait, err_task).await.ok().and_then(|r| r.ok()).unwrap_or_default();
                exit_status = if timed_out {
                    json!("timeout")
                } else if cancelled {
                    json!("cancelled")
                } else {
                    status.and_then(|s| s.code()).map(|c| json!(c)).unwrap_or(json!("killed"))
                };
                if !cancelled && status.map(|s| !s.success()).unwrap_or(true) && !err.trim().is_empty() {
                    let tail: String = err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
                    events.push(json!({"type": "error", "text": tail}));
                }
            }
        }
        let after = snapshot_end(&p.component_root, &store, watch);
        let viol = violations(&before, &after);
        let commits = commits_since(&p.worktree, &base);
        let user2 = user.clone();
        let log = json!({
            "run_id": run_id, "task": task_id, "story": p.story, "component": p.component, "branch": p.branch,
            "worktree": p.worktree.display().to_string(), "base": base, "user": user2, "started": started, "ended": now(),
            "exit_status": exit_status, "commits": commits, "violations": viol, "events": events,
        });
        let s3 = store.clone();
        let log2 = log.clone();
        let rid = run_id.clone();
        let _ = tokio::task::spawn_blocking(move || -> Res<()> {
            let dir = s3.root.join("agent-runs");
            std::fs::create_dir_all(&dir).map_err(|e| StoreError::bad(e.to_string()))?;
            let _g = s3.lock()?;
            std::fs::write(dir.join(format!("{rid}.json")), dump(&log2)).map_err(|e| StoreError::bad(e.to_string()))?;
            let viol = log2["violations"].as_array().map(Vec::len).unwrap_or(0);
            crate::history::append_unlocked(&s3, &crate::history::Entry {
                kind: "agent".into(),
                id: rid.clone(),
                project: s3.config_value()["key"].as_str().unwrap_or("").into(),
                user: log2["user"].as_str().unwrap_or("").into(),
                start: log2["started"].as_str().unwrap_or("").into(),
                end: log2["ended"].as_str().unwrap_or("").into(),
                outcome: crate::history::agent_outcome(&log2["exit_status"], viol).into(),
                records_touched: vec![log2["task"].as_str().unwrap_or("").into()],
                ..Default::default()
            })?;
            s3.commit(&format!("{}: agent run {} ({})", log2["task"].as_str().unwrap_or(""), rid, log2["exit_status"]));
            Ok(())
        })
        .await;
        send(json!({"type": "result", "run_id": run_id, "exit_status": log["exit_status"], "branch": log["branch"],
                    "commits": log["commits"], "violations": log["violations"], "task_status": store.get(Kind::Tasks, &task_id).map(|t| t["status"].clone()).unwrap_or(Value::Null)})).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_progress_keeps_advancing_past_the_buffer_cap() {
        let r = AgentRunner::default();
        for i in 0..520 {
            r.record("TASK-0001", &json!({"i": i}));
        }
        let all = r.live("TASK-0001", 0);
        assert_eq!(all["total"], json!(520));
        assert_eq!(all["events"][0]["i"], json!(20));
        let tail = r.live("TASK-0001", 518);
        assert_eq!(tail["events"].as_array().unwrap().len(), 2);
        r.record("TASK-0001", &json!({"i": 520}));
        assert_eq!(r.live("TASK-0001", 520)["events"][0]["i"], json!(520));
    }
}
