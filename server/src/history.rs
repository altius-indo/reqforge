//! Session and agent-run history (REQ-0062): `history/sessions.jsonl` in the requirements repo.
//!
//! One JSON object per line, appended and never edited:
//!   {"type":"entry", kind: chat|agent, id, project, user, start, end, outcome,
//!    changesets_proposed, changesets_applied, records_touched}
//!   {"type":"pause", project, user, at, reason}        the project was paused on purpose
//!   {"type":"gap", project, from, to, days, gap: deliberate|unexplained, pause_reason, reason, user, at}
//!   {"type":"summary", month, project, sessions, chat_sessions, agent_runs, duration_seconds, outcomes}
//!   {"type":"compaction", date}
//! Entries are built from a fixed field list (`Entry`), never from prompts, messages or tool
//! output. Compaction is the only rewrite: at most once a day, one commit, and only entries
//! older than 365 days are folded into monthly summaries.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::store::{Res, Store, StoreError};

pub const FILE: &str = "history/sessions.jsonl";
/// a pause between sessions this long or longer is a gap
pub const GAP_DAYS: i64 = 14;
/// entries are kept this long, then compacted
pub const KEEP_DAYS: i64 = 365;

/// One chat session or agent run. Metadata only: there is deliberately no free-text field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub kind: String,
    pub id: String,
    pub project: String,
    pub user: String,
    pub start: String,
    pub end: String,
    pub outcome: String,
    pub changesets_proposed: Vec<String>,
    pub changesets_applied: Vec<String>,
    pub records_touched: Vec<String>,
}

pub fn fmt(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

pub fn parse(t: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&Utc))
}

fn project(store: &Store) -> String {
    store.config_value()["key"].as_str().unwrap_or("").to_string()
}

fn ty(v: &Value) -> &str {
    v.get("type").and_then(Value::as_str).unwrap_or("")
}

fn st<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Every line of the history, oldest first; unreadable lines are skipped.
pub fn read(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join(FILE))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

pub fn entries(root: &Path) -> Vec<Entry> {
    read(root).into_iter().filter(|v| ty(v) == "entry").filter_map(|v| serde_json::from_value(v).ok()).collect()
}

fn append_line(root: &Path, v: &Value) -> Res<()> {
    let p = root.join(FILE);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| StoreError::bad(e.to_string()))?;
    let mut f = OpenOptions::new().create(true).append(true).open(&p).map_err(|e| StoreError::bad(e.to_string()))?;
    f.write_all(format!("{v}\n").as_bytes()).map_err(|e| StoreError::bad(e.to_string()))
}

fn entry_line(e: &Entry) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("entry"));
    if let Value::Object(o) = serde_json::to_value(e).unwrap_or_default() {
        m.extend(o);
    }
    Value::Object(m)
}

/// The latest entry by end time: where the next gap would start.
fn last_entry(lines: &[Value]) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    lines
        .iter()
        .filter(|v| ty(v) == "entry")
        .filter_map(|v| {
            let start = parse(st(v, "start"))?;
            Some((start, parse(st(v, "end")).unwrap_or(start)))
        })
        .max_by_key(|(_, end)| *end)
}

/// deliberate when the project was paused with a reason after the last session began, else unexplained
fn classify(lines: &[Value], since: DateTime<Utc>, to: DateTime<Utc>) -> (&'static str, String) {
    let pause = lines
        .iter()
        .rev()
        .filter(|v| ty(v) == "pause" && !st(v, "reason").trim().is_empty())
        .find(|v| parse(st(v, "at")).is_some_and(|t| t >= since && t <= to));
    match pause {
        Some(p) => ("deliberate", st(p, "reason").to_string()),
        None => ("unexplained", String::new()),
    }
}

fn gap_between(lines: &[Value], to: DateTime<Utc>) -> Option<Value> {
    let (last_start, from) = last_entry(lines)?;
    let days = (to - from).num_days();
    if days < GAP_DAYS {
        return None;
    }
    let from_s = fmt(from);
    if lines.iter().any(|v| ty(v) == "gap" && st(v, "from") == from_s) {
        return None;
    }
    let (kind, pause_reason) = classify(lines, last_start, to);
    Some(json!({"from": from_s, "to": fmt(to), "days": days, "gap": kind, "pause_reason": pause_reason}))
}

/// The gap (14 days or more) between the last session and `now` that has not been recorded yet:
/// what the next session start shows.
// reqforge: implements REQ-0062
pub fn pending_gap(store: &Store, now: DateTime<Utc>) -> Option<Value> {
    gap_between(&read(&store.root), now)
}

/// Append one entry (caller holds the store lock and commits). A gap before it that nobody
/// recorded at session start is recorded first, typed deliberate or unexplained.
// reqforge: implements REQ-0062
pub fn append_unlocked(store: &Store, e: &Entry) -> Res<Option<Value>> {
    let lines = read(&store.root);
    let gap = parse(&e.start).and_then(|start| gap_between(&lines, start)).map(|mut g| {
        g["user"] = json!(e.user);
        g["reason"] = json!("");
        g["at"] = json!(e.start);
        gap_line(&e.project, g)
    });
    if let Some(g) = &gap {
        append_line(&store.root, g)?;
    }
    append_line(&store.root, &entry_line(e))?;
    Ok(gap)
}

pub fn append(store: &Store, e: &Entry) -> Res<Option<Value>> {
    let _g = store.lock()?;
    let gap = append_unlocked(store, e)?;
    store.commit(&format!("reqforge: history — {} {}", e.kind, e.id));
    Ok(gap)
}

fn gap_line(project: &str, g: Value) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("gap"));
    m.insert("project".into(), json!(project));
    m.extend(g.as_object().cloned().unwrap_or_default());
    Value::Object(m)
}

fn clean(reason: &str) -> Res<String> {
    let r = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    if r.is_empty() {
        return Err(StoreError::bad("reason required"));
    }
    Ok(r.chars().take(280).collect())
}

/// Pause the project with a reason: the next gap is recorded as deliberate.
// reqforge: implements REQ-0062
pub fn pause(store: &Store, user: &str, reason: &str, now: DateTime<Utc>) -> Res<Value> {
    let reason = clean(reason)?;
    let _g = store.lock()?;
    let v = json!({"type": "pause", "project": project(store), "user": user, "at": fmt(now), "reason": reason});
    append_line(&store.root, &v)?;
    store.commit("reqforge: history — project paused");
    Ok(v)
}

/// Record the pending gap at session start, with the user's reason for it.
// reqforge: implements REQ-0062
pub fn record_gap(store: &Store, user: &str, reason: &str, now: DateTime<Utc>) -> Res<Value> {
    let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(280).collect::<String>();
    let _g = store.lock()?;
    let mut g = gap_between(&read(&store.root), now).ok_or_else(|| StoreError::new("no unrecorded gap of 14 days or more", 409))?;
    g["user"] = json!(user);
    g["reason"] = json!(reason);
    g["at"] = json!(fmt(now));
    let v = gap_line(&project(store), g);
    append_line(&store.root, &v)?;
    store.commit(&format!("reqforge: history — {} gap of {} days", v["gap"].as_str().unwrap_or(""), v["days"]));
    Ok(v)
}

fn add_entry(sum: &mut Value, e: &Value) {
    let secs = match (parse(st(e, "start")), parse(st(e, "end"))) {
        (Some(a), Some(b)) if b > a => (b - a).num_seconds(),
        _ => 0,
    };
    let bump = |v: &mut Value, n: i64| *v = json!(v.as_i64().unwrap_or(0) + n);
    bump(&mut sum["sessions"], 1);
    bump(&mut sum[if st(e, "kind") == "agent" { "agent_runs" } else { "chat_sessions" }], 1);
    bump(&mut sum["duration_seconds"], secs);
    let o = if st(e, "outcome").is_empty() { "unknown" } else { st(e, "outcome") };
    bump(&mut sum["outcomes"][o], 1);
}

/// Replace entries older than 365 days with one summary per month. Runs at most once per day
/// (a `compaction` marker records the day), rewrites the file once and makes one commit.
// reqforge: implements REQ-0062
pub fn compact(store: &Store, now: DateTime<Utc>) -> Res<Value> {
    let _g = store.lock()?;
    let lines = read(&store.root);
    let today = now.format("%Y-%m-%d").to_string();
    if lines.iter().any(|v| ty(v) == "compaction" && st(v, "date") == today) {
        return Ok(json!({"compacted": false, "reason": "history was already compacted today", "date": today}));
    }
    let cutoff = now - Duration::days(KEEP_DAYS);
    let is_old = |v: &Value| {
        ty(v) == "entry" && parse(if st(v, "end").is_empty() { st(v, "start") } else { st(v, "end") }).is_some_and(|t| t < cutoff)
    };
    let old: Vec<&Value> = lines.iter().filter(|v| is_old(v)).collect();
    if old.is_empty() {
        return Ok(json!({"compacted": false, "reason": "no entries older than 365 days", "date": today}));
    }
    let pkey = project(store);
    let mut months: BTreeMap<String, Value> = lines.iter().filter(|v| ty(v) == "summary").map(|v| (st(v, "month").to_string(), v.clone())).collect();
    for e in &old {
        let month = st(e, "start").get(..7).unwrap_or("unknown").to_string();
        let sum = months.entry(month.clone()).or_insert_with(|| {
            json!({"type": "summary", "month": month, "project": pkey, "sessions": 0, "chat_sessions": 0, "agent_runs": 0,
                   "duration_seconds": 0, "outcomes": {}})
        });
        add_entry(sum, e);
    }
    let kept = lines.iter().filter(|v| !is_old(v) && !matches!(ty(v), "summary" | "compaction"));
    let mut out: Vec<Value> = months.values().cloned().collect();
    out.extend(kept.cloned());
    out.push(json!({"type": "compaction", "date": today, "entries": old.len()}));
    let body: String = out.iter().map(|v| format!("{v}\n")).collect();
    let p = store.root.join(FILE);
    let tmp = p.with_extension("jsonl.tmp");
    fs::write(&tmp, body).map_err(|e| StoreError::bad(e.to_string()))?;
    fs::rename(&tmp, &p).map_err(|e| StoreError::bad(e.to_string()))?;
    let touched: Vec<String> = old.iter().map(|e| st(e, "start").get(..7).unwrap_or("unknown").to_string()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    store.commit(&format!("reqforge: compact history — {} entries older than {KEEP_DAYS} days into {} monthly summaries", old.len(), touched.len()));
    Ok(json!({"compacted": true, "date": today, "entries": old.len(), "months": touched}))
}

/// Everything the history view needs.
pub fn view(store: &Store, now: DateTime<Utc>) -> Value {
    let lines = read(&store.root);
    let pick = |t: &str| lines.iter().filter(|v| ty(v) == t).cloned().collect::<Vec<_>>();
    json!({"entries": pick("entry"), "summaries": pick("summary"), "gaps": pick("gap"), "pauses": pick("pause"),
           "pending_gap": gap_between(&lines, now)})
}

/// Build the entry for a finished chat session from its tracked metadata and the changesets it proposed.
// reqforge: implements REQ-0062
pub fn chat_entry(store: &Store, s: &crate::chat::ChatSession, user: &str) -> Entry {
    let mut applied = vec![];
    let mut touched = std::collections::BTreeSet::new();
    for id in &s.proposed {
        if let Ok(cs) = crate::changes::get(store, id) {
            if cs["status"] == json!("applied") {
                applied.push(id.clone());
                touched.extend(crate::changes::touched_ids(&cs));
            }
        }
    }
    let outcome = if !applied.is_empty() {
        "applied"
    } else if !s.proposed.is_empty() {
        "proposed"
    } else if s.errors > 0 {
        "error"
    } else {
        "discussed"
    };
    Entry {
        kind: "chat".into(),
        id: s.id.clone(),
        project: project(store),
        user: user.into(),
        start: s.start.clone(),
        end: s.end.clone(),
        outcome: outcome.into(),
        changesets_proposed: s.proposed.clone(),
        changesets_applied: applied,
        records_touched: touched.into_iter().collect(),
    }
}

/// Outcome of an agent run from its exit status and sandbox violations.
pub fn agent_outcome(exit_status: &Value, violations: usize) -> &'static str {
    if violations > 0 {
        return "violation";
    }
    match exit_status {
        Value::Number(n) if n.as_i64() == Some(0) => "success",
        Value::String(x) if x == "cancelled" => "cancelled",
        Value::String(x) if x == "timeout" => "timeout",
        _ => "failed",
    }
}
