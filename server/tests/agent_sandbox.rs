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

/// Run several tasks at once on one runner while `during` runs; returns each task's events in order.
fn run_parallel(f: &Fx, tasks: &[&str], during: impl FnOnce() + Send + 'static) -> Vec<Vec<Value>> {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let runner = std::sync::Arc::new(reqforge::agent::AgentRunner::default());
        let mut hs = vec![];
        for t in tasks {
            let (tx, mut rx) = tokio::sync::mpsc::channel(256);
            let (r, store, t) = (runner.clone(), f.store.clone(), t.to_string());
            tokio::spawn(async move { r.run(store, t, "tester".into(), tx).await });
            hs.push(tokio::spawn(async move {
                let mut out = vec![];
                while let Some(ev) = rx.recv().await {
                    out.push(ev);
                }
                out
            }));
        }
        tokio::task::spawn_blocking(during).await.unwrap();
        let mut all = vec![];
        for h in hs {
            all.push(h.await.unwrap());
        }
        all
    })
}

fn ended(store: &reqforge::store::Store, task: &str) -> bool {
    reqforge::agent::runs(store, task).iter().any(|r| r["kind"] == json!("agent"))
}

fn retitle(store: &reqforge::store::Store) {
    let mut p = serde_json::Map::new();
    p.insert("title".into(), json!("Answer, revised"));
    store.update(reqforge::model::Kind::Requirements, "REQ-0001", &p, None, None).unwrap();
}

// reqforge: verifies REQ-0052#AC6
#[test]
fn parallel_runs_do_not_flag_each_others_run_logs_or_record_updates() {
    let f = fx("SBXD", "Implement feature PAUSE");
    let t2 = add_task(&f, "Implement other feature", json!([]));
    let (store, fast) = (f.store.clone(), t2.clone());
    let r = run_parallel(&f, &["TASK-0001", &t2], move || {
        // the fast run ends and commits its run log while the slow one is still going
        assert!(wait_until(|| ended(&store, &fast), 20));
        assert!(!ended(&store, "TASK-0001"), "the slow run should still be going");
        // and a user updates a record through reqforge meanwhile
        retitle(&store);
    });
    assert!(ended(&f.store, "TASK-0001") && ended(&f.store, &t2));
    for evs in &r {
        let res = result(evs);
        assert_eq!(res["violations"], json!([]), "{res}");
    }
}

// reqforge: verifies REQ-0052#AC6
#[test]
fn a_snapshot_never_sees_a_reqforge_write_half_done() {
    let f = fx("SBXE", "Implement feature");
    let store = f.store.clone();
    let writer = std::thread::spawn(move || {
        let _g = store.lock().unwrap();
        std::fs::write(store.root.join("other-run.json"), "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        store.commit("other run: log");
    });
    std::thread::sleep(std::time::Duration::from_millis(100));
    let (before, watch) = reqforge::agent::snapshot_begin(&f.code, &f.store);
    let after = reqforge::agent::snapshot_end(&f.code, &f.store, watch);
    writer.join().unwrap();
    assert_eq!(reqforge::agent::violations(&before, &after), Vec::<String>::new());
}

// reqforge: verifies REQ-0052#AC6
#[test]
fn an_agent_edit_to_the_requirements_repo_is_flagged_even_when_reqforge_commits_it() {
    let f = fx("SBXF", "Implement feature MISBEHAVE PAUSE");
    let (root, store) = (f.store.root.clone(), f.store.clone());
    let r = run_parallel(&f, &["TASK-0001"], move || {
        assert!(wait_until(|| root.join("sneaky.txt").exists(), 20));
        // a reqforge commit sweeps the agent's file into history before the run ends
        retitle(&store);
    });
    assert_eq!(git(&f.store.root, &["status", "--porcelain", "--", "sneaky.txt"]), "", "reqforge committed sneaky.txt");
    let res = result(&r[0]);
    let v: Vec<&str> = res["violations"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(v.iter().any(|x| x.contains("requirements repository") && x.contains("sneaky.txt")), "{v:?}");
}

// reqforge: verifies REQ-0052#AC3
#[test]
fn coding_agent_bash_is_limited_to_worktree_file_ops_and_read_only_reqforge() {
    let allowed = reqforge::agent::allowed_tools();
    for c in ["git rm", "git mv", "mkdir", "ls", "chmod +x", "bin/reqforge lint", "bin/reqforge verify", "./bin/reqforge show"] {
        assert!(allowed.contains(&format!("Bash({c}:*)")), "{c} should be allowed");
    }
    for c in ["bin/reqforge", "./bin/reqforge", "bin/reqforge edit", "bin/reqforge bulk", "bin/reqforge import", "bin/reqforge rm", "bash", "sh", "chmod", "rm"] {
        assert!(!allowed.contains(&format!("Bash({c}:*)")), "{c} must not be allowed");
    }
}
