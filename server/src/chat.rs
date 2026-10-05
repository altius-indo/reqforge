//! Bridge from the web UI chat panel to the local Claude Code CLI.
//!
//! Each user message runs `claude -p` (headless) with the reqforge plugin loaded, a system
//! prompt that defines the review -> simulate -> propose loop, and a tool allowlist that
//! excludes every direct write: the agent can only propose changesets and the user applies
//! them in the UI. Continuity uses `--resume`. stream-json output is translated into small UI
//! events (session, tool, text, changeset, warning, error, done).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Notify};

pub const SYSTEM_PROMPT: &str = include_str!("chat_prompt.md");
pub const MCP: &str = "mcp__plugin_reqforge_reqforge__";
pub const READ_TOOLS: &[&str] = &[
    "taxonomy", "search", "get", "context", "lint", "trace", "eval_registry", "simulate_changeset", "propose_changeset",
    "get_changeset", "list_changesets", "save_session", "verification", "impact", "list_projects",
];
pub const WRITE_TOOLS: &[&str] = &[
    "create", "update", "delete", "bulk_update", "upsert_many", "apply_changeset", "reject_changeset", "config", "sync", "init_repo",
    "scan_code", "ingest_evidence", "create_project",
];

// reqforge: implements REQ-0041
pub fn allowed() -> Vec<String> {
    READ_TOOLS
        .iter()
        .map(|t| format!("{MCP}{t}"))
        .chain(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent", "Task", "TodoWrite"].map(String::from))
        .collect()
}

pub fn denied() -> Vec<String> {
    WRITE_TOOLS.iter().map(|t| format!("{MCP}{t}")).chain(["Bash", "Write", "Edit", "NotebookEdit"].map(String::from)).collect()
}

pub fn claude_bin() -> Option<String> {
    if let Ok(b) = std::env::var("REQFORGE_CLAUDE_BIN") {
        if !b.is_empty() {
            return Some(b);
        }
    }
    std::env::var_os("PATH")
        .and_then(|p| std::env::split_paths(&p).map(|d| d.join("claude")).find(|c| c.is_file()))
        .map(|p| p.display().to_string())
}

pub fn plugin_root() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("REQFORGE_PLUGIN_DIR") {
        return Some(PathBuf::from(d));
    }
    let from_exe = std::env::current_exe().ok().and_then(|e| e.ancestors().find(|p| p.join(".claude-plugin").is_dir()).map(PathBuf::from));
    from_exe.or_else(|| {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        p.join(".claude-plugin").is_dir().then_some(p)
    })
}

fn context_preamble(ctx: &Value) -> String {
    if !ctx.is_object() {
        return String::new();
    }
    let mut lines = vec!["[UI context]".to_string()];
    if let Some(view) = ctx.get("view").and_then(Value::as_object) {
        let parts: Vec<String> = view
            .iter()
            .filter(|(_, v)| !crate::model::is_empty(Some(v)))
            .map(|(k, v)| format!("{k}={}", v.as_str().map(String::from).unwrap_or_else(|| v.to_string())))
            .collect();
        if !parts.is_empty() {
            lines.push(format!("Viewing: {}", parts.join(", ")));
        }
    }
    let sel: Vec<&str> = ctx.get("selected").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if !sel.is_empty() {
        let total = ctx.get("selected_total").and_then(Value::as_u64).unwrap_or(sel.len() as u64) as usize;
        let more = if total > sel.len() { format!(" (+{} more)", total - sel.len()) } else { String::new() };
        lines.push(format!("Selected records: {}{more}", sel.join(", ")));
    }
    lines.join("\n") + "\n\n"
}

/// The task the UI context is about: an open task drawer (`view.task`), or the tasks tab with
/// exactly one task selected.
fn focused_task(ctx: &Value) -> Option<String> {
    let view = ctx.get("view")?;
    if let Some(t) = view.get("task").and_then(Value::as_str).filter(|t| t.starts_with("TASK-")) {
        return Some(t.to_string());
    }
    let sel: Vec<&str> = ctx.get("selected").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let total = ctx.get("selected_total").and_then(Value::as_u64).unwrap_or(sel.len() as u64);
    (view.get("tab").and_then(Value::as_str) == Some("tasks") && sel.len() == 1 && total == 1 && sel[0].starts_with("TASK-")).then(|| sel[0].to_string())
}

/// The prompt sent on a chat turn. The first turn of a session starts with the task section (when
/// the chat is about one task) and the project snapshot, verbatim (REQ-0058#AC1); resumed turns
/// already have it in the conversation.
// reqforge: implements REQ-0058
pub fn turn_prompt(root: &std::path::Path, message: &str, first_turn: bool, ctx: &Value) -> String {
    let mut out = String::new();
    if first_turn {
        let task = focused_task(ctx).and_then(|id| crate::store::Store::open(root).ok()?.get(crate::model::Kind::Tasks, &id).ok());
        if let Some(t) = task {
            out.push_str(&crate::agent::task_section(&t));
            out.push_str("\n\n");
        }
        if let Some(c) = crate::snapshot::read(root) {
            out.push_str(&crate::snapshot::context_block(&c));
            out.push_str("\n\n");
        }
    }
    out + &context_preamble(ctx) + message
}

fn tool_brief(name: &str, inp: &Value) -> String {
    let short = name.replace(MCP, "");
    let g = |k: &str| inp.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match short.as_str() {
        "search" => format!("search {} “{}”", g("kind"), g("q")),
        "get" | "context" => format!("{short} {}", g("id")),
        "simulate_changeset" | "propose_changeset" => {
            let cs = inp.get("changeset").unwrap_or(inp);
            format!(
                "{}: {} ops — {}",
                short.replace('_', " "),
                cs.get("ops").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                cs.get("title").and_then(Value::as_str).unwrap_or("")
            )
        }
        "Agent" | "Task" => format!("agent {}: {}", g("subagent_type"), g("description")),
        "Grep" | "Glob" => format!("{short} {}", g("pattern")),
        "Read" => format!("read {}", g("file_path")),
        "WebSearch" | "WebFetch" => format!("{short} {}", if g("query").is_empty() { g("url") } else { g("query") }),
        _ => short,
    }
}

/// Translate one stream-json message into UI events.
pub fn translate(msg: &Value, tool_names: &mut HashMap<String, String>) -> Vec<Value> {
    let mut out = vec![];
    let sub = msg.get("parent_tool_use_id").map(|v| !v.is_null()).unwrap_or(false);
    match msg.get("type").and_then(Value::as_str) {
        Some("system") if msg.get("subtype").and_then(Value::as_str) == Some("init") => {
            out.push(json!({"type": "session", "session_id": msg.get("session_id")}));
            let st = msg
                .get("mcp_servers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|s| s.get("name").and_then(Value::as_str).map(|n| n.contains("reqforge")).unwrap_or(false))
                .and_then(|s| s.get("status").and_then(Value::as_str).map(String::from));
            if st.as_deref() != Some("connected") {
                out.push(json!({"type": "warning", "text": format!("reqforge MCP server status: {}", st.unwrap_or_else(|| "not loaded".into()))}));
            }
        }
        Some("assistant") => {
            for c in msg.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                match c.get("type").and_then(Value::as_str) {
                    Some("text") if !sub => {
                        let t = c.get("text").and_then(Value::as_str).unwrap_or("");
                        if !t.trim().is_empty() {
                            out.push(json!({"type": "text", "text": t}));
                        }
                    }
                    Some("tool_use") => {
                        let name = c.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                        if let Some(id) = c.get("id").and_then(Value::as_str) {
                            tool_names.insert(id.into(), name.clone());
                        }
                        out.push(json!({"type": "tool", "name": name.replace(MCP, ""), "sub": sub,
                            "text": tool_brief(&name, c.get("input").unwrap_or(&json!({})))}));
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for c in msg.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if c.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let tid = c.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                if !tool_names.get(tid).map(|n| n.ends_with("propose_changeset")).unwrap_or(false) {
                    continue;
                }
                let text = match c.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<String>(),
                    _ => String::new(),
                };
                if let Ok(d) = serde_json::from_str::<Value>(&text) {
                    if let Some(id) = d.get("changeset_id").and_then(Value::as_str) {
                        out.push(json!({"type": "changeset", "id": id}));
                    }
                }
            }
        }
        Some("result") => {
            let is_error = msg.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            out.push(json!({"type": "done", "session_id": msg.get("session_id"), "cost": msg.get("total_cost_usd"),
                "turns": msg.get("num_turns"), "is_error": is_error, "result": if is_error { msg.get("result").cloned().unwrap_or(Value::Null) } else { Value::Null }}));
        }
        _ => {}
    }
    out
}

pub struct ChatRunner {
    root: PathBuf,
    key: String,
    components: Vec<PathBuf>,
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
}

impl ChatRunner {
    pub fn new(root: PathBuf, config: &Value) -> Self {
        let components = config
            .get("components")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(_, p)| p.as_str())
            .map(|p| root.join(p))
            .filter(|p| p.exists())
            .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
            .collect();
        let key = config.get("key").and_then(Value::as_str).unwrap_or("").to_string();
        ChatRunner { root, key, components, cancels: Mutex::new(HashMap::new()) }
    }

    pub fn status(&self) -> Value {
        let c = claude_bin();
        json!({"available": c.is_some(), "claude": c})
    }

    /// With `REQFORGE_SNAPSHOT_RESUPPLY=system` every turn's system prompt also carries the current
    /// snapshot (fallback for the compaction hook, REQ-0058#AC3).
    // reqforge: implements REQ-0058
    pub fn command_args(&self, session_id: Option<&str>) -> Vec<String> {
        let mut system = SYSTEM_PROMPT.to_string();
        if let Some(c) = crate::snapshot::read(&self.root).filter(|_| crate::snapshot::resupply_in_system_prompt()) {
            system.push_str(&format!("\n\n{}", crate::snapshot::context_block(&c)));
        }
        let mut a: Vec<String> = vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into(),
            "--append-system-prompt".into(), system,
            "--allowedTools".into(), allowed().join(","), "--disallowedTools".into(), denied().join(",")];
        if let Some(p) = plugin_root() {
            a.extend(["--plugin-dir".into(), p.display().to_string()]);
        }
        for c in &self.components {
            a.extend(["--add-dir".into(), c.display().to_string()]);
        }
        if let Ok(m) = std::env::var("REQFORGE_CHAT_MODEL") {
            if !m.is_empty() {
                a.extend(["--model".into(), m]);
            }
        }
        if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
            a.extend(["--resume".into(), sid.into()]);
        }
        a
    }

    // reqforge: implements REQ-0041
    /// Environment for the claude process and the reqforge MCP server it starts: the chat role
    /// and the chat's project, so the server refuses deny-listed tools and other projects.
    pub fn mcp_env(&self) -> Vec<(String, String)> {
        vec![
            ("REQFORGE_REPO".into(), self.root.display().to_string()),
            (crate::mcp::ENV_ROLE.into(), "chat".into()),
            (crate::mcp::ENV_PROJECT.into(), self.key.clone()),
        ]
    }

    /// Cancel every running turn (project deleted).
    pub fn cancel_all(&self) {
        for n in self.cancels.lock().unwrap().values() {
            n.notify_one();
        }
    }

    pub fn cancel(&self, chat_id: &str) -> bool {
        match self.cancels.lock().unwrap().get(chat_id) {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        }
    }

    // reqforge: implements REQ-0015
    // reqforge: implements REQ-0047
    /// Run one turn, sending UI events to `tx`. Returns when the process exits, is cancelled,
    /// or the receiver goes away (client disconnected).
    pub async fn stream(&self, chat_id: String, message: String, session_id: Option<String>, context: Value, tx: mpsc::Sender<Value>) {
        let Some(bin) = claude_bin() else {
            let _ = tx.send(json!({"type": "error", "text": "The `claude` CLI was not found on PATH. Install Claude Code or set REQFORGE_CLAUDE_BIN."})).await;
            return;
        };
        let first_turn = session_id.as_deref().map(str::is_empty).unwrap_or(true);
        let prompt = turn_prompt(&self.root, &message, first_turn, &context);
        let child = Command::new(&bin)
            .args(self.command_args(session_id.as_deref()))
            .current_dir(&self.root)
            .envs(self.mcp_env())
            .env_remove("REQFORGE_PROJECT") // pin the agent's MCP calls to this project
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(json!({"type": "error", "text": format!("could not start claude: {e}")})).await;
                return;
            }
        };
        let notify = Arc::new(Notify::new());
        self.cancels.lock().unwrap().insert(chat_id.clone(), notify.clone());
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }
        let mut stderr = child.stderr.take().unwrap();
        let err_task = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf).await;
            buf
        });
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut tool_names = HashMap::new();
        let (mut got_result, mut cancelled) = (false, false);
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    for ev in translate(&msg, &mut tool_names) {
                        if ev["type"] == json!("done") { got_result = true; }
                        if tx.send(ev).await.is_err() { let _ = child.kill().await; self.cancels.lock().unwrap().remove(&chat_id); return; }
                    }
                }
                _ = notify.notified() => { cancelled = true; let _ = child.kill().await; break; }
            }
        }
        let status = child.wait().await.ok();
        let err = err_task.await.unwrap_or_default();
        self.cancels.lock().unwrap().remove(&chat_id);
        if cancelled {
            let _ = tx.send(json!({"type": "error", "text": "cancelled"})).await;
        } else if !got_result && status.map(|s| !s.success()).unwrap_or(true) {
            let tail: String = err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
            let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            let _ = tx.send(json!({"type": "error", "text": format!("claude exited {code}: {tail}")})).await;
        }
    }
}
