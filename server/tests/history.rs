//! REQ-0062: session and agent-run history.
mod common;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Duration, TimeZone, Utc};
use common::agentfx::{self, git, rec};
use reqforge::changes;
use reqforge::history::{self, Entry};
use reqforge::model::Kind;
use reqforge::store::Store;
use serde_json::{json, Value};

// reqforge:off  (fake chat: secret prompt/reply text that must never reach the history)
const FAKE_CHAT: &str = r#"
prompt=$(cat)
echo '{"type":"system","subtype":"init","session_id":"hist-sess-1","mcp_servers":[{"name":"plugin:reqforge:reqforge","status":"connected"}]}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__plugin_reqforge_reqforge__propose_changeset","input":{"changeset":{"title":"TOOL-INPUT-SECRET","ops":[1]}}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\"changeset_id\": \"CS-0001\", \"note\": \"TOOL-OUTPUT-SECRET\"}"}]}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ASSISTANT-REPLY-SECRET"}]}}'
echo '{"type":"result","subtype":"success","session_id":"hist-sess-1","total_cost_usd":0.0,"num_turns":2,"is_error":false}'
"#;
// reqforge:on

/// One fake `claude` for the whole binary: the agent fixture's script for agent runs
/// (started with --permission-mode), the chat script above otherwise.
fn setup() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let root = agentfx::root();
        let bin = root.join("fake-claude-history");
        let script = format!(
            "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = \"--permission-mode\" ] && exec '{}' \"$@\"; done\n{FAKE_CHAT}",
            root.join("fake-claude").display()
        );
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("REQFORGE_CLAUDE_BIN", &bin);
    });
}

fn store(key: &str) -> Store {
    setup();
    let s = Store::init(agentfx::root().join(format!("hist-{}", key.to_lowercase())), key, key, None, true).unwrap();
    s.create(Kind::Requirements, &rec(json!({"title": "Answer", "type": "functional", "category": "core", "status": "approved",
        "statement": "The system shall answer 42.", "acceptance_criteria": [{"id": "AC1", "text": "returns 42"}]})), None).unwrap();
    s
}

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 4, 12, 0, 0).unwrap()
}

fn entry(key: &str, id: &str, start: DateTime<Utc>, mins: i64, outcome: &str) -> Entry {
    Entry {
        kind: if id.starts_with("RUN-") { "agent" } else { "chat" }.into(),
        id: id.into(),
        project: key.into(),
        user: "tester".into(),
        start: history::fmt(start),
        end: history::fmt(start + Duration::minutes(mins)),
        outcome: outcome.into(),
        ..Default::default()
    }
}

fn file(s: &Store) -> String {
    fs::read_to_string(s.root.join(history::FILE)).unwrap_or_default()
}

fn commits(root: &Path) -> usize {
    git(root, &["rev-list", "--count", "HEAD"]).parse().unwrap()
}

fn kinds(s: &Store, t: &str) -> Vec<Value> {
    history::read(&s.root).into_iter().filter(|v| v["type"] == json!(t)).collect()
}

const ENTRY_KEYS: [&str; 11] =
    ["type", "kind", "id", "project", "user", "start", "end", "outcome", "changesets_proposed", "changesets_applied", "records_touched"];

fn assert_metadata_only(v: &Value) {
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ENTRY_KEYS, "entry fields: {v}");
}

// ---------------------------------------------------------------- server helpers

fn serve(s: Store) -> (tokio::runtime::Runtime, u16) {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (addr, _) = rt.block_on(reqforge::api::serve(Arc::new(s), "127.0.0.1", 0)).unwrap();
    (rt, addr.port())
}

fn http(port: u16, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let req = ureq::request(method, &format!("http://127.0.0.1:{port}{path}"));
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => (r.status(), r.into_json().unwrap_or(Value::Null)),
        Err(ureq::Error::Status(code, r)) => (code, r.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("{e}"),
    }
}

fn chat(port: u16, body: Value) -> Vec<Value> {
    let text = ureq::post(&format!("http://127.0.0.1:{port}/api/chat")).send_json(body).unwrap().into_string().unwrap();
    text.lines().filter_map(|l| l.strip_prefix("data: ")).map(|l| serde_json::from_str(l).unwrap()).collect()
}

// ---------------------------------------------------------------- AC1

// reqforge: verifies REQ-0062#AC1
#[test]
fn chat_session_entry_has_metadata_and_no_conversation_text() {
    let s = store("HCHAT");
    let other = Store::open(&s.root).unwrap();
    changes::propose(&other, &json!({"title": "lower priority", "ops": [{"op": "update", "id": "REQ-0001", "patch": {"priority": "could"}}]})).unwrap();
    let (_rt, port) = serve(s);
    let evs = chat(port, json!({"chat_id": "c1", "message": "PROMPT-SECRET please", "context": {"selected": ["REQ-0001"]}}));
    assert!(evs.iter().any(|e| e["type"] == json!("changeset") && e["id"] == json!("CS-0001")), "{evs:?}");
    // second turn resumes the same session
    chat(port, json!({"chat_id": "c2", "message": "MESSAGE-SECRET again", "session_id": "hist-sess-1"}));
    changes::apply(&other, "CS-0001", &[]).unwrap();
    assert_eq!(file(&other), "", "nothing is written while the session is open");

    let (code, out) = http(port, "POST", "/api/chat/end", Some(json!({"session_id": "hist-sess-1"})));
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["ended"], json!(true));
    let es = kinds(&other, "entry");
    assert_eq!(es.len(), 1, "one entry per session, not per turn");
    let e = &es[0];
    assert_metadata_only(e);
    assert_eq!(e["kind"], json!("chat"));
    assert_eq!(e["id"], json!("hist-sess-1"));
    assert_eq!(e["project"], json!("HCHAT"));
    assert!(!e["user"].as_str().unwrap().is_empty());
    let (start, end) = (history::parse(e["start"].as_str().unwrap()).unwrap(), history::parse(e["end"].as_str().unwrap()).unwrap());
    assert!(start <= end);
    assert_eq!(e["outcome"], json!("applied"));
    assert_eq!(e["changesets_proposed"], json!(["CS-0001"]));
    assert_eq!(e["changesets_applied"], json!(["CS-0001"]));
    assert_eq!(e["records_touched"], json!(["REQ-0001"]));
    let raw = file(&other);
    for secret in ["PROMPT-SECRET", "MESSAGE-SECRET", "ASSISTANT-REPLY-SECRET", "TOOL-INPUT-SECRET", "TOOL-OUTPUT-SECRET", "please", "lower priority"] {
        assert!(!raw.contains(secret), "history stores conversation text {secret:?}: {raw}");
    }
    // ending again is a no-op
    assert_eq!(http(port, "POST", "/api/chat/end", Some(json!({"session_id": "hist-sess-1"}))).1["ended"], json!(false));
}

// reqforge: verifies REQ-0062#AC1
#[test]
fn agent_run_appends_a_metadata_only_entry_in_the_run_commit() {
    setup();
    let f = agentfx::fx("HAGENT", "Implement feature");
    let r = agentfx::result(&agentfx::run(&f));
    let es = kinds(&f.store, "entry");
    assert_eq!(es.len(), 1);
    let e = &es[0];
    assert_metadata_only(e);
    assert_eq!(e["kind"], json!("agent"));
    assert_eq!(e["id"], json!(r["run_id"]));
    assert_eq!((e["project"].clone(), e["user"].clone(), e["outcome"].clone()), (json!("HAGENT"), json!("tester"), json!("success")));
    assert_eq!(e["changesets_proposed"], json!([]));
    assert_eq!(e["changesets_applied"], json!([]));
    assert_eq!(e["records_touched"], json!(["TASK-0001"]));
    assert!(e["start"].as_str().unwrap() <= e["end"].as_str().unwrap());
    let raw = file(&f.store);
    for secret in ["Implemented feature", "Implement feature() in feature.py", "feature.py", "The system shall answer 42"] {
        assert!(!raw.contains(secret), "history stores run text {secret:?}");
    }
    let last = git(&f.store.root, &["show", "--name-only", "--format=%s", "HEAD"]);
    assert!(last.contains("agent run") && last.contains(history::FILE), "entry committed with the run log: {last}");
}

// ---------------------------------------------------------------- AC2

// reqforge: verifies REQ-0062#AC2
#[test]
fn history_is_append_only_and_compaction_is_one_commit_per_day() {
    let s = store("HAPPEND");
    let t = now();
    let mut before = String::new();
    for (i, (days, outcome)) in [(400, "applied"), (390, "discussed"), (100, "applied"), (2, "proposed")].iter().enumerate() {
        history::append(&s, &entry("HAPPEND", &format!("chat-{i}"), t - Duration::days(*days), 30, outcome)).unwrap();
        let after = file(&s);
        assert!(after.starts_with(&before) && after.len() > before.len(), "append rewrote earlier lines");
        before = after;
    }
    history::pause(&s, "tester", "on holiday", t - Duration::days(1)).unwrap();
    assert!(file(&s).starts_with(&before), "pause only appends");

    let c0 = commits(&s.root);
    let out = history::compact(&s, t).unwrap();
    assert_eq!(out["compacted"], json!(true), "{out}");
    assert_eq!(commits(&s.root), c0 + 1, "compaction makes exactly one commit");
    let after_compaction = file(&s);
    // a second run the same day does nothing, even with new old entries to fold
    history::append(&s, &entry("HAPPEND", "chat-late", t - Duration::days(380), 10, "applied")).unwrap();
    let c1 = commits(&s.root);
    let again = history::compact(&s, t + Duration::hours(6)).unwrap();
    assert_eq!(again["compacted"], json!(false));
    assert_eq!(commits(&s.root), c1);
    assert!(file(&s).starts_with(&after_compaction), "no rewrite on the second run of the day");
    // the next day it runs again
    let next = history::compact(&s, t + Duration::days(1)).unwrap();
    assert_eq!(next["compacted"], json!(true));
    assert_eq!(commits(&s.root), c1 + 1);
    // nothing to compact: no rewrite, no commit
    let s2 = store("HAPPEND2");
    history::append(&s2, &entry("HAPPEND2", "chat-new", t - Duration::days(3), 10, "applied")).unwrap();
    let (c2, f2) = (commits(&s2.root), file(&s2));
    assert_eq!(history::compact(&s2, t).unwrap()["compacted"], json!(false));
    assert_eq!((commits(&s2.root), file(&s2)), (c2, f2));
}

// ---------------------------------------------------------------- AC3

// reqforge: verifies REQ-0062#AC3
#[test]
fn old_entries_become_monthly_summaries_and_young_ones_stay() {
    let s = store("HCOMPACT");
    let t = now(); // 2026-10-04; cutoff 2025-10-04
    let at = |y, m, d| Utc.with_ymd_and_hms(y, m, d, 9, 0, 0).unwrap();
    let rows = [
        ("chat-a", at(2025, 8, 3), 30, "applied"),
        ("RUN-TASK-0001-a", at(2025, 8, 20), 90, "success"),
        ("chat-b", at(2025, 8, 21), 15, "discussed"),
        ("chat-c", at(2025, 9, 10), 60, "applied"),
        ("chat-d", at(2025, 10, 3), 20, "proposed"), // 366 days old
        ("chat-e", at(2025, 10, 5), 20, "proposed"), // 364 days old: kept
        ("RUN-TASK-0002-b", at(2026, 9, 30), 45, "failed"),
    ];
    for (id, start, mins, outcome) in rows {
        history::append(&s, &entry("HCOMPACT", id, start, mins, outcome)).unwrap();
    }
    let young_before: Vec<Value> = kinds(&s, "entry").into_iter().filter(|e| ["chat-e", "RUN-TASK-0002-b"].contains(&e["id"].as_str().unwrap())).collect();
    let gaps_before = kinds(&s, "gap");
    let out = history::compact(&s, t).unwrap();
    assert_eq!(out["entries"], json!(5));
    assert_eq!(out["months"], json!(["2025-08", "2025-09", "2025-10"]));

    let entries = kinds(&s, "entry");
    assert_eq!(entries, young_before, "0 entries younger than 365 days removed or changed");
    assert_eq!(kinds(&s, "gap"), gaps_before, "gap records are kept");
    let sums = kinds(&s, "summary");
    assert_eq!(sums.len(), 3);
    let aug = &sums[0];
    assert_eq!(aug["month"], json!("2025-08"));
    assert_eq!(aug["project"], json!("HCOMPACT"));
    assert_eq!(aug["sessions"], json!(3));
    assert_eq!((aug["chat_sessions"].clone(), aug["agent_runs"].clone()), (json!(2), json!(1)));
    assert_eq!(aug["duration_seconds"], json!((30 + 90 + 15) * 60));
    assert_eq!(aug["outcomes"], json!({"applied": 1, "success": 1, "discussed": 1}));
    assert_eq!((sums[1]["sessions"].clone(), sums[1]["duration_seconds"].clone()), (json!(1), json!(3600)));
    assert_eq!(sums[2]["outcomes"], json!({"proposed": 1}));
    assert!(!file(&s).contains("chat-a"), "compacted entries are gone");

    // a year on, chat-e crosses the line and merges into the existing October summary
    let out = history::compact(&s, t + Duration::days(3)).unwrap();
    assert_eq!(out["entries"], json!(1));
    let oct = kinds(&s, "summary").into_iter().find(|v| v["month"] == json!("2025-10")).unwrap();
    assert_eq!((oct["sessions"].clone(), oct["duration_seconds"].clone(), oct["outcomes"].clone()), (json!(2), json!(2400), json!({"proposed": 2})));
    assert_eq!(kinds(&s, "entry").len(), 1);
    assert_eq!(kinds(&s, "summary").len(), 3, "one summary per month");
}

// ---------------------------------------------------------------- AC4

// reqforge: verifies REQ-0062#AC4
#[test]
fn gaps_are_typed_deliberate_when_paused_with_a_reason_else_unexplained() {
    let s = store("HGAP");
    let t = now();
    history::append(&s, &entry("HGAP", "chat-1", t - Duration::days(60), 30, "applied")).unwrap();
    // 13 days later: no gap
    history::append(&s, &entry("HGAP", "chat-2", t - Duration::days(47), 30, "applied")).unwrap();
    assert!(kinds(&s, "gap").is_empty());
    // 20 quiet days, nobody paused: unexplained, recorded when the next session is appended
    let g = history::append(&s, &entry("HGAP", "chat-3", t - Duration::days(27), 30, "applied")).unwrap().expect("gap");
    assert_eq!((g["gap"].clone(), g["days"].clone(), g["pause_reason"].clone()), (json!("unexplained"), json!(19), json!("")));
    // pause with a reason, then 26 quiet days: deliberate
    assert_eq!(history::pause(&s, "tester", "  ", t - Duration::days(26)).unwrap_err().status, 400, "a reason is required");
    history::pause(&s, "tester", "waiting for\nlegal review", t - Duration::days(26)).unwrap();
    let pending = history::pending_gap(&s, t).expect("pending gap at session start");
    assert_eq!(pending["gap"], json!("deliberate"));
    assert_eq!(pending["pause_reason"], json!("waiting for legal review"));
    assert!(pending["days"].as_i64().unwrap() >= 26);
    // the user gives a reason at session start; it is recorded once
    let rec = history::record_gap(&s, "tester", "contract signed", t).unwrap();
    assert_eq!((rec["gap"].clone(), rec["reason"].clone()), (json!("deliberate"), json!("contract signed")));
    assert!(history::pending_gap(&s, t).is_none());
    assert_eq!(history::record_gap(&s, "tester", "again", t).unwrap_err().status, 409);
    // the session that follows does not record the same gap twice
    assert!(history::append(&s, &entry("HGAP", "chat-4", t, 30, "discussed")).unwrap().is_none());
    let gaps = kinds(&s, "gap");
    assert_eq!(gaps.iter().map(|g| g["gap"].as_str().unwrap()).collect::<Vec<_>>(), ["unexplained", "deliberate"]);
    // under 14 days since the last session: nothing pending
    assert!(history::pending_gap(&s, t + Duration::days(13)).is_none());
    // a pause from before the last session does not explain a later gap
    let later = t + Duration::days(40);
    assert_eq!(history::pending_gap(&s, later).unwrap()["gap"], json!("unexplained"));
}

// reqforge: verifies REQ-0062#AC4
#[test]
fn next_chat_session_start_shows_the_gap_and_takes_a_reason() {
    let s = store("HGAPAPI");
    history::append(&s, &entry("HGAPAPI", "chat-old", Utc::now() - Duration::days(20), 30, "discussed")).unwrap();
    let root = s.root.clone();
    let (_rt, port) = serve(s);
    let (_, g) = http(port, "GET", "/api/history/gap", None);
    assert_eq!(g["gap"]["gap"], json!("unexplained"));
    assert_eq!(g["gap"]["days"], json!(19));
    // a new chat session starts with a gap event
    let evs = chat(port, json!({"chat_id": "c1", "message": "hello"}));
    assert_eq!(evs[0]["type"], json!("gap"), "{evs:?}");
    assert_eq!(evs[0]["gap"]["days"], json!(19));
    // a resumed turn does not repeat it
    let evs2 = chat(port, json!({"chat_id": "c2", "message": "more", "session_id": "hist-sess-1"}));
    assert!(evs2.iter().all(|e| e["type"] != json!("gap")));
    // the user gives a reason; the gap is recorded and no longer pending
    assert_eq!(http(port, "POST", "/api/history/gap", Some(json!({"reason": "conference week"}))).0, 201);
    assert_eq!(http(port, "GET", "/api/history/gap", None).1["gap"], Value::Null);
    let view = http(port, "GET", "/api/history", None).1;
    assert_eq!(view["gaps"][0]["reason"], json!("conference week"));
    assert_eq!(view["gaps"][0]["gap"], json!("unexplained"));
    // pause action through the API
    assert_eq!(http(port, "POST", "/api/history/pause", Some(json!({"reason": ""}))).0, 400);
    assert_eq!(http(port, "POST", "/api/history/pause", Some(json!({"reason": "release freeze"}))).0, 201);
    assert_eq!(kinds(&Store::open(&root).unwrap(), "pause")[0]["reason"], json!("release freeze"));
}
