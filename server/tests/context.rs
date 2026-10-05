//! STORY-0017: the project snapshot (state/HOT.md) and its place in chat and agent context.
//! Every test name starts with `snapshot_` (E1: `cargo test --test context -- snapshot`).
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use reqforge::changes;
use reqforge::model::{Kind, Rec};
use reqforge::snapshot;
use reqforge::store::Store;
use serde_json::{json, Value};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_reqforge");

/// Tests that set process-wide env vars (REQFORGE_TODAY, REQFORGE_SNAPSHOT_RESUPPLY) hold this.
static ENV: Mutex<()> = Mutex::new(());

fn rec(v: Value) -> Rec {
    v.as_object().unwrap().clone()
}

fn hot(next: &[&str], date: &str) -> String {
    let items: String = next.iter().map(|n| format!("- {n}\n")).collect();
    format!("# Project state\n\n## Now\nBuilding the snapshot op.\n- server side in review\n\n## Next\n{items}\n## Watch\n- compaction hook on new Claude Code versions\n\nLast reconciled: {date}\n")
}

fn fx() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::init(dir.path(), "CTX", "Context", None, true).unwrap();
    (dir, store)
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// A project with a requirement, story and task (for briefs and task-focused chats).
fn seed_task(store: &Store) {
    store.create(Kind::Requirements, &rec(json!({"title": "Answer", "type": "functional", "category": "core", "status": "approved",
        "statement": "The system shall answer 42.", "acceptance_criteria": [{"id": "AC1", "text": "feature() returns 42"}]})), None).unwrap();
    store.create(Kind::Epics, &rec(json!({"title": "Core", "requirements": ["REQ-0001"]})), None).unwrap();
    store.create(Kind::Stories, &rec(json!({"title": "Answer story", "epic": "EPIC-0001", "requirements": ["REQ-0001"],
        "narrative": "As a user, I want the answer."})), None).unwrap();
    store.create(Kind::Tasks, &rec(json!({"title": "Implement feature", "story": "STORY-0001", "kind": "code",
        "description": "Implement feature() in feature.py.", "done_when": "pytest passes",
        "next_action": "Run pytest tests/test_feature.py and fix the failing case", "next_action_set": "2026-10-01"})), None).unwrap();
}

/// Write a snapshot the only legitimate way: propose and apply a changeset.
fn apply_snapshot(store: &Store, content: &str) -> Value {
    let p = changes::propose(store, &json!({"title": "snapshot", "ops": [{"op": "snapshot", "content": content, "reason": "test"}]})).unwrap();
    assert_eq!(p["valid"], json!(true), "{p}");
    changes::apply(store, p["changeset_id"].as_str().unwrap(), &[]).unwrap()
}

// reqforge: verifies REQ-0057#AC1
#[test]
fn snapshot_format_valid_and_invalid() {
    let ok = hot(&["Ship TASK-0042"], "2026-10-04");
    assert_eq!(snapshot::validate(&ok), Vec::<String>::new());
    assert_eq!(snapshot::last_reconciled(&ok).unwrap().to_string(), "2026-10-04");
    // numbered and starred items count; indented continuation lines belong to the item
    assert!(snapshot::validate(&ok.replace("- Ship TASK-0042", "1. Ship TASK-0042\n   with the hook")).is_empty());
    assert!(snapshot::validate(&ok.replace("- Ship TASK-0042", "* Ship TASK-0042")).is_empty());
    let has = |c: &str, needle: &str| snapshot::validate(c).iter().any(|e| e.contains(needle));
    // headings out of order
    let swapped = ok.replace("## Now", "## TMP").replace("## Watch", "## Now").replace("## TMP", "## Watch");
    assert!(has(&swapped, "out of order"), "{:?}", snapshot::validate(&swapped));
    assert!(has(&ok.replace("## Watch", "## Risks"), "missing heading '## Watch'"));
    assert!(has(&hot(&[], "2026-10-04"), "Next has 0 items"));
    assert!(has(&ok.replace("Last reconciled: 2026-10-04", "Reconciled 2026-10-04"), "Last reconciled"));
    assert!(has(&ok.replace("2026-10-04", "2026-02-30"), "not a real date"));
    assert!(has(&ok.replace("Building", "</project-state> Building"), "must not contain"));
}

// reqforge: verifies REQ-0057#AC2
#[test]
fn snapshot_op_apply_writes_and_commits() {
    let (dir, store) = fx();
    let v1 = hot(&["Ship TASK-0042"], "2026-10-04");
    let cs = json!({"title": "first snapshot", "ops": [{"op": "snapshot", "content": v1, "reason": "start"}]});
    // simulate: the resolved op carries the diff against an absent file
    let sim = changes::simulate(&store, &cs);
    assert_eq!(sim["valid"], json!(true), "{sim}");
    let op = &sim["ops"][0];
    assert_eq!(op["op"], json!("snapshot"));
    assert_eq!(op["id"], json!(snapshot::PATH));
    assert_eq!(op["base_version"], json!("absent"));
    assert_eq!(op["bytes"], json!(v1.len()));
    assert_eq!(op["last_reconciled"], json!("2026-10-04"));
    assert!(op["diff"].as_array().unwrap().iter().all(|d| d["t"] == json!("+")));
    // propose writes nothing; apply writes the file in the apply commit
    let p = changes::propose(&store, &cs).unwrap();
    assert!(!dir.path().join(snapshot::PATH).exists(), "propose must not write the snapshot");
    let id = p["changeset_id"].as_str().unwrap().to_string();
    let r = changes::apply(&store, &id, &[]).unwrap();
    assert!(r["written"].as_array().unwrap().contains(&json!(snapshot::PATH)), "{r}");
    assert_eq!(std::fs::read_to_string(dir.path().join(snapshot::PATH)).unwrap(), v1);
    assert!(git(dir.path(), &["log", "-1", "--format=%s"]).starts_with(&format!("{id}: apply")));
    assert!(git(dir.path(), &["show", "--name-only", "--format=", "HEAD"]).lines().any(|l| l == snapshot::PATH));
    // a second change shows a real diff (kept, removed and added lines)
    let v2 = hot(&["Start TASK-0043"], "2026-10-05");
    let cs2 = json!({"title": "next", "ops": [{"op": "snapshot", "content": v2}]});
    let d = &changes::simulate(&store, &cs2)["ops"][0]["diff"];
    let has = |t: &str, l: &str| d.as_array().unwrap().iter().any(|x| x["t"] == json!(t) && x["line"] == json!(l));
    assert!(has(" ", "## Now") && has("-", "- Ship TASK-0042") && has("+", "- Start TASK-0043"), "{d}");
    // the file changing between propose and apply makes the changeset stale
    let p2 = changes::propose(&store, &cs2).unwrap();
    apply_snapshot(&store, &hot(&["Something else"], "2026-10-05"));
    let e = changes::apply(&store, p2["changeset_id"].as_str().unwrap(), &[]).unwrap_err();
    assert_eq!(e.status, 409, "{}", e.message);
    assert_eq!(changes::get(&store, p2["changeset_id"].as_str().unwrap()).unwrap()["status"], json!("stale"));
    // at most one snapshot op per changeset; excluding the op skips the write
    let two = json!({"title": "two", "ops": [{"op": "snapshot", "content": v2}, {"op": "snapshot", "content": v2}]});
    assert_eq!(changes::simulate(&store, &two)["valid"], json!(false));
    let before = std::fs::read_to_string(dir.path().join(snapshot::PATH)).unwrap();
    let p3 = changes::propose(&store, &json!({"title": "skip", "ops": [{"op": "snapshot", "content": v2}]})).unwrap();
    changes::apply(&store, p3["changeset_id"].as_str().unwrap(), &[0]).unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join(snapshot::PATH)).unwrap(), before);
}

fn src_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

// reqforge: verifies REQ-0057#AC2
#[test]
fn snapshot_single_writer() {
    let mut writers = vec![];
    for e in std::fs::read_dir(src_dir()).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".rs") || name == "snapshot.rs" {
            continue;
        }
        let text = std::fs::read_to_string(e.path()).unwrap();
        for (n, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            // the path itself is spelled only in snapshot.rs; everything else goes through snapshot::PATH
            assert!(!line.contains("state/HOT.md"), "{name}:{} spells the snapshot path; use snapshot::PATH", n + 1);
            if line.contains("snapshot::write_unlocked") {
                writers.push((name.clone(), n + 1));
            }
            let writes = ["fs::write", "File::create", "OpenOptions", "rename", "remove_file", "write_all"].iter().any(|w| line.contains(w));
            assert!(!(writes && line.contains("snapshot::PATH")), "{name}:{} writes the snapshot path: {line}", n + 1);
        }
    }
    assert_eq!(writers.len(), 1, "snapshot::write_unlocked callers: {writers:?}");
    let (file, line) = &writers[0];
    assert_eq!(file, "changes.rs");
    // and that call sits inside changes::apply
    let text = std::fs::read_to_string(src_dir().join("changes.rs")).unwrap();
    let apply_start = text.lines().position(|l| l.starts_with("pub fn apply(")).unwrap() + 1;
    let apply_end = text.lines().enumerate().skip(apply_start).find(|(_, l)| *l == "}").map(|(i, _)| i + 1).unwrap();
    assert!((apply_start..=apply_end).contains(line), "write at changes.rs:{line} is outside apply ({apply_start}-{apply_end})");
    // write_unlocked is crate-private: nothing outside the crate (API, MCP, CLI users) can call it
    let snap = std::fs::read_to_string(src_dir().join("snapshot.rs")).unwrap();
    assert!(snap.contains("pub(crate) fn write_unlocked("));
}

// reqforge: verifies REQ-0057#AC3
#[test]
fn snapshot_simulate_errors() {
    let (_dir, store) = fx();
    let ok = hot(&["Ship TASK-0042"], "2026-10-04");
    let big = ok.replace("Building the snapshot op.", &format!("Building the snapshot op.\n{}", "x".repeat(8192)));
    let cases = [
        (big, "bytes, limit is 8,192"),
        (ok.replace("## Next\n", "## Later\n"), "missing heading '## Next'"),
        (hot(&["one", "two"], "2026-10-04"), "Next has 2 items, must have exactly 1"),
    ];
    for (content, needle) in cases {
        let sim = changes::simulate(&store, &json!({"title": "bad", "ops": [{"op": "snapshot", "content": content}]}));
        assert_eq!(sim["valid"], json!(false), "{needle}");
        let errs: Vec<&str> = sim["errors"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(errs.iter().any(|e| e.starts_with("op 0 (snapshot): ") && e.contains(needle)), "{needle}: {errs:?}");
        // propose keeps the errors; apply refuses
        let p = changes::propose(&store, &json!({"title": "bad", "ops": [{"op": "snapshot", "content": content}]})).unwrap();
        assert_eq!(p["valid"], json!(false));
        assert_eq!(changes::apply(&store, p["changeset_id"].as_str().unwrap(), &[]).unwrap_err().status, 422);
    }
    assert!(!store.root.join(snapshot::PATH).exists());
    // content must be a string
    let sim = changes::simulate(&store, &json!({"ops": [{"op": "snapshot", "content": 7}]}));
    assert_eq!(sim["valid"], json!(false));
}

// reqforge: verifies REQ-0057#AC4
#[test]
fn snapshot_lint_stale() {
    let _g = ENV.lock().unwrap_or_else(|p| p.into_inner());
    let (_dir, store) = fx();
    let rules = |s: &Store| -> Vec<String> {
        reqforge::lint::lint(s)["findings"].as_array().unwrap().iter().filter_map(|f| f["rule"].as_str()).filter(|r| r.starts_with("snapshot")).map(String::from).collect()
    };
    std::env::set_var("REQFORGE_TODAY", "2026-10-26");
    assert!(rules(&store).is_empty(), "no snapshot is a normal state");
    apply_snapshot(&store, &hot(&["Ship"], "2026-10-04"));
    // 2026-10-04 + 21 days = 2026-10-25
    std::env::set_var("REQFORGE_TODAY", "2026-10-25");
    assert!(rules(&store).is_empty());
    std::env::set_var("REQFORGE_TODAY", "2026-10-26");
    assert_eq!(rules(&store), vec!["snapshot-stale"]);
    let f = reqforge::lint::lint(&store)["findings"].as_array().unwrap().iter().find(|f| f["rule"] == json!("snapshot-stale")).cloned().unwrap();
    assert_eq!(f["severity"], json!("warning"));
    assert_eq!(f["message"], json!("state/HOT.md last reconciled 2026-10-04 (22 days ago, limit 21)"));
    // a changeset that refreshes the date resolves the warning in simulate
    let sim = changes::simulate(&store, &json!({"ops": [{"op": "snapshot", "content": hot(&["Ship"], "2026-10-26")}]}));
    assert!(sim["lint"]["resolved"].as_array().unwrap().iter().any(|f| f["rule"] == json!("snapshot-stale")), "{}", sim["lint"]);
    std::env::remove_var("REQFORGE_TODAY");
    // a hand-edited invalid file gets one warning
    std::fs::write(store.root.join(snapshot::PATH), "## Now\nonly\n").unwrap();
    assert_eq!(rules(&store), vec!["snapshot-invalid"]);
}

// reqforge: verifies REQ-0057#AC4
#[test]
fn snapshot_staleness_in_monitor_and_verification() {
    let _g = ENV.lock().unwrap_or_else(|p| p.into_inner());
    let (_dir, store) = fx();
    let state = |s: &Store| reqforge::verify::compute(s, &[], &Default::default())["summary"]["state"].clone();
    let st = state(&store);
    assert_eq!(st["snapshot"]["exists"], json!(false));
    assert_eq!((st["snapshot"]["stale"].clone(), st["snapshot"]["days_over"].clone()), (json!(false), json!(0)));
    assert_eq!(st["decisions"]["unexercised"], json!(0));
    apply_snapshot(&store, &hot(&["Ship"], "2026-10-04"));
    std::env::set_var("REQFORGE_TODAY", "2026-10-25");
    let st = state(&store);
    assert_eq!((st["snapshot"]["age_days"].clone(), st["snapshot"]["stale"].clone(), st["snapshot"]["days_over"].clone()), (json!(21), json!(false), json!(0)));
    std::env::set_var("REQFORGE_TODAY", "2026-10-28");
    let st = state(&store);
    assert_eq!((st["snapshot"]["age_days"].clone(), st["snapshot"]["stale"].clone(), st["snapshot"]["days_over"].clone()), (json!(24), json!(true), json!(3)));
    assert_eq!(st["snapshot"]["last_reconciled"], json!("2026-10-04"));
    // the monitor command prints both counts (the scheduled monitor job appends this to its summary)
    let out = Command::new(BIN).args(["--repo", store.root.to_str().unwrap(), "monitor", "--md"]).env("REQFORGE_TODAY", "2026-10-28").output().unwrap();
    std::env::remove_var("REQFORGE_TODAY");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let md = String::from_utf8_lossy(&out.stdout);
    assert!(md.contains("snapshot: 24 days old (stale, 3 days over the 21-day limit)"), "{md}");
    assert!(md.contains("decisions: 0 of 0 accepted unexercised, 0 past the 14-day grace period"), "{md}");
    // and the generated pipeline's monitor job runs it
    let wf = reqforge::cicd::workflow(&store, ".");
    let monitor = &wf[wf.find("\n  monitor:").expect("monitor job")..];
    assert!(monitor.contains("reqforge evals run --stage monitor"), "{monitor}");
    assert!(monitor.contains("reqforge monitor --md >> \"$GITHUB_STEP_SUMMARY\""), "{monitor}");
}

// reqforge:off  (fake claude: records the prompt on stdin per turn kind)
const FAKE_CHAT: &str = r#"#!/bin/sh
kind=first
for a in "$@"; do [ "$a" = "--resume" ] && kind=resume; done
cat > "prompt-$kind.txt"
echo '{"type":"system","subtype":"init","session_id":"sess-1","mcp_servers":[{"name":"plugin:reqforge:reqforge","status":"connected"}]}'
echo '{"type":"result","subtype":"success","session_id":"sess-1","total_cost_usd":0.0,"num_turns":1,"is_error":false}'
"#;
// reqforge:on

fn fake_claude() {
    static FAKE: OnceLock<TempDir> = OnceLock::new();
    FAKE.get_or_init(|| {
        let d = TempDir::new().unwrap();
        let p = d.path().join("fake-claude");
        std::fs::write(&p, FAKE_CHAT).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("REQFORGE_CLAUDE_BIN", &p);
        d
    });
}

fn chat_turn(store: &Store, session: Option<&str>, ctx: Value) -> String {
    fake_claude();
    let runner = reqforge::chat::ChatRunner::new(store.root.clone(), &store.config_value());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let sid = session.map(String::from);
    rt.block_on(async {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let h = tokio::spawn(async move { runner.stream("c1".into(), "hello".into(), sid, ctx, tx).await });
        while rx.recv().await.is_some() {}
        h.await.unwrap();
    });
    let kind = if session.is_some() { "resume" } else { "first" };
    std::fs::read_to_string(store.root.join(format!("prompt-{kind}.txt"))).unwrap()
}

// reqforge: verifies REQ-0058#AC1
// reqforge: verifies REQ-0058#AC4
#[test]
fn snapshot_chat_first_turn() {
    let (_dir, store) = fx();
    // no snapshot: the session starts normally, without a block
    let p = chat_turn(&store, None, json!({}));
    assert!(!p.contains("<project-state"), "{p}");
    assert!(p.ends_with("hello"));
    let content = hot(&["Ship TASK-0042"], "2026-10-04");
    apply_snapshot(&store, &content);
    let first = chat_turn(&store, None, json!({"view": {"tab": "requirements"}}));
    let block = snapshot::context_block(&content);
    assert!(first.starts_with(&block), "first turn must start with the snapshot block:\n{first}");
    assert!(first.contains(&content), "verbatim content");
    assert!(block.starts_with("<project-state source=\"state/HOT.md\" last-reconciled=\"2026-10-04\">\n"));
    assert!(first.ends_with("hello"));
    // a resumed turn does not repeat it
    let resumed = chat_turn(&store, Some("sess-1"), json!({"view": {"tab": "requirements"}}));
    assert!(!resumed.contains("<project-state"), "{resumed}");
    // a chat about one task: next action and task section, then the snapshot
    seed_task(&store);
    let t = chat_turn(&store, None, json!({"view": {"tab": "tasks"}, "selected": ["TASK-0001"], "selected_total": 1}));
    let (na, ts, sb) = (t.find("## Next action (set 2026-10-01)").unwrap(), t.find("## What to do").unwrap(), t.find("<project-state").unwrap());
    assert!(na < ts && ts < sb, "{t}");
}

// reqforge: verifies REQ-0058#AC2
// reqforge: verifies REQ-0058#AC4
#[test]
fn snapshot_agent_brief() {
    let (_dir, store) = fx();
    seed_task(&store);
    let b = reqforge::agent::brief(&store, "TASK-0001").unwrap();
    assert!(b.contains("## Project snapshot\n(none: this project has no state/HOT.md yet)"), "{b}");
    let content = hot(&["Ship TASK-0042"], "2026-10-04");
    apply_snapshot(&store, &content);
    let b = reqforge::agent::brief(&store, "TASK-0001").unwrap();
    let pos = |n: &str| b.find(n).unwrap_or_else(|| panic!("brief misses {n:?}:\n{b}"));
    let block = snapshot::context_block(&content);
    assert!(b.starts_with("# Task TASK-0001: Implement feature"));
    // next action first, then the task section, then the snapshot verbatim, then the story
    assert!(pos("## Next action (set 2026-10-01)\nRun pytest") < pos("Kind: code"));
    assert!(pos("Kind: code") < pos("## What to do") && pos("## What to do") < pos("## Done when"));
    assert!(pos("## Done when") < pos("## Project snapshot") && pos("## Project snapshot") < pos(&block) && pos(&block) < pos("## Story STORY-0001"));
}

fn hook(repo: Option<&Path>, task: Option<&str>) -> (i32, String) {
    let mut c = Command::new(BIN);
    c.args(["snapshot", "--hook"]).env_remove("REQFORGE_REPO").env_remove("REQFORGE_TASK").env_remove("REQFORGE_PROJECT");
    if let Some(r) = repo {
        c.env("REQFORGE_REPO", r);
    }
    if let Some(t) = task {
        c.env("REQFORGE_TASK", t);
    }
    let mut child = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"SessionStart","source":"compact","session_id":"s"}"#).unwrap();
    let o = child.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string())
}

// reqforge: verifies REQ-0058#AC3
// reqforge: verifies REQ-0058#AC4
#[test]
fn snapshot_compact_hook() {
    // the plugin registers SessionStart/compact -> reqforge snapshot --hook
    let hooks: Value = serde_json::from_str(&std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../hooks/hooks.json")).unwrap()).unwrap();
    let ss = hooks["hooks"]["SessionStart"].as_array().unwrap();
    assert_eq!(ss.len(), 1);
    assert_eq!(ss[0]["matcher"], json!("compact"));
    assert_eq!(ss[0]["hooks"][0]["type"], json!("command"));
    assert!(ss[0]["hooks"][0]["command"].as_str().unwrap().ends_with("/bin/reqforge snapshot --hook"));

    let (_dir, store) = fx();
    // without REQFORGE_REPO, or without the file: nothing, exit 0
    assert_eq!(hook(None, None), (0, String::new()));
    assert_eq!(hook(Some(&store.root), None), (0, String::new()));
    let content = hot(&["Ship TASK-0042"], "2026-10-04");
    apply_snapshot(&store, &content);
    let (code, out) = hook(Some(&store.root), None);
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], json!("SessionStart"));
    assert_eq!(v["hookSpecificOutput"]["additionalContext"], json!(snapshot::context_block(&content)));
    // an agent run gets its next action back too
    seed_task(&store);
    let (_, out) = hook(Some(&store.root), Some("TASK-0001"));
    let ctx = serde_json::from_str::<Value>(out.trim()).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string();
    assert!(ctx.starts_with("## Next action (set 2026-10-01)\nRun pytest"), "{ctx}");
    assert!(ctx.ends_with(&snapshot::context_block(&content)));
    // a broken REQFORGE_REPO never fails the session
    assert_eq!(hook(Some(Path::new("/nonexistent/reqforge")), None), (0, String::new()));
}

// reqforge: verifies REQ-0058#AC3
#[test]
fn snapshot_resupply_system_prompt() {
    let _g = ENV.lock().unwrap_or_else(|p| p.into_inner());
    let (_dir, store) = fx();
    seed_task(&store);
    let content = hot(&["Ship TASK-0042"], "2026-10-04");
    apply_snapshot(&store, &content);
    let block = snapshot::context_block(&content);
    let runner = reqforge::chat::ChatRunner::new(store.root.clone(), &store.config_value());
    let sys = |a: Vec<String>| a[a.iter().position(|x| x == "--append-system-prompt").unwrap() + 1].clone();
    for (mode, expect) in [("system", true), ("hook", false)] {
        std::env::set_var("REQFORGE_SNAPSHOT_RESUPPLY", mode);
        assert_eq!(sys(runner.command_args(Some("sess-1"))).contains(&block), expect, "chat resumed turn, {mode}");
        assert_eq!(sys(runner.command_args(None)).contains(&block), expect, "chat first turn, {mode}");
        let agent = sys(reqforge::agent::command_args(&store, "TASK-0001"));
        assert_eq!(agent.contains(&block), expect, "agent, {mode}");
        assert_eq!(agent.contains("## Next action (set 2026-10-01)"), expect, "agent next action, {mode}");
    }
    std::env::remove_var("REQFORGE_SNAPSHOT_RESUPPLY");
    assert!(!sys(runner.command_args(Some("sess-1"))).contains(&block), "hook is the default");
}
