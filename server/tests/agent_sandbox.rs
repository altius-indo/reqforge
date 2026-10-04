//! REQ-0052: the coding agent sandbox.
mod common;
use common::agentfx::*;
use serde_json::{json, Value};

fn args(f: &Fx) -> Vec<String> {
    std::fs::read_to_string(worktree(f).join("agent-args.txt")).unwrap().lines().map(String::from).collect()
}

fn arg_after(a: &[String], flag: &str) -> String {
    a.iter().position(|x| x == flag).map(|i| a[i + 1].clone()).unwrap_or_default()
}

// reqforge: verifies REQ-0052#AC1
#[test]
fn no_push_and_default_branch_untouched() {
    let f = fx("SBXA", "Implement feature");
    let main_before = git(&f.code, &["rev-parse", "main"]);
    let r = result(&run(&f));
    assert_eq!(git(&f.code, &["rev-parse", "main"]), main_before, "0 commits reach the default branch");
    assert_eq!(git(&f.code, &["log", "--format=%s", "-1", "reqforge/TASK-0001"]), "TASK-0001: implement feature");
    let a = args(&f);
    let denied = arg_after(&a, "--disallowedTools");
    for d in ["Bash(git push:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git reset:*)", "Bash(git merge:*)"] {
        assert!(denied.split(',').any(|x| x == d), "{d} must be denied: {denied}");
    }
    assert!(!arg_after(&a, "--allowedTools").contains("git push"));
    assert_eq!(r["violations"], json!([]));
}

// reqforge: verifies REQ-0052#AC2
#[test]
fn writes_outside_the_worktree_are_detected_and_editing_is_confined() {
    let f = fx("SBXB", "Implement feature MISBEHAVE");
    let r = result(&run(&f));
    let v: Vec<&str> = r["violations"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(v.iter().any(|x| x.contains("requirements repository")), "{v:?}");
    assert!(v.iter().any(|x| x.contains("component checkout outside the task worktree")), "{v:?}");
    // prevention: edits auto-approved only inside the working directory, no extra directories granted
    let a = args(&f);
    assert_eq!(arg_after(&a, "--permission-mode"), "acceptEdits");
    assert!(!a.iter().any(|x| x == "--add-dir"));
}

// reqforge: verifies REQ-0052#AC3
#[test]
fn coding_agent_has_no_reqforge_write_tools() {
    let allowed = reqforge::agent::allowed_tools();
    let denied = reqforge::agent::denied_tools();
    let mcp: Vec<String> = reqforge::mcp::tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    for t in &mcp {
        let full = format!("{}{t}", reqforge::chat::MCP);
        assert!(allowed.contains(&full) || denied.contains(&full), "MCP tool {t} is neither allowed nor denied for the coding agent");
    }
    for w in ["create", "update", "delete", "bulk_update", "upsert_many", "apply_changeset", "propose_changeset", "sync", "ingest_evidence", "scan_code"] {
        let full = format!("{}{w}", reqforge::chat::MCP);
        assert!(denied.contains(&full) && !allowed.contains(&full), "{w}");
    }
}

// reqforge: verifies REQ-0052#AC4
#[test]
fn every_run_is_logged() {
    let f = fx("SBXC", "Implement feature");
    let r = result(&run(&f));
    let logs = reqforge::agent::runs(&f.store, "TASK-0001");
    assert_eq!(logs.len(), 1);
    let l = &logs[0];
    for k in ["run_id", "task", "user", "started", "ended", "branch", "exit_status", "commits", "violations"] {
        assert!(!l[k].is_null(), "run log misses {k}: {l}");
    }
    assert_eq!((l["task"].clone(), l["user"].clone(), l["branch"].clone()), (json!("TASK-0001"), json!("tester"), json!("reqforge/TASK-0001")));
    assert_eq!(l["run_id"], r["run_id"]);
    let committed = git(&f.store.root, &["log", "--format=%s", "-1"]);
    assert!(committed.contains("agent run RUN-TASK-0001-"), "{committed}");
}

// reqforge: verifies REQ-0052#AC1
#[test]
fn reqforge_commits_to_its_requirements_folder_are_not_violations() {
    let d = tempfile::TempDir::new().unwrap();
    let repo = d.path();
    git(repo, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(repo.join("requirements")).unwrap();
    std::fs::write(repo.join("requirements/a.json"), "{}").unwrap();
    std::fs::write(repo.join("app.rs"), "fn main() {}").unwrap();
    git(repo, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    let reqs = repo.join("requirements");
    let commit = |file: &str, body: &str| {
        std::fs::write(repo.join(file), body).unwrap();
        git(repo, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
        git(repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file]);
    };
    let s0 = reqforge::agent::snapshot(repo, &reqs);
    commit("requirements/a.json", "{\"run\": 1}"); // reqforge writing a run log / task start
    let s1 = reqforge::agent::snapshot(repo, &reqs);
    assert_eq!(reqforge::agent::violations(&s0, &s1), Vec::<String>::new());
    commit("app.rs", "fn main() { evil(); }"); // a commit to code on the checked-out branch
    let s2 = reqforge::agent::snapshot(repo, &reqs);
    let v = reqforge::agent::violations(&s1, &s2);
    assert!(v[0].contains("checked-out branch moved"), "{v:?}");
}
