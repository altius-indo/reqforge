//! Shared fixture for agent tests: a requirements repo, a separate git code repo registered as
//! a component, a story/task plan, and a stand-in for `claude -p`.
#![allow(dead_code)]
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use reqforge::model::{Kind, Rec};
use reqforge::store::Store;
use serde_json::{json, Value};
use tempfile::TempDir;

// reqforge:off  (fake agent script: emits stream-json and acts on the worktree)
pub const FAKE_AGENT: &str = r#"#!/bin/sh
brief=$(cat)
pwd > agent-cwd.txt
printf '%s\n' "$@" > agent-args.txt
echo '{"type":"system","subtype":"init","session_id":"agent-1","mcp_servers":[{"name":"plugin:reqforge:reqforge","status":"connected"}]}'
case "$brief" in *SLOW*) sleep 30;; esac
case "$brief" in *FAIL*) echo '{"type":"result","subtype":"error","session_id":"agent-1","is_error":true,"result":"boom"}'; exit 1;; esac
printf 'def feature():\n    return 42\n' > feature.py
git add feature.py agent-cwd.txt agent-args.txt >/dev/null
git -c user.email=a@a -c user.name=agent commit -qm "$REQFORGE_TASK: implement feature" >/dev/null
case "$brief" in *MISBEHAVE*)
  echo sneaky > "$REQFORGE_REPO/sneaky.txt"
  main=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)
  echo tampered >> "$main/README.md";;
esac
case "$brief" in *PAUSE*) sleep 3;; esac
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"feature.py"}}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Implemented feature(); tests pass."}]}}'
echo '{"type":"result","subtype":"success","session_id":"agent-1","total_cost_usd":0.0,"num_turns":2,"is_error":false}'
"#;
// reqforge:on

static ROOT: OnceLock<TempDir> = OnceLock::new();

/// One temp root + env per test binary (env is process-global); each fixture is a separate project.
pub fn root() -> &'static Path {
    ROOT.get_or_init(|| {
        let d = TempDir::new().unwrap();
        let fake = d.path().join("fake-claude");
        fs::write(&fake, FAKE_AGENT).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("REQFORGE_CLAUDE_BIN", &fake);
        std::env::set_var("REQFORGE_WORKTREES", d.path().join("worktrees"));
        d
    })
    .path()
}

pub fn rec(v: Value) -> Rec {
    v.as_object().unwrap().clone()
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

pub struct Fx {
    pub store: Arc<Store>,
    pub code: PathBuf,
    pub key: String,
}

/// `key` must be unique per test (it names the project and its worktree folder).
pub fn fx(key: &str, task_title: &str) -> Fx {
    let base = root().join(key.to_lowercase());
    let code = base.join("code");
    fs::create_dir_all(&code).unwrap();
    fs::write(code.join("README.md"), "# code\n").unwrap();
    git(&code, &["init", "-q", "-b", "main"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    let store = Store::init(base.join("reqs"), key, key, None, true).unwrap();
    store.create(Kind::Requirements, &rec(json!({"title": "Answer", "type": "functional", "category": "core", "status": "approved",
        "statement": "The system shall answer 42.", "acceptance_criteria": [{"id": "AC1", "text": "feature() returns 42"}]})), None).unwrap();
    store.create(Kind::Components, &rec(json!({"title": "Code", "key": "code", "path": code.display().to_string()})), None).unwrap();
    store.create(Kind::Epics, &rec(json!({"title": "Core", "requirements": ["REQ-0001"]})), None).unwrap();
    store.create(Kind::Stories, &rec(json!({"title": "Answer story", "epic": "EPIC-0001", "requirements": ["REQ-0001"], "component": "code",
        "narrative": "As a user, I want the answer so that I can stop asking.",
        "evals": [{"id": "E1", "name": "unit", "kind": "unit", "command": "pytest tests/test_feature.py", "covers": ["REQ-0001#AC1"]}]})), None).unwrap();
    store.create(Kind::Tasks, &rec(json!({"title": task_title, "story": "STORY-0001", "kind": "code",
        "description": "Implement feature() in feature.py.", "done_when": "pytest tests/test_feature.py passes"})), None).unwrap();
    Fx { store: Arc::new(store), code, key: key.into() }
}

/// Run the agent for TASK-0001 to completion and return all UI events.
pub fn run(f: &Fx) -> Vec<Value> {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let runner = reqforge::agent::AgentRunner::default();
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let store = f.store.clone();
        let h = tokio::spawn(async move { runner.run(store, "TASK-0001".into(), "tester".into(), tx).await });
        let mut out = vec![];
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        h.await.unwrap();
        out
    })
}

pub fn result(evs: &[Value]) -> Value {
    evs.iter().find(|e| e["type"] == json!("result")).cloned().unwrap_or_else(|| panic!("no result event: {evs:?}"))
}

pub fn worktree(f: &Fx) -> PathBuf {
    root().join("worktrees").join(&f.key).join("TASK-0001")
}

/// Add another task to STORY-0001 and return its id.
pub fn add_task(f: &Fx, title: &str, deps: Value) -> String {
    let t = f.store.create(Kind::Tasks, &rec(json!({"title": title, "story": "STORY-0001", "kind": "code", "depends_on": deps})), None).unwrap();
    t["id"].as_str().unwrap().to_string()
}

pub fn wait_until(mut cond: impl FnMut() -> bool, secs: u64) -> bool {
    let t0 = std::time::Instant::now();
    while t0.elapsed().as_secs() < secs {
        if cond() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cond()
}
