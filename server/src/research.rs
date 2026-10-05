//! Graded research findings: research/RF-0001.json, one append-only file per finding.
//!
//! A finding is a dated, graded claim with source URLs. Findings are added only through the
//! changeset `finding` op and never edited; a re-check appends a new finding that `supersedes`
//! the old one. Requirements cite findings from `standards` (e.g. "RF-0003"), and lint warns
//! when a cited finding is REFUTED or past its refresh_by date.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

use chrono::{Days, NaiveDate};
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::model::{s, strs, Rec};
use crate::store::{dump, Res, Source, StoreError};

pub const DIR: &str = "research";
pub const PREFIX: &str = "RF";
/// `kind` reported for findings in changeset analyses (findings are not a record Kind).
pub const KIND: &str = "findings";
pub const GRADES: &[&str] = &["VERIFIED", "THIN", "REFUTED"];
/// Perishability -> days until a finding needs re-checking.
pub const PERISHABILITY: &[(&str, u64)] = &[("fast", 60), ("slow", 180)];

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^RF-(\d+)$").unwrap());
static CITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bRF-\d+\b").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://[^\s/]+").unwrap());

pub fn is_id(id: &str) -> bool {
    ID.is_match(id)
}

pub fn id_num(id: &str) -> Option<u64> {
    ID.captures(id).and_then(|c| c[1].parse().ok())
}

// reqforge: implements REQ-0063
/// Claim text as stored: one line, no Markdown control characters, so a finding can never add
/// a heading, list, quote, link, code span or HTML to a snapshot or agent brief.
pub fn sanitise_text(text: &str) -> String {
    let kept: String = text
        .chars()
        .map(|c| if c.is_control() || c.is_whitespace() { ' ' } else { c })
        .filter(|c| !"#*_`[]<>|\\~".contains(*c))
        .collect();
    let one_line = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    // a leading list / quote / rule marker could still start a block
    one_line.trim_start_matches(['-', '+', '>', '.', ' ']).trim_end().to_string()
}

// reqforge: implements REQ-0063
/// Source URL as stored: no whitespace, control or Markdown link/emphasis/HTML characters.
/// `#` and `_` stay (fragments and paths need them); a URL cannot start a heading.
pub fn sanitise_source(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() && !c.is_whitespace() && !"`*[]()<>|\\!\"'".contains(*c)).collect()
}

/// refresh_by = date + 60 days (fast) or + 180 days (slow).
pub fn refresh_by(date: NaiveDate, perishability: &str) -> Option<NaiveDate> {
    let days = PERISHABILITY.iter().find(|(p, _)| *p == perishability)?.1;
    date.checked_add_days(Days::new(days))
}

fn parse_date(v: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(v.trim(), "%Y-%m-%d").ok()
}

// reqforge: implements REQ-0063
/// Build a finding record from changeset data: sanitise, validate and derive refresh_by.
/// `existing` is every finding already in the repository or earlier in the changeset.
pub fn build(id: &str, data: &Value, existing: &[Value], created: &str) -> Result<Rec, String> {
    let mut errors = vec![];
    let get = |k: &str| data.get(k).and_then(Value::as_str).unwrap_or("");
    let claim = sanitise_text(get("claim"));
    if claim.is_empty() {
        errors.push("claim: required".to_string());
    }
    let grade = get("grade").trim().to_uppercase();
    if !GRADES.contains(&grade.as_str()) {
        errors.push(format!("grade: '{}' not in {}", get("grade"), crate::model::pylist(GRADES)));
    }
    let raw_sources: Vec<String> = match data.get("sources") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
        Some(Value::String(x)) => x.split([',', '\n']).map(String::from).collect(),
        _ => vec![],
    };
    let mut sources: Vec<String> = vec![];
    for raw in &raw_sources {
        let u = sanitise_source(raw);
        if u.is_empty() {
            continue;
        }
        if !URL.is_match(&u) {
            errors.push(format!("sources: '{u}' is not an http(s) URL"));
        } else if !sources.contains(&u) {
            sources.push(u);
        }
    }
    if sources.is_empty() && !errors.iter().any(|e| e.starts_with("sources")) {
        errors.push("sources: at least 1 source URL required".to_string());
    }
    let date = if get("date").trim().is_empty() { Some(chrono::Utc::now().date_naive()) } else { parse_date(get("date")) };
    if date.is_none() {
        errors.push(format!("date: '{}' is not a YYYY-MM-DD date", get("date")));
    }
    let perish = get("perishability").trim().to_lowercase();
    if !PERISHABILITY.iter().any(|(p, _)| *p == perish) {
        let names: Vec<&str> = PERISHABILITY.iter().map(|(p, _)| *p).collect();
        errors.push(format!("perishability: '{}' not in {}", get("perishability"), crate::model::pylist(&names)));
    }
    let supersedes = get("supersedes").trim().to_string();
    if !supersedes.is_empty() {
        match existing.iter().find(|f| f["id"] == json!(supersedes)) {
            None => errors.push(format!("supersedes: {supersedes} does not exist")),
            Some(_) => {
                if let Some(by) = existing.iter().find(|f| f["supersedes"] == json!(supersedes)) {
                    errors.push(format!("supersedes: {supersedes} is already superseded by {}", by["id"].as_str().unwrap_or("?")));
                }
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    let date = date.unwrap();
    let mut rec = Rec::new();
    rec.insert("id".into(), json!(id));
    rec.insert("claim".into(), json!(claim));
    rec.insert("grade".into(), json!(grade));
    rec.insert("sources".into(), json!(sources));
    rec.insert("date".into(), json!(date.to_string()));
    rec.insert("perishability".into(), json!(perish));
    rec.insert("refresh_by".into(), json!(refresh_by(date, &perish).map(|d| d.to_string())));
    if !supersedes.is_empty() {
        rec.insert("supersedes".into(), json!(supersedes));
    }
    rec.insert("created".into(), json!(created));
    Ok(rec)
}

/// Every research/RF-*.json, sorted by number.
pub fn list(root: &Path) -> Vec<Value> {
    let mut out: Vec<(u64, Value)> = fs::read_dir(root.join(DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let n = id_num(name.strip_suffix(".json")?)?;
            let v: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            v.is_object().then_some((n, v))
        })
        .collect();
    out.sort_by_key(|(n, _)| *n);
    out.into_iter().map(|(_, v)| v).collect()
}

// reqforge: implements REQ-0063
/// Append a finding. Findings are never overwritten: an existing file is an error.
pub fn append(root: &Path, rec: &Value) -> Res<()> {
    let id = rec["id"].as_str().filter(|i| is_id(i)).ok_or_else(|| StoreError::bad("finding has no RF id"))?;
    let d = root.join(DIR);
    fs::create_dir_all(&d).map_err(|e| StoreError::bad(e.to_string()))?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(d.join(format!("{id}.json")))
        .map_err(|_| StoreError::new(format!("{id} already exists; findings are append-only"), 409))?;
    f.write_all(dump(rec).as_bytes()).map_err(|e| StoreError::bad(e.to_string()))
}

// reqforge: implements REQ-0063
/// Lint findings: one warning per requirement citing a REFUTED or stale finding
/// (and per citation of a finding that does not exist).
pub fn lint_findings(src: &dyn Source, reqs: &[std::sync::Arc<Rec>], today: NaiveDate) -> Vec<Value> {
    let findings = src.findings();
    if findings.is_empty() && !reqs.iter().any(|r| strs(r, "standards").iter().any(|x| CITE.is_match(x))) {
        return vec![];
    }
    let by_id: Map<String, Value> = findings.iter().map(|f| (f["id"].as_str().unwrap_or("").to_string(), f.clone())).collect();
    let superseded_by = |id: &str| findings.iter().find(|f| f["supersedes"] == json!(id)).and_then(|f| f["id"].as_str());
    let hint = |id: &str| superseded_by(id).map(|n| format!("; cite {n}, which supersedes it")).unwrap_or_else(|| "; re-check it and cite the new finding".into());
    let mut out = vec![];
    for r in reqs {
        let rid = s(r, "id");
        let mut cited: Vec<&str> = strs(r, "standards").into_iter().flat_map(|x| CITE.find_iter(x).map(|m| m.as_str())).collect();
        cited.dedup();
        for fid in cited {
            let Some(f) = by_id.get(fid) else {
                out.push(json!({"severity": "warning", "rule": "research-missing", "ids": [rid],
                    "message": format!("standards cite {fid}, which is not a recorded finding")}));
                continue;
            };
            if f["grade"] == json!("REFUTED") {
                out.push(json!({"severity": "warning", "rule": "research-refuted", "ids": [rid],
                    "message": format!("standards cite {fid}, which is REFUTED{}", hint(fid))}));
            }
            if let Some(due) = f["refresh_by"].as_str().and_then(parse_date) {
                if due < today {
                    out.push(json!({"severity": "warning", "rule": "research-stale", "ids": [rid],
                        "message": format!("standards cite {fid}, which was due for re-checking on {due}{}", hint(fid))}));
                }
            }
        }
    }
    out
}

/// Findings may not be the target of update/delete ops.
pub fn append_only_error(id: &str) -> Option<String> {
    is_id(id).then(|| format!("{id} is a research finding; findings are append-only — add a `finding` op with \"supersedes\": \"{id}\""))
}
