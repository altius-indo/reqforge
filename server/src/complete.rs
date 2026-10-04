//! Complete a task from its agent branch (docs/agent-runs.md "Completing a task from its agent
//! branch", REQ-0056; sandboxed eval run REQ-0052#AC5).
//!
//! One action: check preconditions, merge the target into the task branch in its worktree, run the
//! story's evals there under the agent sandbox checks, land the branch on the target with --no-ff,
//! cascade task -> story -> epic to done, and remove the worktree and branch. Every attempt is
//! logged next to the task's agent runs.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::{resolve, snapshot, violations, AgentRunner, Plan, Snapshot};
use crate::model::{objs, s, Kind, Rec};
use crate::store::{dump, now, Res, Source, Store, StoreError};

/// One Complete at a time per project (requirements repo root).
static COMPLETING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
const DIFF_CAP: usize = 512 * 1024;

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).trim().to_string())
    }
}

fn refused(step: &str, reason: impl Into<String>, extra: Value) -> StoreError {
    let reason = reason.into();
    let mut d = json!({"step": step, "reason": reason});
    if let (Some(o), Some(x)) = (d.as_object_mut(), extra.as_object()) {
        o.extend(x.clone());
    }
    StoreError::with(format!("Complete refused at {step}: {reason}"), 409, vec![d])
}

struct Ctx {
    plan: Plan,
    top: PathBuf,
    target: String,
}

fn ctx(store: &Store, task_id: &str) -> Res<Ctx> {
    let plan = resolve(store, task_id)?;
    let top = git(&plan.component_root, &["rev-parse", "--show-toplevel"]).map_err(|e| StoreError::bad(format!("component checkout: {e}")))?;
    let top = std::fs::canonicalize(&top).unwrap_or_else(|_| PathBuf::from(top));
    let target = git(&top, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(StoreError::bad)?;
    Ok(Ctx { plan, top, target })
}

fn branch_exists(top: &Path, branch: &str) -> bool {
    git(top, &["rev-parse", "--verify", "--quiet", branch]).is_ok()
}

/// Step-1 checks (AC2 and the design's guards); empty = ready.
fn preconditions(store: &Store, runner: &AgentRunner, task: &Rec, c: &Ctx) -> Vec<String> {
    let mut r = vec![];
    let id = s(task, "id");
    if s(task, "status") != "in-progress" {
        r.push(format!("task is {}, only in-progress tasks can be completed", s(task, "status")));
    }
    if runner.running(id) {
        r.push("an agent run for this task is still active".into());
    }
    if !branch_exists(&c.top, &c.plan.branch) {
        r.push(format!("branch {} does not exist", c.plan.branch));
        return r;
    }
    let wt = &c.plan.worktree;
    match git(wt, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(b) if b == c.plan.branch => {
            let dirty = git(wt, &["status", "--porcelain"]).unwrap_or_default();
            if !dirty.trim().is_empty() {
                r.push(format!("the task worktree has uncommitted changes: {}", dirty.lines().take(20).collect::<Vec<_>>().join(", ")));
            }
        }
        _ => r.push(format!("worktree {} is missing or not on {}", wt.display(), c.plan.branch)),
    }
    let snap = snapshot(&c.plan.component_root, &store.root);
    if !snap.component_status.trim().is_empty() {
        let paths: Vec<&str> = snap.component_status.lines().take(20).collect();
        r.push(format!("the {} checkout has uncommitted changes outside the requirements folder: {}", c.target, paths.join(", ")));
    }
    r
}

fn merged_into_target(c: &Ctx) -> bool {
    git(&c.top, &["merge-base", "--is-ancestor", &c.plan.branch, &c.target]).is_ok()
}

/// Branch review for the drawer (AC1): commits, files, diff and whether Complete is ready.
// reqforge: implements REQ-0056
pub fn branch_review(store: &Store, runner: &AgentRunner, task_id: &str) -> Res<Value> {
    let task = store.get(Kind::Tasks, task_id)?;
    let c = ctx(store, task_id)?;
    if !branch_exists(&c.top, &c.plan.branch) {
        return Err(StoreError::new(format!("{task_id} has no agent branch {}", c.plan.branch), 404));
    }
    let base = git(&c.top, &["merge-base", &c.target, &c.plan.branch]).unwrap_or_default();
    let commits: Vec<Value> = git(&c.top, &["log", "--format=%h%x09%an%x09%aI%x09%s", &format!("{base}..{}", c.plan.branch)])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.splitn(4, '\t').collect();
            (p.len() == 4).then(|| json!({"sha": p[0], "author": p[1], "at": p[2], "message": p[3]}))
        })
        .collect();
    let files: Vec<Value> = git(&c.top, &["diff", "--name-status", &format!("{base}...{}", c.plan.branch)])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\t').map(|(st, path)| json!({"status": st, "path": path})))
        .collect();
    let mut diff = git(&c.top, &["diff", &format!("{base}...{}", c.plan.branch)]).unwrap_or_default();
    let truncated = diff.len() > DIFF_CAP;
    if truncated {
        let mut cut = DIFF_CAP;
        while !diff.is_char_boundary(cut) {
            cut -= 1;
        }
        diff.truncate(cut);
    }
    let count = |range: String| git(&c.top, &["rev-list", "--count", &range]).ok().and_then(|n| n.trim().parse::<u64>().ok()).unwrap_or(0);
    let mut reasons = preconditions(store, runner, &task, &c);
    let ahead = count(format!("{base}..{}", c.plan.branch));
    if ahead == 0 && !merged_into_target(&c) {
        reasons.push("the task branch has no commits to land".into());
    }
    Ok(json!({"task": task_id, "branch": c.plan.branch, "worktree": c.plan.worktree.display().to_string(), "target": c.target, "base": base,
              "commits": commits, "files": files, "diff": diff, "truncated": truncated,
              "ahead": ahead, "behind": count(format!("{}..{}", c.plan.branch, c.target)),
              "complete": {"ready": reasons.is_empty(), "reasons": reasons}}))
}

fn refs(top: &Path) -> BTreeMap<String, String> {
    git(top, &["for-each-ref", "--format=%(refname) %(objectname)"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(r, o)| (r.to_string(), o.to_string())))
        .collect()
}

/// Sandbox check around one eval (REQ-0052#AC5).
struct Guard {
    snap: Snapshot,
    refs: BTreeMap<String, String>,
    head: String,
}

fn guard(c: &Ctx, store: &Store) -> Guard {
    Guard {
        snap: snapshot(&c.plan.component_root, &store.root),
        refs: refs(&c.top),
        head: git(&c.plan.worktree, &["rev-parse", "HEAD"]).unwrap_or_default(),
    }
}

// reqforge: implements REQ-0052
fn guard_violations(c: &Ctx, store: &Store, before: &Guard) -> Vec<String> {
    let after = guard(c, store);
    let mut v = violations(&before.snap, &after.snap);
    if after.head != before.head {
        v.push("the eval made commits on the task branch".into());
    }
    let target_ref = format!("refs/heads/{}", c.target);
    let task_ref = format!("refs/heads/{}", c.plan.branch);
    for (r, o) in &after.refs {
        if *r == target_ref || *r == task_ref {
            continue; // judged above (target via violations(), task branch via head)
        }
        if before.refs.get(r) != Some(o) {
            v.push(format!("the eval changed ref {r} (commit, branch or push)"));
        }
    }
    for r in before.refs.keys() {
        if !after.refs.contains_key(r) && *r != target_ref && *r != task_ref {
            v.push(format!("the eval deleted ref {r}"));
        }
    }
    v
}

fn log_attempt(store: &Store, task_id: &str, log: &Value) {
    let dir = store.root.join("agent-runs");
    let _ = std::fs::create_dir_all(&dir);
    let id = format!("COMPLETE-{task_id}-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S%3f"));
    let mut l = log.clone();
    l["run_id"] = json!(id);
    l["kind"] = json!("complete");
    if let Ok(_g) = store.lock() {
        let _ = std::fs::write(dir.join(format!("{id}.json")), dump(&l));
        store.commit(&format!("{task_id}: complete attempt {id} ({})", l["outcome"].as_str().unwrap_or("")));
    }
}

/// Task -> story -> epic to done (AC5, AC6), one commit. Returns the ids that moved.
fn cascade(store: &Store, task_id: &str) -> Res<Vec<String>> {
    let _g = store.lock()?;
    let done = |kind: Kind, id: &str| -> Res<Rec> {
        let mut p = Rec::new();
        p.insert("status".into(), json!("done"));
        store.apply_unlocked(kind, id, &p, None, None, None)
    };
    let task = store.get(Kind::Tasks, task_id)?;
    let mut changed = vec![];
    store.write_unlocked(Kind::Tasks, &done(Kind::Tasks, task_id)?)?;
    changed.push(task_id.to_string());
    let story_id = s(&task, "story").to_string();
    let all_tasks_done = store.records(Kind::Tasks).iter().filter(|t| s(t, "story") == story_id).all(|t| s(t, "id") == task_id || s(t, "status") == "done");
    if let Ok(story) = store.get(Kind::Stories, &story_id) {
        if all_tasks_done && s(&story, "status") != "done" && s(&story, "status") != "blocked" {
            store.write_unlocked(Kind::Stories, &done(Kind::Stories, &story_id)?)?;
            changed.push(story_id.clone());
            let epic_id = s(&story, "epic").to_string();
            let all_stories_done = store.records(Kind::Stories).iter().filter(|x| s(x, "epic") == epic_id).all(|x| s(x, "id") == story_id || s(x, "status") == "done");
            if let Ok(epic) = store.get(Kind::Epics, &epic_id) {
                if all_stories_done && s(&epic, "status") != "done" && s(&epic, "status") != "blocked" {
                    store.write_unlocked(Kind::Epics, &done(Kind::Epics, &epic_id)?)?;
                    changed.push(epic_id);
                }
            }
        }
    }
    store.commit(&format!("{task_id}: complete ({} -> done)", changed.join(", ")));
    Ok(changed)
}

/// Complete a task from its agent branch in one action (REQ-0056 AC2–AC6).
// reqforge: implements REQ-0056
pub fn complete(store: &Store, runner: &AgentRunner, task_id: &str, expected_version: Option<i64>, user: &str) -> Res<Value> {
    {
        let mut busy = COMPLETING.lock().unwrap();
        if !busy.insert(store.root.clone()) {
            return Err(refused("preconditions", "another Complete is running in this project", json!({})));
        }
    }
    struct Release(PathBuf);
    impl Drop for Release {
        fn drop(&mut self) {
            COMPLETING.lock().unwrap().remove(&self.0);
        }
    }
    let _release = Release(store.root.clone());

    let task = store.get(Kind::Tasks, task_id)?;
    if let Some(ev) = expected_version {
        let cur = task.get("version").and_then(Value::as_i64).unwrap_or(0);
        if ev != cur {
            return Err(StoreError::new(format!("{task_id} was modified (version {cur}, you had {ev}); reload and retry"), 409));
        }
    }
    let c = ctx(store, task_id)?;
    let started = now();
    let mut log = json!({"task": task_id, "user": user, "started": started, "branch": c.plan.branch, "target": c.target});
    let finish = |log: &mut Value, outcome: &str| {
        log["ended"] = json!(now());
        log["outcome"] = json!(outcome);
        log_attempt(store, task_id, log);
    };

    // already landed (e.g. the status commit failed earlier): only the cascade and cleanup remain
    let landed = branch_exists(&c.top, &c.plan.branch) && merged_into_target(&c) && s(&task, "status") == "in-progress";
    let (merge_commit, evals) = if landed {
        (git(&c.top, &["rev-parse", "HEAD"]).unwrap_or_default(), json!([]))
    } else {
        // 1. preconditions (AC2)
        let mut reasons = preconditions(store, runner, &task, &c);
        if reasons.is_empty() {
            let base = git(&c.top, &["merge-base", &c.target, &c.plan.branch]).unwrap_or_default();
            if git(&c.top, &["rev-list", "--count", &format!("{base}..{}", c.plan.branch)]).map(|n| n.trim() == "0").unwrap_or(true) {
                reasons.push("the task branch has no commits to land".into());
            }
        }
        if !reasons.is_empty() {
            log["reasons"] = json!(reasons);
            finish(&mut log, "refused: preconditions");
            return Err(refused("preconditions", reasons.join("; "), json!({"reasons": reasons})));
        }
        // 2. bring the target into the task branch, in the worktree (AC3)
        let wt = c.plan.worktree.clone();
        let h = git(&c.top, &["rev-parse", "HEAD"]).map_err(StoreError::bad)?;
        let t = git(&wt, &["rev-parse", "HEAD"]).map_err(StoreError::bad)?;
        log["target_head"] = json!(h);
        log["task_head"] = json!(t);
        if git(&wt, &["-c", "user.email=reqforge@localhost", "-c", "user.name=reqforge", "merge", "--no-edit", &h]).is_err() {
            let conflicts: Vec<String> = git(&wt, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default().lines().map(String::from).collect();
            let _ = git(&wt, &["merge", "--abort"]);
            let back = git(&wt, &["rev-parse", "HEAD"]).unwrap_or_default();
            log["conflicts"] = json!(conflicts);
            finish(&mut log, "refused: merge conflict");
            return Err(refused(
                "merge",
                format!("merging {} into {} conflicts in {}", c.target, c.plan.branch, conflicts.join(", ")),
                json!({"conflicts": conflicts, "task_head_restored": back == t}),
            ));
        }
        // 3. the story's evals on the merged tree, sandboxed (AC4, REQ-0052#AC5)
        let story = store.get(Kind::Stories, s(&task, "story"))?;
        let mut results = vec![];
        let mut failed = vec![];
        for ev in objs(&story, "evals") {
            let (id, name, cmd) = (s(ev, "id"), s(ev, "name"), s(ev, "command"));
            if cmd.is_empty() {
                results.push(json!({"id": id, "name": name, "status": "skipped"}));
                continue;
            }
            let timeout = Duration::from_secs(ev.get("timeout").and_then(Value::as_u64).unwrap_or(1800));
            let before = guard(&c, store);
            let t0 = std::time::Instant::now();
            let (ok, out) = crate::evals::run_one_with(cmd, &wt, s(&story, "id"), id, timeout, true);
            let secs = (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0;
            let viol = guard_violations(&c, store, &before);
            if !viol.is_empty() {
                results.push(json!({"id": id, "name": name, "command": cmd, "status": "violation", "violations": viol}));
                log["evals"] = json!(results);
                log["violations"] = json!(viol);
                finish(&mut log, "refused: sandbox violation");
                return Err(refused("sandbox", format!("eval {id} broke the sandbox: {}", viol.join("; ")), json!({"eval": id, "violations": viol})));
            }
            let tail: String = out.lines().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let r = json!({"id": id, "name": name, "command": cmd, "status": if ok { "passed" } else { "failed" }, "seconds": secs});
            if !ok {
                failed.push(json!({"id": id, "name": name, "command": cmd, "seconds": secs, "output_tail": tail}));
            }
            results.push(r);
        }
        log["evals"] = json!(results);
        if !failed.is_empty() {
            finish(&mut log, "refused: evals failed");
            let ids: Vec<&str> = failed.iter().filter_map(|f| f["id"].as_str()).collect();
            return Err(refused("evals", format!("{} failed on the merged tree", ids.join(", ")), json!({"failed": failed})));
        }
        // 4. land on the target with --no-ff (AC5), under the store lock so reqforge's own commits don't interleave
        let _g = store.lock()?;
        let head_now = git(&c.top, &["rev-parse", "HEAD"]).unwrap_or_default();
        if head_now != h {
            let snap = snapshot(&c.plan.component_root, &store.root);
            let only_reqs = snap.requirements_rel.as_ref().is_some_and(|r| {
                git(&c.top, &["diff", "--name-only", &h, &head_now]).map(|n| n.lines().all(|f| f.starts_with(&format!("{r}/")))).unwrap_or(false)
            });
            if !only_reqs {
                drop(_g);
                finish(&mut log, "refused: target moved");
                return Err(refused("target-moved", format!("{} moved while the evals ran; retry Complete", c.target), json!({})));
            }
        }
        if !snapshot(&c.plan.component_root, &store.root).component_status.trim().is_empty() {
            drop(_g);
            finish(&mut log, "refused: checkout dirty");
            return Err(refused("preconditions", format!("the {} checkout has uncommitted changes outside the requirements folder", c.target), json!({})));
        }
        let msg = format!("{task_id}: complete — {}", s(&task, "title"));
        if let Err(e) = git(&c.top, &["-c", "user.email=reqforge@localhost", "-c", "user.name=reqforge", "merge", "--no-ff", "--no-edit", "-m", &msg, &c.plan.branch]) {
            let _ = git(&c.top, &["merge", "--abort"]);
            drop(_g);
            finish(&mut log, "refused: land failed");
            return Err(refused("land", e, json!({})));
        }
        (git(&c.top, &["rev-parse", "HEAD"]).unwrap_or_default(), json!(results))
    };
    log["merge_commit"] = json!(merge_commit);

    // 5. status cascade (AC5, AC6)
    let changed = match cascade(store, task_id) {
        Ok(ch) => ch,
        Err(e) => {
            finish(&mut log, "error: status commit failed after landing");
            return Err(StoreError::with(format!("{task_id} landed as {merge_commit} but the status commit failed: {}", e.message), 500, vec![json!({"merge_commit": merge_commit})]));
        }
    };
    // 6. cleanup (AC5)
    let mut warnings = vec![];
    if c.plan.worktree.exists() {
        if let Err(e) = git(&c.top, &["worktree", "remove", &c.plan.worktree.display().to_string()]) {
            warnings.push(format!("worktree not removed ({e}); run: git worktree remove {}", c.plan.worktree.display()));
        }
    }
    if let Err(e) = git(&c.top, &["branch", "-d", &c.plan.branch]) {
        warnings.push(format!("branch not deleted ({e}); run: git branch -d {}", c.plan.branch));
    }
    log["changed"] = json!(changed);
    log["cleanup_warnings"] = json!(warnings);
    finish(&mut log, "completed");
    Ok(json!({"task": task_id, "merge_commit": merge_commit, "changed": changed, "evals": evals, "cleanup_warnings": warnings}))
}

/// Other in-progress tasks of the same story with unmerged agent branches (REQ-0051#AC7).
// reqforge: implements REQ-0051
pub fn parallel_branches(store: &Store, task_id: &str) -> Vec<Value> {
    let Ok(task) = store.get(Kind::Tasks, task_id) else { return vec![] };
    let Ok(c) = ctx(store, task_id) else { return vec![] };
    store
        .records(Kind::Tasks)
        .iter()
        .filter(|t| s(t, "story") == s(&task, "story") && s(t, "id") != task_id && s(t, "status") == "in-progress")
        .filter_map(|t| {
            let b = crate::agent::branch_for(s(t, "id"));
            if !branch_exists(&c.top, &b) || git(&c.top, &["merge-base", "--is-ancestor", &b, &c.target]).is_ok() {
                return None;
            }
            let ahead = git(&c.top, &["rev-list", "--count", &format!("{}..{b}", c.target)]).ok().and_then(|n| n.trim().parse::<u64>().ok()).unwrap_or(0);
            Some(json!({"id": s(t, "id"), "title": s(t, "title"), "branch": b, "ahead": ahead}))
        })
        .collect()
}
