//! Verification: requirement -> criteria -> tests/evals -> evidence -> code, as one report.
//!
//! Per acceptance criterion (target):
//!   failing   latest evidence from some source failed
//!   suspect   passing evidence exists but a file it vouched for changed since (hash mismatch)
//!   verified  passing evidence, nothing changed since
//!   pending   tagged tests or covering evals exist but no evidence yet
//!   untested  nothing verifies it
//! A requirement takes its worst criterion (failing > suspect > untested > pending > verified).
//! The gate checks also catch broken links between code and requirements.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::codetrace::{load_all, Index, Tag};
use crate::evidence::{load_latest, Evidence};
use crate::model::{objs, s, strs, Kind, Rec};
use crate::store::{Source, Store};

pub const STATUSES: &[&str] = &["failing", "suspect", "untested", "pending", "verified"];
const ACTIVE: &[&str] = &["proposed", "approved", "implemented", "verified"];
static PATHISH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\w./-]+\.[A-Za-z0-9]+").unwrap());

fn rank(st: &str) -> usize {
    STATUSES.iter().position(|x| *x == st).unwrap_or(4)
}

fn tag_ref(t: &Tag) -> Value {
    json!({"component": t.component, "file": t.file, "line": t.line, "symbol": t.symbol, "ac": t.ac})
}

/// Full verification report (memoised on repository + code index + evidence state).
pub fn report(store: &Store) -> Arc<Value> {
    store.memo("verification", || compute(store, &load_all(&store.root), &load_latest(&store.root)))
}

pub fn compute(src: &dyn Source, indexes: &[Index], latest: &BTreeMap<String, Evidence>) -> Value {
    let cfg = src.config();
    let gates = cfg.get("gates").cloned().unwrap_or(json!({}));
    let gate = |k: &str| gates.get(k).and_then(Value::as_bool).unwrap_or(false);
    let reqs = src.records(Kind::Requirements);
    let stories = src.records(Kind::Stories);
    let comps = src.records(Kind::Components);
    let by_id: HashMap<&str, &Arc<Rec>> = reqs.iter().map(|r| (s(r, "id"), r)).collect();

    let current: HashMap<String, String> =
        indexes.iter().flat_map(|i| i.files.iter().map(move |(f, h)| (format!("{}:{f}", i.component), h.clone()))).collect();
    let mut impl_tags: HashMap<&str, Vec<&Tag>> = HashMap::new();
    let mut ver_tags: HashMap<&str, Vec<&Tag>> = HashMap::new();
    for t in indexes.iter().flat_map(|i| i.tags.iter()) {
        if t.kind == "implements" { impl_tags.entry(t.req.as_str()).or_default().push(t) } else { ver_tags.entry(t.req.as_str()).or_default().push(t) }
    }
    let mut eval_cov: HashMap<String, Vec<String>> = HashMap::new();
    for st in &stories {
        for ev in objs(st, "evals") {
            for c in strs(ev, "covers") {
                eval_cov.entry(c.to_string()).or_default().push(format!("{}/{}", s(st, "id"), s(ev, "id")));
            }
        }
    }
    let mut ev_by_target: HashMap<&str, Vec<&Evidence>> = HashMap::new();
    for e in latest.values() {
        ev_by_target.entry(e.target.as_str()).or_default().push(e);
    }

    let mut out_reqs = Map::new();
    let mut statuses = Map::new();
    let mut ac_counts: BTreeMap<&str, usize> = STATUSES.iter().map(|x| (*x, 0)).collect();
    let mut req_counts: BTreeMap<&str, usize> = STATUSES.iter().map(|x| (*x, 0)).collect();
    let mut by_cell: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let (mut untested, mut failing, mut suspect, mut impl_missing) = (vec![], vec![], vec![], vec![]);
    let mut implemented = 0;

    for r in reqs.iter().filter(|r| s(r, "status") != "deprecated") {
        let rid = s(r, "id");
        let active = ACTIVE.contains(&s(r, "status")) && s(r, "priority") != "wont";
        let acs: Vec<String> = objs(r, "acceptance_criteria").iter().map(|a| s(a, "id").to_string()).collect();
        let targets: Vec<(Option<String>, String)> =
            if acs.is_empty() { vec![(None, rid.to_string())] } else { acs.iter().map(|a| (Some(a.clone()), format!("{rid}#{a}"))).collect() };
        let mut ac_out = Map::new();
        let mut worst = "verified";
        for (ac, target) in &targets {
            let tests: Vec<Value> = ver_tags
                .get(rid)
                .into_iter()
                .flatten()
                .filter(|t| ac.is_none() || t.ac.is_none() || t.ac == *ac)
                .map(|t| tag_ref(t))
                .collect();
            let evals = eval_cov.get(target).cloned().unwrap_or_default();
            let evs: Vec<&&Evidence> = ev_by_target.get(target.as_str()).map(|v| v.iter().collect()).unwrap_or_default();
            let changed: Vec<String> = evs
                .iter()
                .filter(|e| e.status == "passed")
                .flat_map(|e| e.hashes.iter().filter(|(f, h)| current.get(*f) != Some(*h)).map(|(f, _)| f.clone()))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let status = if evs.iter().any(|e| e.status == "failed") {
                "failing"
            } else if evs.iter().any(|e| e.status == "passed") {
                if changed.is_empty() { "verified" } else { "suspect" }
            } else if !tests.is_empty() || !evals.is_empty() {
                "pending"
            } else {
                "untested"
            };
            if active {
                *ac_counts.get_mut(status).unwrap() += 1;
                match status {
                    "untested" => untested.push(format!("{target} has no tagged test and no covering eval")),
                    "failing" => failing.push(format!(
                        "{target} failing: {}",
                        evs.iter().filter(|e| e.status == "failed").map(|e| e.source.as_str()).collect::<Vec<_>>().join(", ")
                    )),
                    "suspect" => suspect.push(format!("{target} verified before changes to {}", changed.join(", "))),
                    _ => {}
                }
            }
            if rank(status) < rank(worst) {
                worst = status;
            }
            let evidence: Vec<Value> = evs
                .iter()
                .map(|e| json!({"source": e.source, "status": e.status, "commit": e.commit, "run": e.run, "at": e.at}))
                .collect();
            ac_out.insert(ac.clone().unwrap_or_else(|| "-".into()), json!({"target": target, "status": status, "tests": tests, "evals": evals, "evidence": evidence, "changed": changed}));
        }
        let impls: Vec<Value> = impl_tags.get(rid).into_iter().flatten().map(|t| tag_ref(t)).collect();
        if !impls.is_empty() {
            implemented += 1;
        }
        if active {
            *req_counts.get_mut(worst).unwrap() += 1;
            let cell = by_cell.entry(format!("{}/{}", s(r, "type"), s(r, "category"))).or_default();
            cell.0 += 1;
            cell.1 += usize::from(worst == "verified");
            if impls.is_empty() && ["implemented", "verified"].contains(&s(r, "status")) && !indexes.is_empty() {
                impl_missing.push(format!("{rid} is {} but no code is tagged `reqforge: implements {rid}`", s(r, "status")));
            }
        }
        statuses.insert(rid.into(), json!(worst));
        out_reqs.insert(rid.into(), json!({"status": worst, "active": active, "implemented": !impls.is_empty(), "implements": impls, "acs": ac_out}));
    }

    // ---- link integrity
    let (mut unknown, mut deprecated) = (vec![], vec![]);
    for t in indexes.iter().flat_map(|i| i.tags.iter()) {
        let at = format!("{}:{}:{}", t.component, t.file, t.line);
        match by_id.get(t.req.as_str()) {
            None => unknown.push(format!("{at} tags unknown {}", t.req)),
            Some(r) => {
                if let Some(ac) = &t.ac {
                    if !objs(r, "acceptance_criteria").iter().any(|a| s(a, "id") == ac) {
                        unknown.push(format!("{at} tags {}#{ac} but {} has no {ac}", t.req, t.req));
                    }
                }
                if s(r, "status") == "deprecated" {
                    deprecated.push(format!("{at} still tags deprecated {}", t.req));
                }
            }
        }
    }
    // evals whose command names a scanned test file should cover what that file's tags verify
    let mut mismatch = vec![];
    let files: HashMap<&str, Vec<&Tag>> = indexes.iter().flat_map(|i| i.tags.iter()).fold(HashMap::new(), |mut m, t| {
        m.entry(t.file.as_str()).or_default().push(t);
        m
    });
    for st in &stories {
        for ev in objs(st, "evals") {
            let cmd = s(ev, "command");
            for p in PATHISH.find_iter(cmd).map(|m| m.as_str().trim_start_matches("./")) {
                let Some(tags) = files.get(p).or_else(|| files.iter().find(|(f, _)| f.ends_with(p)).map(|(_, v)| v)) else { continue };
                for c in strs(ev, "covers") {
                    let (req, ac) = c.split_once('#').map(|(a, b)| (a, Some(b))).unwrap_or((c, None));
                    if !tags.iter().any(|t| t.kind == "verifies" && t.req == req && (t.ac.is_none() || ac.is_none() || t.ac.as_deref() == ac)) {
                        mismatch.push(format!("{}/{} covers {c} but {p} has no test tagged {c}", s(st, "id"), s(ev, "id")));
                    }
                }
            }
        }
    }
    let keys: BTreeSet<&str> = comps.iter().map(|c| s(c, "key")).collect();
    let unknown_comp: Vec<String> = if comps.is_empty() {
        vec![]
    } else {
        stories
            .iter()
            .filter(|st| !s(st, "component").is_empty() && !keys.contains(s(st, "component")))
            .map(|st| format!("{} references unknown component '{}'", s(st, "id"), s(st, "component")))
            .collect()
    };
    let not_scanned: Vec<String> = comps
        .iter()
        .filter(|c| !indexes.iter().any(|i| i.component == s(c, "key")))
        .map(|c| format!("component {} ({}) has never been scanned", s(c, "key"), s(c, "id")))
        .collect();

    let mut checks = vec![];
    let mut check = |id: &str, name: &str, failures: Vec<String>, severity: &str| {
        checks.push(json!({"id": id, "name": name, "passed": failures.is_empty(), "severity": severity, "failures": failures}));
    };
    check("tag-unknown", "Trace tags reference existing requirements and criteria", unknown, "error");
    check("evidence-failing", "No criterion has failing evidence", failing, "error");
    check("evidence-suspect", "No verified criterion has changed since its evidence", suspect, if gate("fail_on_suspect") { "error" } else { "warning" });
    check("criteria-tested", "Every active criterion has a tagged test or covering eval", untested, if gate("require_test_tags") { "error" } else { "warning" });
    check("impl-tagged", "Implemented requirements have tagged implementation code", impl_missing, "warning");
    check("eval-tags", "Eval coverage matches the tags in the test files they run", mismatch, "warning");
    check("tag-deprecated", "No code tags deprecated requirements", deprecated, "warning");
    check("story-components", "Stories reference defined components", unknown_comp, "warning");
    check("components-scanned", "Every component has been scanned", not_scanned, "warning");

    let ok = !checks.iter().any(|c| c["passed"] == json!(false) && c["severity"] == json!("error"));
    let comp_summary: Vec<Value> = indexes
        .iter()
        .map(|i| {
            let reqs: BTreeSet<&str> = i.tags.iter().map(|t| t.req.as_str()).collect();
            json!({"component": i.component, "commit": i.commit, "scanned_at": i.scanned_at, "files_scanned": i.files_scanned,
                   "tagged_files": i.files.len(), "implements": i.tags.iter().filter(|t| t.kind == "implements").count(),
                   "verifies": i.tags.iter().filter(|t| t.kind == "verifies").count(), "requirements": reqs.len()})
        })
        .collect();
    let total_ac: usize = ac_counts.values().sum();
    json!({
        "ok": ok,
        "summary": {
            "criteria": ac_counts, "requirements": req_counts, "criteria_total": total_ac,
            "verified_ratio": if total_ac == 0 { 1.0 } else { (ac_counts["verified"] as f64 / total_ac as f64 * 1000.0).round() / 1000.0 },
            "implemented": implemented, "evidence": latest.len(), "components": comp_summary,
            "by_category": by_cell.into_iter().map(|(k, (n, v))| (k, json!({"requirements": n, "verified": v}))).collect::<Map<_, _>>(),
        },
        "checks": checks,
        "statuses": statuses,
        "requirements": out_reqs,
    })
}

/// Report without the per-requirement detail (for summaries and CI).
pub fn summary(full: &Value) -> Value {
    json!({"ok": full["ok"], "summary": full["summary"], "checks": full["checks"]})
}

pub fn to_markdown(rep: &Value) -> String {
    let sm = &rep["summary"];
    let c = &sm["criteria"];
    let mut out = vec![
        format!("# Verification — {} ({:.0}% of active criteria verified)", if rep["ok"] == json!(true) { "PASS" } else { "FAIL" }, sm["verified_ratio"].as_f64().unwrap_or(0.0) * 100.0),
        String::new(),
        format!(
            "criteria: {} verified · {} pending · {} suspect · {} failing · {} untested  —  requirements implemented in code: {}",
            c["verified"], c["pending"], c["suspect"], c["failing"], c["untested"], sm["implemented"]
        ),
        String::new(),
        "| check | result | findings |".into(),
        "|---|---|---|".into(),
    ];
    let checks = rep["checks"].as_array().cloned().unwrap_or_default();
    for ch in &checks {
        let res = if ch["passed"] == json!(true) { "pass".to_string() } else { ch["severity"].as_str().unwrap_or("").to_string() };
        out.push(format!("| {} | {} | {} |", ch["name"].as_str().unwrap_or(""), res, ch["failures"].as_array().map(Vec::len).unwrap_or(0)));
    }
    for ch in &checks {
        let f = ch["failures"].as_array().cloned().unwrap_or_default();
        if !f.is_empty() {
            out.push(String::new());
            out.push(format!("## {}", ch["name"].as_str().unwrap_or("")));
            out.extend(f.iter().take(40).map(|x| format!("- {}", x.as_str().unwrap_or(""))));
            if f.len() > 40 {
                out.push(format!("- … and {} more", f.len() - 40));
            }
        }
    }
    out.join("\n") + "\n"
}
