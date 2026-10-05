//! Decision records (DEC-NNNN) and whether tested code relies on them.
//!
//! A decision is exercised when at least one code location is tagged
//! `reqforge: implements DEC-NNNN`, at least one test is tagged with the id, and every such test
//! has fresh passing evidence. Per tagged test:
//!   passed    latest evidence passed and the files it vouched for are unchanged
//!   suspect   it passed, but a file it vouched for changed since
//!   failing   latest evidence failed
//!   pending   no evidence yet
//! Lint warns for accepted decisions still not exercised 14 days after acceptance.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::codetrace::{load_all, Index, Tag};
use crate::evidence::{load_latest, Evidence};
use crate::model::{s, strs, Kind};
use crate::store::{Source, Store};

/// Days an accepted decision may stay unexercised before lint warns.
pub const GRACE_DAYS: i64 = 14;

fn loc(t: &Tag) -> Value {
    json!({"component": t.component, "file": t.file, "line": t.line, "symbol": t.symbol})
}

/// Does this test evidence come from the tagged test? source = "test:<component>:<file>::<name>".
fn from_tag(e: &Evidence, t: &Tag) -> bool {
    let Some((cf, name)) = e.source.strip_prefix("test:").and_then(|x| x.split_once("::")) else { return false };
    let (comp, file) = cf.split_once(':').unwrap_or(("", cf));
    let file_ok = file == t.file || (!file.is_empty() && (t.file.ends_with(file) || file.ends_with(t.file.as_str())));
    let sym_ok = t.symbol.as_deref().map(|sym| name == sym || name.ends_with(sym) || name.contains(sym)).unwrap_or(true);
    (comp.is_empty() || comp == t.component) && file_ok && sym_ok
}

/// Exercised report for every decision (memoised on repository + code index + evidence state).
pub fn report(store: &Store) -> Arc<Value> {
    store.memo("decisions", || compute(store, &load_all(&store.root), &load_latest(&store.root)))
}

// reqforge: implements REQ-0061
pub fn compute(src: &dyn Source, indexes: &[Index], latest: &BTreeMap<String, Evidence>) -> Value {
    let current: HashMap<String, &String> =
        indexes.iter().flat_map(|i| i.files.iter().map(move |(f, h)| (format!("{}:{f}", i.component), h))).collect();
    let mut by_dec: HashMap<&str, Vec<&Tag>> = HashMap::new();
    for t in indexes.iter().flat_map(|i| i.tags.iter()).filter(|t| t.req.starts_with("DEC-")) {
        by_dec.entry(t.req.as_str()).or_default().push(t);
    }
    let mut out = Map::new();
    let mut exercised_n = 0;
    let decisions = src.records(Kind::Decisions);
    for d in &decisions {
        let id = s(d, "id");
        let tags = by_dec.get(id).cloned().unwrap_or_default();
        let implements: Vec<Value> = tags.iter().filter(|t| t.kind == "implements").map(|t| loc(t)).collect();
        let tests: Vec<Value> = tags
            .iter()
            .filter(|t| t.kind == "verifies")
            .map(|t| {
                let evs: Vec<&Evidence> = latest.values().filter(|e| e.target == id && from_tag(e, t)).collect();
                let fresh = |e: &&Evidence| e.hashes.iter().all(|(f, h)| current.get(f) == Some(&h));
                let status = if evs.iter().any(|e| e.status == "failed") {
                    "failing"
                } else if evs.iter().any(|e| e.status == "passed" && fresh(e)) {
                    "passed"
                } else if evs.iter().any(|e| e.status == "passed") {
                    "suspect"
                } else {
                    "pending"
                };
                let mut v = loc(t);
                v["status"] = json!(status);
                v["evidence"] = json!(evs.iter().map(|e| json!({"source": e.source, "status": e.status, "commit": e.commit, "at": e.at})).collect::<Vec<_>>());
                v
            })
            .collect();
        let all_pass = tests.iter().all(|t| t["status"] == json!("passed"));
        let exercised = !implements.is_empty() && !tests.is_empty() && all_pass;
        let reason = if implements.is_empty() {
            format!("no code is tagged `reqforge: implements {id}`")
        } else if tests.is_empty() {
            format!("no test is tagged with {id}")
        } else if !all_pass {
            let bad: Vec<String> = tests
                .iter()
                .filter(|t| t["status"] != json!("passed"))
                .map(|t| format!("{}:{} {}", t["file"].as_str().unwrap_or(""), t["line"], t["status"].as_str().unwrap_or("")))
                .collect();
            format!("tagged tests without fresh passing evidence: {}", bad.join(", "))
        } else {
            String::new()
        };
        exercised_n += usize::from(exercised);
        out.insert(
            id.into(),
            json!({"id": id, "title": s(d, "title"), "status": s(d, "status"), "requirements": strs(d, "requirements"),
                   "superseded_by": d.get("superseded_by").cloned().unwrap_or(Value::Null), "accepted_at": d.get("accepted_at").cloned().unwrap_or(Value::Null),
                   "exercised": exercised, "reason": reason, "implements": implements, "tests": tests}),
        );
    }
    json!({"summary": {"decisions": decisions.len(), "exercised": exercised_n}, "decisions": out})
}

fn parse_time(t: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(t)
        .map(|d| d.with_timezone(&chrono::Utc))
        .ok()
        .or_else(|| chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc()))
}

/// Accepted decisions that are not exercised: (id, days since acceptance if dated, reason).
fn unexercised(src: &dyn Source, rep: &Value, now: chrono::DateTime<chrono::Utc>) -> Vec<(String, Option<i64>, String)> {
    src.records(Kind::Decisions)
        .iter()
        .filter(|d| s(d, "status") == "accepted")
        .filter(|d| rep["decisions"][s(d, "id")]["exercised"] != json!(true))
        .map(|d| {
            let since = [s(d, "accepted_at"), s(d, "updated"), s(d, "created")].into_iter().find_map(parse_time);
            let reason = rep["decisions"][s(d, "id")]["reason"].as_str().unwrap_or("").to_string();
            (s(d, "id").to_string(), since.map(|t| (now - t).num_days()), reason)
        })
        .collect()
}

// reqforge: implements REQ-0061
/// Lint findings: every accepted decision not exercised within GRACE_DAYS of acceptance.
pub fn lint_findings(src: &dyn Source, now: chrono::DateTime<chrono::Utc>) -> Vec<Value> {
    let Some(root) = src.root() else { return vec![] };
    let rep = compute(src, &load_all(&root), &load_latest(&root));
    unexercised(src, &rep, now)
        .into_iter()
        .filter_map(|(id, days, reason)| {
            let days = days.filter(|d| *d >= GRACE_DAYS)?;
            Some(json!({"severity": "warning", "rule": "decision-unexercised", "ids": [id],
                "message": format!("accepted {days} days ago but not exercised: {reason}")}))
        })
        .collect()
}

// reqforge: implements REQ-0061
/// Monitor counts: accepted decisions, how many are unexercised, and how many of those are past
/// GRACE_DAYS (the ones lint warns about). `rep` is the output of `compute`.
pub fn monitor_counts(src: &dyn Source, rep: &Value, now: chrono::DateTime<chrono::Utc>) -> Value {
    let accepted = src.records(Kind::Decisions).iter().filter(|d| s(d, "status") == "accepted").count();
    let un = unexercised(src, rep, now);
    let overdue: Vec<&str> = un.iter().filter(|(_, d, _)| d.is_some_and(|d| d >= GRACE_DAYS)).map(|(id, _, _)| id.as_str()).collect();
    json!({"accepted": accepted, "unexercised": un.len(), "overdue": overdue.len(), "overdue_ids": overdue, "grace_days": GRACE_DAYS})
}
