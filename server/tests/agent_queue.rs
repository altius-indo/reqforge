//! REQ-0053: the per-project agent queue.
mod common;
use std::sync::Arc;

use common::agentfx::*;
use reqforge::agent::AgentRunner;
use reqforge::model::Kind;
use reqforge::queue;
use serde_json::json;

fn status(f: &Fx, id: &str) -> String {
    f.store.get(Kind::Tasks, id).unwrap()["status"].as_str().unwrap().to_string()
}

// reqforge: verifies REQ-0053#AC1
#[test]
fn queue_is_off_by_default_and_toggling_needs_confirmation() {
    let f = fx("QUEA", "Implement feature");
    let st = queue::settings(&f.store);
    assert_eq!((st["enabled"].clone(), st["limit"].clone()), (json!(false), json!(2)));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    let runner = Arc::new(AgentRunner::default());
    assert!(queue::tick(&f.store, &runner, "tester").is_empty(), "off by default: nothing starts");
    let e = queue::set(&f.store, Some(true), None, "alice", false).unwrap_err();
    assert!(e.message.contains("needs confirmation (1 eligible tasks)"), "{}", e.message);
    let on = queue::set(&f.store, Some(true), Some(3), "alice", true).unwrap();
    assert_eq!((on["enabled"].clone(), on["limit"].clone(), on["changed_by"].clone()), (json!(true), json!(3), json!("alice")));
    assert!(on["changed_at"].as_str().unwrap().starts_with("20"));
    assert!(queue::set(&f.store, None, Some(9), "alice", true).is_err(), "limit is 1..8");
    // the setting is per project
    let other = fx("QUEB", "Implement feature");
    assert_eq!(queue::settings(&other.store)["enabled"], json!(false));
}

// reqforge: verifies REQ-0053#AC2
#[test]
fn only_eligible_tasks_are_queued() {
    let f = fx("QUEC", "Implement feature");
    assert_eq!(queue::eligible(&f.store, &[]), vec!["TASK-0001"]);
    let blocked = add_task(&f, "after one", json!(["TASK-0001"]));
    assert_eq!(queue::eligible(&f.store, &[]), vec!["TASK-0001"], "{blocked} waits for its dependency");
    f.store.update(Kind::Tasks, "TASK-0001", &common::agentfx::rec(json!({"status": "done"})), None, None).unwrap();
    assert_eq!(queue::eligible(&f.store, &[]), vec![blocked.clone()]);
    // a story requirement that is not approved makes its tasks ineligible
    f.store.update(Kind::Requirements, "REQ-0001", &common::agentfx::rec(json!({"status": "proposed"})), None, None).unwrap();
    assert!(queue::eligible(&f.store, &[]).is_empty());
    f.store.update(Kind::Requirements, "REQ-0001", &common::agentfx::rec(json!({"status": "approved"})), None, None).unwrap();
    // a component without a path makes them ineligible too
    f.store.update(Kind::Components, "COMP-0001", &common::agentfx::rec(json!({"path": ""})), None, None).unwrap();
    assert!(queue::eligible(&f.store, &[]).is_empty());
}

// reqforge: verifies REQ-0053#AC3
// reqforge: verifies REQ-0053#AC4
#[test]
fn concurrency_limit_and_start_order() {
    let f = fx("QUED", "Implement feature SLOW");
    let t2 = add_task(&f, "second SLOW", json!([]));
    let t3 = add_task(&f, "third", json!([]));
    queue::set(&f.store, Some(true), Some(2), "alice", true).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    let runner = Arc::new(AgentRunner::default());
    let started = queue::tick(&f.store, &runner, "alice");
    assert_eq!(started, vec!["TASK-0001".to_string(), t2.clone()], "ascending id order, up to the limit");
    assert!(queue::tick(&f.store, &runner, "alice").is_empty(), "a second tick never exceeds the limit");
    assert!(runner.running_tasks().len() <= 2);
    // queued runs are ordinary agent runs: task in-progress, task branch, live progress
    assert!(wait_until(|| status(&f, "TASK-0001") == "in-progress", 10));
    assert!(wait_until(|| runner.live("TASK-0001", 0)["events"].as_array().unwrap().iter().any(|e| e["type"] == json!("run")), 10));
    assert_eq!(runner.live("TASK-0001", 0)["events"][0]["branch"], json!("reqforge/TASK-0001"));
    let view = queue::view(&f.store, &runner);
    assert_eq!(view["running"], json!(["TASK-0001", t2.clone()]));
    assert_eq!(view["waiting"], json!([t3.clone()]));
    // when a run ends the next eligible task starts on the next tick (ticks run every 5 s, well within 30 s)
    assert!(runner.cancel("TASK-0001"));
    assert!(wait_until(|| !runner.running("TASK-0001"), 10));
    assert_eq!(queue::tick(&f.store, &runner, "alice"), vec![t3.clone()]);
    runner.cancel(&t2);
    runner.cancel(&t3);
    assert!(wait_until(|| runner.running_tasks().is_empty(), 15));
}

// reqforge: verifies REQ-0053#AC5
#[test]
fn failed_runs_are_not_retried_and_off_starts_nothing() {
    let f = fx("QUEE", "Implement feature FAIL");
    queue::set(&f.store, Some(true), Some(2), "alice", true).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _g = rt.enter();
    let runner = Arc::new(AgentRunner::default());
    assert_eq!(queue::tick(&f.store, &runner, "alice"), vec!["TASK-0001"]);
    assert!(wait_until(|| !runner.running("TASK-0001") && !reqforge::agent::runs(&f.store, "TASK-0001").is_empty(), 15));
    assert_eq!(reqforge::agent::runs(&f.store, "TASK-0001")[0]["exit_status"], json!(1));
    // even if someone resets the task to todo, the queue does not retry it
    f.store.update(Kind::Tasks, "TASK-0001", &common::agentfx::rec(json!({"status": "todo"})), None, None).unwrap();
    assert!(queue::tick(&f.store, &runner, "alice").is_empty());
    // turning the queue off starts nothing new and leaves active runs alone
    let t2 = add_task(&f, "slow one SLOW", json!([]));
    assert_eq!(queue::tick(&f.store, &runner, "alice"), vec![t2.clone()]);
    let _t3 = add_task(&f, "waiting", json!([]));
    queue::set(&f.store, Some(false), None, "alice", true).unwrap();
    assert!(queue::tick(&f.store, &runner, "alice").is_empty());
    assert!(runner.running(&t2), "active run keeps running after the queue is turned off");
    runner.cancel(&t2);
    assert!(wait_until(|| runner.running_tasks().is_empty(), 15));
}
