//! Deterministic traceability evaluation of the requirement -> epic -> story -> task -> eval graph.
//! This is the gate CI runs; semantic judgement is the traceability-evaluator agent's job.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::model::{eval_stage, objs, quality_eval_match, s, strs, Kind};
use crate::store::Source;

const ACTIVE: &[&str] = &["proposed", "approved", "implemented", "verified"];

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

pub fn evaluate(src: &dyn Source) -> Value {
    let reqs = src.records(Kind::Requirements);
    let epics = src.records(Kind::Epics);
    let stories = src.records(Kind::Stories);
    let tasks = src.records(Kind::Tasks);
    let config = src.config();
    let gates = config.get("gates").cloned().unwrap_or(json!({}));
    let gate_f = |k: &str, d: f64| gates.get(k).and_then(Value::as_f64).unwrap_or(d);

    let req_by_id: HashMap<&str, &Map<String, Value>> = reqs.iter().map(|r| (s(r, "id"), r.as_ref())).collect();
    let story_by_id: HashMap<&str, &Map<String, Value>> = stories.iter().map(|r| (s(r, "id"), r.as_ref())).collect();
    let active: Vec<&Map<String, Value>> = reqs
        .iter()
        .map(|r| r.as_ref())
        .filter(|r| ACTIVE.contains(&s(r, "status")) && s(r, "priority") != "wont")
        .collect();
    let mut req_to_stories: HashMap<&str, Vec<&str>> = HashMap::new();
    for st in &stories {
        for rid in strs(st, "requirements") {
            req_to_stories.entry(rid).or_default().push(s(st, "id"));
        }
    }
    let mut story_tasks: HashMap<&str, Vec<&str>> = HashMap::new();
    for t in &tasks {
        story_tasks.entry(s(t, "story")).or_default().push(s(t, "id"));
    }

    let mut checks: Vec<Value> = vec![];
    let mut check = |id: &str, name: &str, failures: Vec<String>, severity: &str, measured: Option<f64>| {
        let mut c = json!({"id": id, "name": name, "passed": failures.is_empty(), "severity": severity, "failures": failures});
        if let Some(m) = measured {
            c["measured"] = json!(m);
        }
        checks.push(c);
    };

    // 1. forward coverage
    let uncovered: Vec<&str> = active.iter().map(|r| s(r, "id")).filter(|id| req_to_stories.get(id).map(Vec::is_empty).unwrap_or(true)).collect();
    let req_cov = if active.is_empty() { 1.0 } else { 1.0 - uncovered.len() as f64 / active.len() as f64 };
    check(
        "req-coverage",
        "Every active requirement maps to at least one story",
        uncovered.iter().map(|id| format!("{id} has no story")).collect(),
        if req_cov < gate_f("min_requirement_coverage", 1.0) { "error" } else { "warning" },
        Some(round3(req_cov)),
    );

    // 2. backward coverage: no orphan stories
    check(
        "story-trace",
        "Every story traces to at least one requirement",
        stories.iter().filter(|st| strs(st, "requirements").is_empty()).map(|st| format!("{} traces to no requirement", s(st, "id"))).collect(),
        "error",
        None,
    );

    // 3. structure
    let epic_used: HashSet<&str> = stories.iter().map(|st| s(st, "epic")).collect();
    check(
        "epic-nonempty",
        "Every epic has at least one story",
        epics.iter().map(|e| s(e, "id")).filter(|id| !epic_used.contains(id)).map(|id| format!("{id} has no stories")).collect(),
        "warning",
        None,
    );
    check(
        "story-tasks",
        "Every story has at least one task",
        stories.iter().map(|st| s(st, "id")).filter(|id| story_tasks.get(id).map(Vec::is_empty).unwrap_or(true)).map(|id| format!("{id} has no tasks")).collect(),
        "error",
        None,
    );

    // 4. code stories carry evals from the start, each runnable
    let need_evals = gates.get("require_evals_for_code").and_then(Value::as_bool).unwrap_or(true);
    let (mut missing_evals, mut missing_cmd) = (vec![], vec![]);
    for st in &stories {
        let deliverable = if s(st, "deliverable").is_empty() { "code" } else { s(st, "deliverable") };
        if deliverable == "code" {
            let evs = objs(st, "evals");
            if evs.is_empty() {
                missing_evals.push(format!("{} (code) has no evals", s(st, "id")));
            }
            for ev in evs {
                if crate::model::is_empty(ev.get("command")) {
                    missing_cmd.push(format!("{}/{} has no command", s(st, "id"), s(ev, "id")));
                }
            }
        }
    }
    check("story-evals", "Every code story defines evals", missing_evals, if need_evals { "error" } else { "warning" }, None);
    check("eval-runnable", "Every eval has a runnable command", missing_cmd, "warning", None);

    // 5. acceptance-criteria coverage
    let mut covered: HashSet<String> = HashSet::new();
    for st in &stories {
        for ev in objs(st, "evals") {
            covered.extend(strs(ev, "covers").into_iter().map(String::from));
        }
    }
    let mut all_acs = vec![];
    for r in &active {
        for ac in objs(r, "acceptance_criteria") {
            all_acs.push(format!("{}#{}", s(r, "id"), s(ac, "id")));
        }
    }
    let ac_missing: Vec<&String> = all_acs.iter().filter(|a| !covered.contains(*a)).collect();
    let ac_cov = if all_acs.is_empty() { 1.0 } else { 1.0 - ac_missing.len() as f64 / all_acs.len() as f64 };
    check(
        "criteria-coverage",
        "Requirement acceptance criteria are covered by evals",
        ac_missing.iter().map(|r| format!("{r} not covered by any eval")).collect(),
        if ac_cov < gate_f("min_criteria_coverage", 0.8) { "error" } else { "warning" },
        Some(round3(ac_cov)),
    );

    // 6. quality requirements verified by the right kind of eval
    let mut qmis = vec![];
    for r in &active {
        if s(r, "type") != "quality" {
            continue;
        }
        let Some(want) = quality_eval_match(s(r, "category")) else { continue };
        let kinds: HashSet<&str> = req_to_stories
            .get(s(r, "id"))
            .into_iter()
            .flatten()
            .filter_map(|sid| story_by_id.get(sid))
            .flat_map(|st| objs(st, "evals").into_iter().map(|ev| s(ev, "kind")))
            .collect();
        if !want.iter().any(|w| kinds.contains(w)) {
            let mut w: Vec<&str> = want.to_vec();
            w.sort_unstable();
            qmis.push(format!("{} ({}) needs an eval of kind {}", s(r, "id"), s(r, "category"), w.join("/")));
        }
    }
    check("quality-evals", "Quality requirements verified by matching eval kinds", qmis, "error", None);

    // 7. lifecycle coverage
    let tkinds: HashSet<&str> = tasks.iter().map(|t| s(t, "kind")).collect();
    let lifecycle: Vec<String> = if stories.is_empty() {
        vec![]
    } else {
        ["design", "deployment", "monitoring"].iter().filter(|k| !tkinds.contains(*k)).map(|k| format!("no {k} task anywhere in the plan")).collect()
    };
    check("lifecycle", "Plan covers design, deployment and monitoring work", lifecycle, "warning", None);

    // 8. referential integrity of eval coverage refs
    let mut bad = vec![];
    for st in &stories {
        let sreqs = strs(st, "requirements");
        for ev in objs(st, "evals") {
            for r in strs(ev, "covers") {
                let (rid, ac) = r.split_once('#').unwrap_or((r, ""));
                let ok_ref = req_by_id
                    .get(rid)
                    .map(|req| ac.is_empty() || objs(req, "acceptance_criteria").iter().any(|a| s(a, "id") == ac))
                    .unwrap_or(false);
                if !ok_ref {
                    bad.push(format!("{}/{} covers unknown {}", s(st, "id"), s(ev, "id"), r));
                } else if !sreqs.contains(&rid) {
                    bad.push(format!("{}/{} covers {} but story does not trace to {}", s(st, "id"), s(ev, "id"), r, rid));
                }
            }
            let k = s(ev, "kind");
            if !k.is_empty() && eval_stage(k).is_none() {
                bad.push(format!("{}/{} unknown kind {}", s(st, "id"), s(ev, "id"), k));
            }
        }
    }
    check("eval-refs", "Eval coverage references are valid", bad, "error", None);

    let ok = !checks.iter().any(|c| c["passed"] == json!(false) && c["severity"] == json!("error"));
    let passed = checks.iter().filter(|c| c["passed"] == json!(true)).count();
    let mut matrix = Map::new();
    for r in &reqs {
        let rid = s(r, "id");
        let crit: Vec<Value> = objs(r, "acceptance_criteria")
            .iter()
            .map(|a| json!({"id": s(a, "id"), "covered": covered.contains(&format!("{rid}#{}", s(a, "id")))}))
            .collect();
        matrix.insert(
            rid.into(),
            json!({"title": s(r, "title"), "status": s(r, "status"), "stories": req_to_stories.get(rid).cloned().unwrap_or_default(), "criteria": crit}),
        );
    }
    let evals_total: usize = stories.iter().map(|st| objs(st, "evals").len()).sum();
    json!({
        "ok": ok,
        "score": round3(passed as f64 / checks.len() as f64),
        "metrics": {"requirements": reqs.len(), "active": active.len(), "epics": epics.len(), "stories": stories.len(),
                    "tasks": tasks.len(), "evals": evals_total,
                    "requirement_coverage": round3(req_cov), "criteria_coverage": round3(ac_cov)},
        "checks": checks,
        "matrix": matrix,
    })
}

pub fn to_markdown(rep: &Value) -> String {
    let m = &rep["metrics"];
    let pct = |v: &Value| format!("{:.0}%", v.as_f64().unwrap_or(0.0) * 100.0);
    let mut out = vec![
        format!("# Traceability report — {} (score {})", if rep["ok"] == json!(true) { "PASS" } else { "FAIL" }, pct(&rep["score"])),
        String::new(),
        format!(
            "requirements {} (active {}) · epics {} · stories {} · tasks {} · evals {}",
            m["requirements"], m["active"], m["epics"], m["stories"], m["tasks"], m["evals"]
        ),
        format!("requirement coverage {} · criteria coverage {}", pct(&m["requirement_coverage"]), pct(&m["criteria_coverage"])),
        String::new(),
        "| check | result | failures |".into(),
        "|---|---|---|".into(),
    ];
    let checks = rep["checks"].as_array().cloned().unwrap_or_default();
    for c in &checks {
        let res = if c["passed"] == json!(true) { "pass".to_string() } else { c["severity"].as_str().unwrap_or("").to_string() };
        out.push(format!("| {} | {} | {} |", c["name"].as_str().unwrap_or(""), res, c["failures"].as_array().map(Vec::len).unwrap_or(0)));
    }
    for c in &checks {
        let f = c["failures"].as_array().cloned().unwrap_or_default();
        if !f.is_empty() {
            out.push(String::new());
            out.push(format!("## {}", c["name"].as_str().unwrap_or("")));
            out.extend(f.iter().take(50).map(|x| format!("- {}", x.as_str().unwrap_or(""))));
        }
    }
    if let Some(matrix) = rep["matrix"].as_object() {
        out.extend(["".into(), "## Matrix".into(), "".into(), "| requirement | status | stories | criteria covered |".into(), "|---|---|---|---|".into()]);
        let sorted: BTreeMap<&String, &Value> = matrix.iter().collect();
        for (rid, row) in sorted {
            let crit = row["criteria"].as_array().cloned().unwrap_or_default();
            let cov = if crit.is_empty() {
                "—".to_string()
            } else {
                format!("{}/{}", crit.iter().filter(|c| c["covered"] == json!(true)).count(), crit.len())
            };
            let stories: Vec<&str> = row["stories"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            out.push(format!(
                "| {} {} | {} | {} | {} |",
                rid,
                row["title"].as_str().unwrap_or(""),
                row["status"].as_str().unwrap_or(""),
                if stories.is_empty() { "—".to_string() } else { stories.join(", ") },
                cov
            ));
        }
    }
    out.join("\n") + "\n"
}
