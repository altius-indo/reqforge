//! Task flow: starting work on a task from the UI.
//!
//! `start` moves a todo task to in-progress, and its story and epic along with it when they are
//! still todo, as one versioned commit. A task whose `depends_on` tasks are not all done cannot
//! start. `readiness` explains, for the UI, whether Start (and Start with agent) is possible.
//!
//! Each task also carries one next action (REQ-0059): `next_action` and the date it was set, and
//! a pending `NEXT:` proposal from the last agent run that the user accepts, edits or rejects.

use serde_json::{json, Value};

use crate::model::{s, strs, Kind, Rec};
use crate::store::{now, Res, Source, Store, StoreError};

/// Dependencies of a task that are not done yet: [(id, status, title)].
pub fn unfinished_dependencies(store: &Store, task: &Rec) -> Vec<Value> {
    strs(task, "depends_on")
        .into_iter()
        .map(|d| match store.get(Kind::Tasks, d) {
            Ok(t) => json!({"id": d, "status": s(&t, "status"), "title": s(&t, "title")}),
            Err(_) => json!({"id": d, "status": "missing", "title": ""}),
        })
        .filter(|v| v["status"] != json!("done"))
        .collect()
}

/// Whether the task can be started by hand and by a coding agent, with the reasons when not.
pub fn readiness(store: &Store, id: &str) -> Res<Value> {
    let task = store.get(Kind::Tasks, id)?;
    let unfinished = unfinished_dependencies(store, &task);
    let mut start_reasons = vec![];
    if s(&task, "status") != "todo" {
        start_reasons.push(format!("task is {}, only todo tasks can be started", s(&task, "status")));
    }
    if !unfinished.is_empty() {
        let ids: Vec<String> = unfinished.iter().map(|u| format!("{} ({})", u["id"].as_str().unwrap_or(""), u["status"].as_str().unwrap_or(""))).collect();
        start_reasons.push(format!("waiting for {}", ids.join(", ")));
    }
    let story = store.get(Kind::Stories, s(&task, "story")).ok();
    let comp_key = story.as_ref().map(|st| s(st, "component").to_string()).unwrap_or_default();
    let comp = if comp_key.is_empty() { None } else { crate::codetrace::component_by_key(store, &comp_key) };
    let mut agent_reasons = vec![];
    if comp_key.is_empty() {
        agent_reasons.push("the story has no component".to_string());
    } else if comp.is_none() {
        agent_reasons.push(format!("component '{comp_key}' is not defined"));
    } else if s(comp.as_ref().unwrap(), "path").is_empty() {
        agent_reasons.push(format!("component '{comp_key}' has no local path"));
    }
    if !unfinished.is_empty() {
        agent_reasons.push(start_reasons.last().cloned().unwrap_or_default());
    }
    if s(&task, "status") == "done" {
        agent_reasons.push("task is done".into());
    }
    Ok(json!({"task": id, "status": s(&task, "status"), "version": task.get("version"), "unfinished": unfinished,
              "can_start": start_reasons.is_empty(), "start_reasons": start_reasons,
              "can_start_agent": agent_reasons.is_empty(), "agent_reasons": agent_reasons, "component": comp_key}))
}

/// Start a todo task: task, and its todo story and epic, become in-progress in one commit.
// reqforge: implements REQ-0050
pub fn start(store: &Store, id: &str, expected_version: Option<i64>) -> Res<Value> {
    let _g = store.lock()?;
    let task = store.get(Kind::Tasks, id)?;
    let cur_v = task.get("version").and_then(Value::as_i64).unwrap_or(0);
    if let Some(ev) = expected_version {
        if ev != cur_v {
            return Err(StoreError::new(format!("{id} was modified (version {cur_v}, you had {ev}); reload and retry"), 409));
        }
    }
    if s(&task, "status") != "todo" {
        return Err(StoreError::new(format!("{id} is {}, only todo tasks can be started", s(&task, "status")), 409));
    }
    let unfinished = unfinished_dependencies(store, &task);
    if !unfinished.is_empty() {
        let ids: Vec<&str> = unfinished.iter().filter_map(|u| u["id"].as_str()).collect();
        return Err(StoreError::with(format!("{id} is blocked by unfinished dependencies: {}", ids.join(", ")), 409, unfinished));
    }
    let progress = |kind: Kind, rid: &str| -> Res<Option<Rec>> {
        let r = store.get(kind, rid)?;
        if s(&r, "status") != "todo" {
            return Ok(None); // blocked/done/in-progress parents are left as they are
        }
        let mut patch = Rec::new();
        patch.insert("status".into(), json!("in-progress"));
        Ok(Some(store.apply_unlocked(kind, rid, &patch, None, None, None)?))
    };
    let mut changed = vec![];
    let task_new = progress(Kind::Tasks, id)?.expect("todo task");
    let story_new = if s(&task, "story").is_empty() { None } else { progress(Kind::Stories, s(&task, "story"))? };
    let epic_id = store.get(Kind::Stories, s(&task, "story")).map(|st| s(&st, "epic").to_string()).unwrap_or_default();
    let epic_new = if epic_id.is_empty() { None } else { progress(Kind::Epics, &epic_id)? };
    store.write_unlocked(Kind::Tasks, &task_new)?;
    changed.push(id.to_string());
    if let Some(st) = &story_new {
        store.write_unlocked(Kind::Stories, st)?;
        changed.push(s(st, "id").to_string());
    }
    if let Some(ep) = &epic_new {
        store.write_unlocked(Kind::Epics, ep)?;
        changed.push(s(ep, "id").to_string());
    }
    store.commit(&format!("{id}: start ({} -> in-progress)", changed.join(", ")));
    Ok(json!({"task": Value::Object(task_new), "changed": changed, "at": now()}))
}

pub fn tasks_of_story(store: &Store, story: &str) -> Vec<String> {
    store.records(Kind::Tasks).iter().filter(|t| s(t, "story") == story).map(|t| s(t, "id").to_string()).collect()
}

/// The task's next action, shown first in a brief or a task-focused chat; None when it has none.
/// Reads `next_action` and `next_action_set` (REQ-0059#AC1).
pub fn next_action_block(task: &Rec) -> Option<String> {
    let text = s(task, "next_action").trim();
    if text.is_empty() {
        return None;
    }
    let set = s(task, "next_action_set");
    let date = if set.is_empty() { String::new() } else { format!(" (set {})", set.get(..10).unwrap_or(set)) };
    Some(format!("## Next action{date}\n{text}"))
}

/// Keep `next_action_set` in step with `next_action`: when the next action changes and the write
/// does not set the date itself, stamp today's date (or clear it with the action).
// reqforge: implements REQ-0059
pub fn stamp_next_action(prev: Option<&Rec>, rec: &mut Rec, date_given: bool) {
    let old = prev.map(|p| s(p, "next_action").trim().to_string()).unwrap_or_default();
    let new = s(rec, "next_action").trim().to_string();
    if old == new || date_given {
        return;
    }
    let date = if new.is_empty() { Value::Null } else { json!(crate::snapshot::today().to_string()) };
    rec.insert("next_action_set".into(), date);
}

/// The `NEXT:` line of an agent's final message (the last one, if several), without the prefix.
pub fn next_line(message: &str) -> Option<String> {
    message
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix("NEXT:"))
        .map(|t| t.trim().to_string())
        .rfind(|t| !t.is_empty())
}

/// Record a `NEXT:` line from an agent run's final message as the task's pending proposal
/// (REQ-0059#AC2). The caller holds the store lock and commits; returns the proposal, if any.
// reqforge: implements REQ-0059
pub fn propose_next_unlocked(store: &Store, task_id: &str, run_id: &str, final_message: &str) -> Res<Option<String>> {
    let Some(text) = next_line(final_message) else { return Ok(None) };
    let mut patch = Rec::new();
    patch.insert("next_action_proposal".into(), json!(text));
    patch.insert("next_action_proposal_run".into(), json!(run_id));
    let rec = store.apply_unlocked(Kind::Tasks, task_id, &patch, None, None, None)?;
    store.write_unlocked(Kind::Tasks, &rec)?;
    Ok(Some(text))
}

/// Accept, edit or reject the task's pending next-action proposal (REQ-0059#AC2). Accept and
/// edit make it the next action, dated today; all three clear the proposal.
// reqforge: implements REQ-0059
pub fn resolve_next_proposal(store: &Store, id: &str, action: &str, text: Option<&str>, expected_version: Option<i64>) -> Res<Value> {
    if !["accept", "edit", "reject"].contains(&action) {
        return Err(StoreError::bad(format!("action: '{action}' not in ['accept', 'edit', 'reject']")));
    }
    let _g = store.lock()?;
    let task = store.get(Kind::Tasks, id)?;
    let proposal = s(&task, "next_action_proposal").trim().to_string();
    if proposal.is_empty() {
        return Err(StoreError::new(format!("{id} has no pending next action proposal"), 409));
    }
    let chosen = match action {
        "accept" => Some(proposal.clone()),
        "edit" => Some(text.map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| StoreError::bad("text required to edit the proposal"))?.to_string()),
        _ => None,
    };
    let mut patch = Rec::new();
    if let Some(t) = &chosen {
        patch.insert("next_action".into(), json!(t));
        patch.insert("next_action_set".into(), json!(crate::snapshot::today().to_string()));
    }
    patch.insert("next_action_proposal".into(), Value::Null);
    patch.insert("next_action_proposal_run".into(), Value::Null);
    let rec = store.apply_unlocked(Kind::Tasks, id, &patch, expected_version, None, None)?;
    store.write_unlocked(Kind::Tasks, &rec)?;
    let verb = match action {
        "accept" => "accepted",
        "edit" => "edited",
        _ => "rejected",
    };
    store.commit(&format!("{id}: next action proposal {verb}"));
    Ok(json!({"task": Value::Object(rec), "action": action, "proposal": proposal}))
}
