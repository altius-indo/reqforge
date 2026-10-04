//! REQ-0056: complete a task from its agent branch; REQ-0052#AC5 sandboxed eval run; REQ-0051#AC7.
mod common;
use common::agentfx::*;
use reqforge::agent::AgentRunner;
use reqforge::model::Kind;
use serde_json::{json, Value};

/// Run the fake agent on TASK-0001 (creates reqforge/TASK-0001 with one commit) and set the story's eval.
fn ready(key: &str, eval_cmd: &str) -> Fx {
    let f = fx(key, "Implement feature");
    let r = result(&run(&f));
    assert_eq!(r["exit_status"], json!(0), "{r}");
    f.store
        .update(Kind::Stories, "STORY-0001", &rec(json!({"evals": [{"id": "E1", "name": "feature exists", "kind": "unit", "command": eval_cmd, "covers": ["REQ-0001#AC1"]}]})), None, None)
        .unwrap();
    f
}

fn complete(f: &Fx) -> Result<Value, reqforge::store::StoreError> {
    reqforge::complete::complete(&f.store, &AgentRunner::default(), "TASK-0001", None, "tester")
}

fn status(f: &Fx, k: Kind, id: &str) -> String {
    f.store.get(k, id).unwrap()["status"].as_str().unwrap().to_string()
}

fn detail(e: &reqforge::store::StoreError) -> Value {
    e.details[0].clone()
}

// reqforge: verifies REQ-0056#AC5
// reqforge: verifies REQ-0056#AC6
#[test]
fn complete_lands_the_branch_and_cascades() {
    let f = ready("CMPA", "test -f feature.py");
    let review = reqforge::complete::branch_review(&f.store, &AgentRunner::default(), "TASK-0001").unwrap();
    assert_eq!(review["complete"]["ready"], json!(true), "{review}");
    assert_eq!(review["commits"][0]["message"], json!("TASK-0001: implement feature"));
    assert!(review["files"].as_array().unwrap().iter().any(|x| x["path"] == json!("feature.py")));
    assert!(review["diff"].as_str().unwrap().contains("return 42"));
    let out = complete(&f).unwrap();
    assert_eq!(out["changed"], json!(["TASK-0001", "STORY-0001", "EPIC-0001"]));
    assert_eq!(out["evals"][0]["status"], json!("passed"));
    assert_eq!(out["cleanup_warnings"], json!([]));
    // landed with --no-ff on main
    assert_eq!(git(&f.code, &["log", "-1", "--format=%s"]), "TASK-0001: complete — Implement feature");
    assert_eq!(git(&f.code, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3, "merge commit has two parents");
    assert!(f.code.join("feature.py").exists());
    for (k, id) in [(Kind::Tasks, "TASK-0001"), (Kind::Stories, "STORY-0001"), (Kind::Epics, "EPIC-0001")] {
        assert_eq!(status(&f, k, id), "done", "{id}");
    }
    assert!(!worktree(&f).exists(), "worktree removed");
    assert!(git(&f.code, &["branch", "--list", "reqforge/TASK-0001"]).is_empty(), "branch deleted");
    let runs = reqforge::agent::runs(&f.store, "TASK-0001");
    assert!(runs.iter().any(|r| r["kind"] == json!("complete") && r["outcome"] == json!("completed")));
}

// reqforge: verifies REQ-0056#AC6
#[test]
fn story_stays_open_while_other_tasks_are() {
    let f = ready("CMPB", "test -f feature.py");
    add_task(&f, "docs", json!([]));
    let out = complete(&f).unwrap();
    assert_eq!(out["changed"], json!(["TASK-0001"]));
    assert_eq!(status(&f, Kind::Stories, "STORY-0001"), "in-progress");
}

// reqforge: verifies REQ-0056#AC2
#[test]
fn complete_refuses_a_dirty_checkout() {
    let f = ready("CMPC", "test -f feature.py");
    std::fs::write(f.code.join("scratch.txt"), "wip").unwrap();
    let e = complete(&f).unwrap_err();
    assert_eq!(e.status, 409);
    assert_eq!(detail(&e)["step"], json!("preconditions"));
    assert!(e.message.contains("uncommitted changes outside the requirements folder") && e.message.contains("scratch.txt"), "{}", e.message);
    assert_eq!(status(&f, Kind::Tasks, "TASK-0001"), "in-progress");
    let review = reqforge::complete::branch_review(&f.store, &AgentRunner::default(), "TASK-0001").unwrap();
    assert_eq!(review["complete"]["ready"], json!(false));
}

// reqforge: verifies REQ-0056#AC3
#[test]
fn complete_aborts_on_conflict_and_leaves_both_branches() {
    let f = ready("CMPD", "test -f feature.py");
    std::fs::write(f.code.join("feature.py"), "def feature():\n    return 41\n").unwrap();
    git(&f.code, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(&f.code, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "conflicting change on main"]);
    let (main_before, task_before) = (git(&f.code, &["rev-parse", "main"]), git(&f.code, &["rev-parse", "reqforge/TASK-0001"]));
    let e = complete(&f).unwrap_err();
    let d = detail(&e);
    assert_eq!((d["step"].clone(), d["conflicts"].clone()), (json!("merge"), json!(["feature.py"])), "{d}");
    assert_eq!(d["task_head_restored"], json!(true));
    assert_eq!(git(&f.code, &["rev-parse", "main"]), main_before);
    assert_eq!(git(&f.code, &["rev-parse", "reqforge/TASK-0001"]), task_before);
    assert!(git(&worktree(&f), &["status", "--porcelain"]).is_empty(), "merge aborted cleanly");
}

// reqforge: verifies REQ-0056#AC4
#[test]
fn complete_refuses_when_story_evals_fail() {
    let f = ready("CMPE", "echo boom >&2; exit 3");
    let main_before = git(&f.code, &["rev-parse", "main"]);
    let e = complete(&f).unwrap_err();
    let d = detail(&e);
    assert_eq!(d["step"], json!("evals"));
    assert_eq!(d["failed"][0]["id"], json!("E1"));
    assert!(d["failed"][0]["output_tail"].as_str().unwrap().contains("boom"));
    assert_eq!(git(&f.code, &["rev-parse", "main"]), main_before, "nothing lands");
    assert_eq!(status(&f, Kind::Tasks, "TASK-0001"), "in-progress");
}

// reqforge: verifies REQ-0052#AC5
#[test]
fn eval_run_sandboxed_against_writes_outside_the_worktree() {
    let f = fx("CMPF", "Implement feature");
    result(&run(&f));
    let outside = f.store.root.join("leak.txt");
    f.store
        .update(Kind::Stories, "STORY-0001", &rec(json!({"evals": [{"id": "E1", "name": "leaky", "kind": "unit",
            "command": format!("echo leak > {}", outside.display()), "covers": ["REQ-0001#AC1"]}]})), None, None)
        .unwrap();
    let e = complete(&f).unwrap_err();
    assert_eq!(detail(&e)["step"], json!("sandbox"), "{:?}", e.details);
    assert!(e.message.contains("requirements repository"), "{}", e.message);
    assert_eq!(status(&f, Kind::Tasks, "TASK-0001"), "in-progress");
    assert!(reqforge::agent::runs(&f.store, "TASK-0001").iter().any(|r| r["outcome"] == json!("refused: sandbox violation")), "logged with the task's runs");
}

// reqforge: verifies REQ-0052#AC5
#[test]
fn eval_run_sandboxed_against_commits_and_branches() {
    let f = ready("CMPG", "git -c user.email=e@e -c user.name=e commit -q --allow-empty -m sneaky");
    let e = complete(&f).unwrap_err();
    assert_eq!(detail(&e)["step"], json!("sandbox"));
    assert!(e.message.contains("made commits"), "{}", e.message);
    f.store
        .update(Kind::Stories, "STORY-0001", &rec(json!({"evals": [{"id": "E1", "name": "branchy", "kind": "unit", "command": "git branch sneaky", "covers": ["REQ-0001#AC1"]}]})), None, None)
        .unwrap();
    let e = complete(&f).unwrap_err();
    assert!(e.message.contains("refs/heads/sneaky"), "{}", e.message);
    assert_eq!(git(&f.code, &["log", "-1", "--format=%s", "main"]), "base");
}

// reqforge: verifies REQ-0051#AC7
#[test]
fn start_with_agent_warns_about_parallel_branches() {
    let f = fx("CMPH", "Implement feature");
    let second = add_task(&f, "Second task", json!([]));
    result(&run(&f)); // TASK-0001 now in-progress with an unmerged branch
    let plan = reqforge::agent::plan(&f.store, &second).unwrap();
    let par = plan["parallel"].as_array().unwrap();
    assert_eq!(par.len(), 1, "{plan}");
    assert_eq!((par[0]["id"].clone(), par[0]["branch"].clone(), par[0]["ahead"].clone()), (json!("TASK-0001"), json!("reqforge/TASK-0001"), json!(1)));
    assert_eq!(plan["ready"], json!(true), "the warning is advisory");
    assert_eq!(reqforge::agent::plan(&f.store, "TASK-0001").unwrap()["parallel"], json!([]));
}
