//! REQ-0051: start a task with a coding agent.
mod common;
use common::agentfx::*;
use reqforge::model::Kind;
use serde_json::json;

// reqforge: verifies REQ-0051#AC2
// reqforge: verifies REQ-0051#AC5
#[test]
fn agent_runs_in_a_task_worktree_and_reports_its_branch() {
    let f = fx("RUNA", "Implement feature");
    let evs = run(&f);
    let first = &evs[0];
    assert_eq!(first["type"], json!("run"), "{evs:?}");
    assert_eq!(first["branch"], json!("reqforge/TASK-0001"));
    assert_eq!(first["task_started"], json!(true));
    let wt = worktree(&f);
    let cwd = std::fs::read_to_string(wt.join("agent-cwd.txt")).unwrap();
    assert_eq!(std::fs::canonicalize(cwd.trim()).unwrap(), std::fs::canonicalize(&wt).unwrap(), "agent ran in the worktree");
    assert_eq!(git(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), "reqforge/TASK-0001");
    let r = result(&evs);
    assert_eq!(r["exit_status"], json!(0));
    assert_eq!(r["branch"], json!("reqforge/TASK-0001"));
    assert_eq!(r["commits"].as_array().unwrap().len(), 1);
    assert_eq!(r["commits"][0]["message"], json!("TASK-0001: implement feature"));
    assert_eq!(r["violations"], json!([]));
    assert!(evs.iter().any(|e| e["type"] == json!("text") && e["text"].as_str().unwrap().contains("Implemented")));
    // never auto-done: the task was started (todo -> in-progress) and stays there
    assert_eq!(r["task_status"], json!("in-progress"));
    assert_eq!(f.store.get(Kind::Tasks, "TASK-0001").unwrap()["status"], json!("in-progress"));
    // main checkout untouched; re-running reuses the worktree and branch
    assert_eq!(git(&f.code, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    let again = result(&run(&f));
    assert_eq!(again["exit_status"], json!(0));
    assert_eq!(reqforge::agent::runs(&f.store, "TASK-0001").len(), 2);
}

// reqforge: verifies REQ-0051#AC3
#[test]
fn brief_contains_task_story_requirements_and_conventions() {
    let f = fx("RUNB", "Implement feature");
    let b = reqforge::agent::brief(&f.store, "TASK-0001").unwrap();
    for needle in [
        "Task TASK-0001: Implement feature", "Implement feature() in feature.py.", "pytest tests/test_feature.py passes",
        "Story STORY-0001: Answer story", "so that I can stop asking", "REQ-0001: Answer", "The system shall answer 42.",
        "REQ-0001#AC1: feature() returns 42", "E1 (unit): `pytest tests/test_feature.py`", "reqforge: implements REQ-XXXX",
        "reqforge: verifies REQ-XXXX#ACn", "Do not push",
    ] {
        assert!(b.contains(needle), "brief misses {needle:?}:\n{b}");
    }
}

// reqforge: verifies REQ-0051#AC6
#[test]
fn agent_start_is_disabled_with_reasons() {
    let f = fx("RUNC", "Implement feature");
    let ok = reqforge::agent::plan(&f.store, "TASK-0001").unwrap();
    assert_eq!(ok["ready"], json!(true));
    assert!(ok["brief"].as_str().unwrap().contains("TASK-0001"));
    assert_eq!(ok["branch"], json!("reqforge/TASK-0001"));
    // unfinished dependency
    f.store.create(Kind::Tasks, &rec(json!({"title": "first", "story": "STORY-0001", "kind": "design"})), None).unwrap();
    f.store.update(Kind::Tasks, "TASK-0001", &rec(json!({"depends_on": ["TASK-0002"]})), None, None).unwrap();
    let p = reqforge::agent::plan(&f.store, "TASK-0001").unwrap();
    assert_eq!(p["ready"], json!(false));
    assert!(p["reasons"][0].as_str().unwrap().contains("waiting for TASK-0002"));
    let evs = run(&f);
    assert!(evs[0]["text"].as_str().unwrap().contains("cannot start an agent"), "{evs:?}");
    // component without a path, then a story without a component
    f.store.update(Kind::Tasks, "TASK-0001", &rec(json!({"depends_on": []})), None, None).unwrap();
    f.store.update(Kind::Components, "COMP-0001", &rec(json!({"path": ""})), None, None).unwrap();
    assert_eq!(reqforge::agent::plan(&f.store, "TASK-0001").unwrap()["reasons"], json!(["component 'code' has no local path"]));
    f.store.update(Kind::Stories, "STORY-0001", &rec(json!({"component": ""})), None, None).unwrap();
    assert_eq!(reqforge::agent::plan(&f.store, "TASK-0001").unwrap()["reasons"], json!(["the story has no component"]));
}

// reqforge: verifies REQ-0051#AC4
#[test]
fn a_running_agent_can_be_cancelled() {
    let f = fx("RUND", "Implement feature SLOW");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let evs = rt.block_on(async {
        let runner = std::sync::Arc::new(reqforge::agent::AgentRunner::default());
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let (r2, store) = (runner.clone(), f.store.clone());
        let h = tokio::spawn(async move { r2.run(store, "TASK-0001".into(), "tester".into(), tx).await });
        let mut out = vec![];
        while let Some(ev) = rx.recv().await {
            if ev["type"] == json!("session") {
                assert!(runner.cancel("TASK-0001"));
            }
            out.push(ev);
        }
        h.await.unwrap();
        out
    });
    assert_eq!(result(&evs)["exit_status"], json!("cancelled"));
}

// reqforge: verifies REQ-0051#AC5
#[test]
fn runs_past_the_time_limit_are_stopped() {
    let f = fx("RUNE", "Implement feature SLOW");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let evs = rt.block_on(async {
        let mut runner = reqforge::agent::AgentRunner::default();
        runner.timeout = std::time::Duration::from_millis(1500);
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let store = f.store.clone();
        let h = tokio::spawn(async move { runner.run(store, "TASK-0001".into(), "tester".into(), tx).await });
        let mut out = vec![];
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        h.await.unwrap();
        out
    });
    assert_eq!(result(&evs)["exit_status"], json!("timeout"));
    assert!(evs.iter().any(|e| e["text"].as_str().is_some_and(|t| t.contains("time limit"))));
    assert_eq!(reqforge::agent::runs(&f.store, "TASK-0001")[0]["exit_status"], json!("timeout"));
}
