//! Eval registry + runner. Evals live on stories; the runner executes the ones for a pipeline
//! stage inside the code repo and reports results keyed back to story and requirement acceptance
//! criteria, so a red build names the requirement at risk.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::model::{eval_stage, objs, s, strs, Kind, STAGES};
use crate::store::{now, Source};

pub fn registry(src: &dyn Source, stage: Option<&str>, component: Option<&str>) -> Vec<Value> {
    let mut out = vec![];
    for st in src.records(Kind::Stories) {
        if let Some(c) = component {
            if !s(&st, "component").is_empty() && s(&st, "component") != c {
                continue;
            }
        }
        for ev in objs(&st, "evals") {
            let sg = eval_stage(s(ev, "kind")).unwrap_or("acceptance");
            if stage.map(|x| x != sg).unwrap_or(false) {
                continue;
            }
            let mut e = json!({"story": s(&st, "id"), "story_title": s(&st, "title"), "requirements": strs(&st, "requirements"), "stage": sg});
            for (k, v) in ev {
                e[k] = v.clone();
            }
            out.push(e);
        }
    }
    let pos = |v: &Value| STAGES.iter().position(|x| Some(*x) == v["stage"].as_str()).unwrap_or(0);
    out.sort_by(|a, b| {
        pos(a).cmp(&pos(b)).then(a["story"].as_str().cmp(&b["story"].as_str())).then(a["id"].as_str().cmp(&b["id"].as_str()))
    });
    out
}

fn brief(ev: &Value) -> Value {
    let mut b = json!({});
    for k in ["story", "id", "name", "kind", "stage", "covers", "requirements", "command"] {
        b[k] = ev.get(k).cloned().unwrap_or(Value::Null);
    }
    b["required"] = ev.get("required").cloned().unwrap_or(json!(true));
    b
}

fn run_one(command: &str, workdir: &Path, story: &str, eval_id: &str, timeout: Duration) -> (bool, String) {
    run_one_with(command, workdir, story, eval_id, timeout, false)
}

/// Run one eval command; `clean_env` strips reqforge's repository variables (sandboxed runs).
pub fn run_one_with(command: &str, workdir: &Path, story: &str, eval_id: &str, timeout: Duration, clean_env: bool) -> (bool, String) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let out_path = std::env::temp_dir().join(format!("reqforge-eval-{}-{seq}-{}.log", std::process::id(), eval_id.replace('/', "_")));
    let Ok(log) = fs::File::create(&out_path) else { return (false, "cannot create log".into()) };
    let mut cmd = Command::new("sh");
    if clean_env {
        for k in ["REQFORGE_REPO", "REQFORGE_PROJECT", "REQFORGE_WORKSPACE", "REQFORGE_TASK", "REQFORGE_MCP_ROLE", "REQFORGE_MCP_PROJECT", "REQFORGE_BIN"] {
            cmd.env_remove(k);
        }
    }
    let child = cmd
        .arg("-c")
        .arg(command)
        .current_dir(workdir)
        .env("REQFORGE_STORY", story)
        .env("REQFORGE_EVAL", eval_id)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn();
    let Ok(mut child) = child else { return (false, format!("cannot start: {command}")) };
    let t0 = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) if t0.elapsed() > timeout => {
                child.kill().ok();
                child.wait().ok();
                let _ = fs::remove_file(&out_path);
                return (false, "timeout".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break false,
        }
    };
    let text = fs::read_to_string(&out_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    let tail: String = text.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
    (ok, tail)
}

// reqforge: implements REQ-0011
pub fn run(src: &dyn Source, stage: &str, workdir: &Path, component: Option<&str>, report_dir: Option<&Path>) -> Result<Value, String> {
    if !STAGES.contains(&stage) {
        return Err(format!("unknown stage '{stage}' (expected one of {})", crate::model::pylist(STAGES)));
    }
    let mut results = vec![];
    for ev in registry(src, Some(stage), component) {
        let mut r = brief(&ev);
        let cmd = ev["command"].as_str().unwrap_or("");
        if cmd.is_empty() {
            r["status"] = json!("skipped");
            r["reason"] = json!("no command");
            results.push(r);
            continue;
        }
        let timeout = Duration::from_secs(ev["timeout"].as_u64().unwrap_or(1800));
        let t0 = Instant::now();
        let (ok, out) = run_one(cmd, workdir, ev["story"].as_str().unwrap_or(""), ev["id"].as_str().unwrap_or(""), timeout);
        r["status"] = json!(if ok { "passed" } else { "failed" });
        r["seconds"] = json!((t0.elapsed().as_secs_f64() * 100.0).round() / 100.0);
        if !ok {
            r["output"] = json!(out);
        }
        results.push(r);
    }
    let failed_required: Vec<&Value> = results.iter().filter(|r| r["status"] == json!("failed") && r["required"] != json!(false)).collect();
    let mut at_risk = BTreeSet::new();
    for r in &failed_required {
        for c in r["covers"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            at_risk.insert(c.split('#').next().unwrap_or("").to_string());
        }
        for q in r["requirements"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            at_risk.insert(q.to_string());
        }
    }
    let count = |st: &str| results.iter().filter(|r| r["status"] == json!(st)).count();
    let rep = json!({
        "stage": stage, "at": now(), "ok": failed_required.is_empty(), "total": results.len(),
        "passed": count("passed"), "failed": count("failed"), "skipped": count("skipped"),
        "requirements_at_risk": at_risk, "results": results,
    });
    let dir = report_dir.map(Path::to_path_buf).unwrap_or_else(|| workdir.join("reqforge-reports"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("evals-{stage}.json")), serde_json::to_string_pretty(&rep).unwrap() + "\n").map_err(|e| e.to_string())?;
    Ok(rep)
}

pub fn to_markdown(rep: &Value) -> String {
    let mut lines = vec![format!(
        "## Evals — {}: {} ({} passed, {} failed, {} skipped)",
        rep["stage"].as_str().unwrap_or(""),
        if rep["ok"] == json!(true) { "PASS" } else { "FAIL" },
        rep["passed"],
        rep["failed"],
        rep["skipped"]
    )];
    let risk: Vec<&str> = rep["requirements_at_risk"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !risk.is_empty() {
        lines.push(format!("Requirements at risk: {}", risk.join(", ")));
    }
    lines.push(String::new());
    lines.push("| story | eval | kind | status | covers |".into());
    lines.push("|---|---|---|---|---|".into());
    for r in rep["results"].as_array().into_iter().flatten() {
        let covers: Vec<&str> = r["covers"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        lines.push(format!(
            "| {} | {} {} | {} | {} | {} |",
            r["story"].as_str().unwrap_or(""),
            r["id"].as_str().unwrap_or(""),
            r["name"].as_str().unwrap_or(""),
            r["kind"].as_str().unwrap_or(""),
            r["status"].as_str().unwrap_or(""),
            covers.join(", ")
        ));
    }
    lines.join("\n") + "\n"
}
