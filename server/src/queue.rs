//! Agent queue: auto-start eligible todo tasks through the coding-agent launcher, a few at a
//! time per project (docs/agent-runs.md, REQ-0053).

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::agent::{runs, AgentRunner};
use crate::model::{s, strs, Kind};
use crate::store::{now, Res, Source, Store, StoreError};

pub const DEFAULT_LIMIT: u64 = 2;

pub fn settings(store: &Store) -> Value {
    let q = store.config_value().get("agent_queue").cloned().unwrap_or(json!({}));
    json!({"enabled": q.get("enabled").and_then(Value::as_bool).unwrap_or(false),
           "limit": q.get("limit").and_then(Value::as_u64).unwrap_or(DEFAULT_LIMIT),
           "changed_by": q.get("changed_by").cloned().unwrap_or(Value::Null),
           "changed_at": q.get("changed_at").cloned().unwrap_or(Value::Null)})
}

/// Change the queue setting; turning it on or off needs `confirm` (the UI shows the eligible count first).
// reqforge: implements REQ-0053
pub fn set(store: &Store, enabled: Option<bool>, limit: Option<u64>, user: &str, confirm: bool) -> Res<Value> {
    let cur = settings(store);
    let new_enabled = enabled.unwrap_or(cur["enabled"].as_bool().unwrap_or(false));
    if new_enabled != cur["enabled"].as_bool().unwrap_or(false) && !confirm {
        return Err(StoreError::bad(format!(
            "turning the agent queue {} needs confirmation ({} eligible tasks)",
            if new_enabled { "on" } else { "off" },
            eligible(store, &[]).len()
        )));
    }
    let limit = limit.unwrap_or(cur["limit"].as_u64().unwrap_or(DEFAULT_LIMIT));
    if !(1..=8).contains(&limit) {
        return Err(StoreError::bad("limit must be an integer from 1 to 8"));
    }
    let mut patch = Map::new();
    patch.insert("agent_queue".into(), json!({"enabled": new_enabled, "limit": limit, "changed_by": user, "changed_at": now()}));
    store.save_config(&patch)?;
    Ok(settings(store))
}

/// Eligible todo tasks in start order (ascending id), excluding `running`.
// reqforge: implements REQ-0053
pub fn eligible(store: &Store, running: &[String]) -> Vec<String> {
    let reqs: std::collections::HashMap<String, String> =
        store.records(Kind::Requirements).iter().map(|r| (s(r, "id").to_string(), s(r, "status").to_string())).collect();
    let done: std::collections::HashSet<String> =
        store.records(Kind::Tasks).iter().filter(|t| s(t, "status") == "done").map(|t| s(t, "id").to_string()).collect();
    let mut out = vec![];
    for t in store.records(Kind::Tasks) {
        let id = s(&t, "id");
        if s(&t, "status") != "todo" || running.iter().any(|r| r == id) {
            continue;
        }
        let Ok(st) = store.get(Kind::Stories, s(&t, "story")) else { continue };
        let story_reqs = strs(&st, "requirements");
        if story_reqs.is_empty() || !story_reqs.iter().all(|r| reqs.get(*r).map(|x| x == "approved").unwrap_or(false)) {
            continue;
        }
        if !strs(&t, "depends_on").iter().all(|d| done.contains(*d)) {
            continue;
        }
        let comp = crate::codetrace::component_by_key(store, s(&st, "component"));
        if comp.map(|c| s(&c, "path").is_empty()).unwrap_or(true) {
            continue;
        }
        if !runs(store, id).is_empty() {
            continue; // a failed or cancelled run is never retried by the queue
        }
        out.push(id.to_string());
    }
    out.sort();
    out
}

pub fn view(store: &Store, runner: &AgentRunner) -> Value {
    let running = runner.running_tasks();
    let mut v = settings(store);
    v["running"] = json!(running);
    v["waiting"] = json!(eligible(store, &running));
    v
}

/// Start eligible tasks up to the limit; returns the started task ids. Runs continue in the background.
pub fn tick(store: &Arc<Store>, runner: &Arc<AgentRunner>, user: &str) -> Vec<String> {
    let st = settings(store);
    if st["enabled"] != json!(true) {
        return vec![];
    }
    let limit = st["limit"].as_u64().unwrap_or(DEFAULT_LIMIT) as usize;
    let running = runner.running_tasks();
    let free = limit.saturating_sub(running.len());
    let start: Vec<String> = eligible(store, &running).into_iter().take(free).collect();
    for task in &start {
        if !runner.reserve(task) {
            continue;
        }
        // queued runs act on behalf of whoever turned the queue on
        let owner = st["changed_by"].as_str().unwrap_or(user).to_string();
        let (r, s2, t, u) = (runner.clone(), store.clone(), task.clone(), format!("{owner} (queue)"));
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        tokio::spawn(async move { while rx.recv().await.is_some() {} }); // events are kept in the live buffer
        tokio::spawn(async move { r.run(s2, t, u, tx).await });
    }
    start
}
