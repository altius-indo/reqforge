//! PR impact analysis: which requirements and acceptance criteria a code change touches,
//! which tests and evals must re-run, and which verified criteria it puts at risk.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use globset::{Glob, GlobSetBuilder};
use serde_json::{json, Value};

use crate::codetrace::{component_root, load_index, scan_dir_mode, Tag};
use crate::evidence::load_latest;
use crate::model::{objs, s, strs, Kind};
use crate::store::{Res, Source, Store, StoreError};

fn git(root: &Path, args: &[&str]) -> Res<String> {
    let o = Command::new("git").arg("-C").arg(root).args(args).output().map_err(|e| StoreError::bad(format!("git: {e}")))?;
    if !o.status.success() {
        return Err(StoreError::bad(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&o.stdout).to_string())
}

/// Files changed relative to `base` (committed and uncommitted) plus untracked files, relative to `root`.
pub fn changed_files(root: &Path, base: &str) -> Res<Vec<String>> {
    let mut files: BTreeSet<String> = git(root, &["diff", "--name-only", "--relative", base])?.lines().map(String::from).collect();
    files.extend(git(root, &["ls-files", "--others", "--exclude-standard"])?.lines().map(String::from));
    Ok(files.into_iter().filter(|f| !f.is_empty()).collect())
}

// reqforge: implements REQ-0023
/// Analyse one component checkout. `base` defaults to origin/main, falling back to main.
pub fn impact(store: &Store, component: Option<&str>, root_override: Option<&Path>, base: Option<&str>) -> Res<Value> {
    let comps = store.records(Kind::Components);
    let comp = match component {
        Some(k) => comps.iter().find(|c| s(c, "key") == k).cloned().ok_or_else(|| StoreError::new(format!("unknown component '{k}'"), 404))?,
        None if comps.len() == 1 => comps[0].clone(),
        None => return Err(StoreError::bad("pass --component KEY (impact analyses one component checkout)")),
    };
    let key = s(&comp, "key").to_string();
    let root: PathBuf = root_override.map(Path::to_path_buf).or_else(|| component_root(store, &comp)).ok_or_else(|| StoreError::bad(format!("component {key} has no path; pass --root")))?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let base = match base {
        Some(b) => b.to_string(),
        None => ["origin/main", "main", "origin/master", "master"]
            .iter()
            .find(|b| git(&root, &["rev-parse", "--verify", "--quiet", b]).is_ok())
            .map(|b| b.to_string())
            .ok_or_else(|| StoreError::bad("no base branch found; pass --base REF"))?,
    };
    let globs: Vec<String> = strs(&comp, "globs").into_iter().map(String::from).collect();
    let mut gb = GlobSetBuilder::new();
    for g in if globs.is_empty() { vec!["**".to_string()] } else { globs.clone() } {
        gb.add(Glob::new(&g).map_err(|e| StoreError::bad(e.to_string()))?);
    }
    let set = gb.build().map_err(|e| StoreError::bad(e.to_string()))?;
    let changed: Vec<String> = changed_files(&root, &base)?.into_iter().filter(|f| set.is_match(f)).collect();

    // tags as they are now (fresh scan) plus tags of files that no longer exist (stored index)
    let now_idx = scan_dir_mode(&root, &key, &globs, Some(&store.root), s(&comp, "tag_mode") == "explicit")?;
    let old_idx = load_index(&store.root, &key).unwrap_or_default();
    let in_changed = |t: &&Tag| changed.contains(&t.file);
    let mut touched: Vec<&Tag> = now_idx.tags.iter().filter(in_changed).collect();
    touched.extend(old_idx.tags.iter().filter(|t| changed.contains(&t.file) && !root.join(&t.file).exists()));

    let reqs = store.records(Kind::Requirements);
    let mut by_req: BTreeMap<String, Value> = BTreeMap::new();
    for t in &touched {
        let e = by_req.entry(t.req.clone()).or_insert_with(|| {
            let r = reqs.iter().find(|r| s(r, "id") == t.req);
            json!({"id": t.req, "title": r.map(|r| s(r, "title")).unwrap_or("(unknown requirement)"), "via": []})
        });
        e["via"].as_array_mut().unwrap().push(json!({"kind": t.kind, "file": t.file, "line": t.line, "symbol": t.symbol}));
    }
    let req_ids: BTreeSet<String> = by_req.keys().cloned().collect();

    // tests to re-run: every test tagged for a touched requirement (anywhere in the component)
    let mut tests: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for t in now_idx.tags.iter().filter(|t| t.kind == "verifies" && req_ids.contains(&t.req)) {
        tests.entry(t.file.clone()).or_default().insert(t.symbol.clone().unwrap_or_default());
    }
    let mut evals = vec![];
    for st in store.records(Kind::Stories) {
        for ev in objs(&st, "evals") {
            if strs(ev, "covers").iter().any(|c| req_ids.contains(c.split('#').next().unwrap_or(""))) {
                evals.push(json!({"story": s(&st, "id"), "id": s(ev, "id"), "kind": s(ev, "kind"), "command": s(ev, "command")}));
            }
        }
    }
    // verified criteria whose evidence vouched for a changed file
    let changed_keys: BTreeSet<String> = changed.iter().map(|f| format!("{key}:{f}")).collect();
    let at_risk: BTreeSet<String> = load_latest(&store.root)
        .values()
        .filter(|e| e.status == "passed" && e.hashes.keys().any(|k| changed_keys.contains(k)))
        .map(|e| e.target.clone())
        .collect();
    let tagged_files: BTreeSet<&str> = now_idx.tags.iter().map(|t| t.file.as_str()).collect();
    let untraced: Vec<&String> = changed.iter().filter(|f| !tagged_files.contains(f.as_str()) && !crate::codetrace::is_test_file(f)).collect();

    Ok(json!({
        "component": key, "root": root.display().to_string(), "base": base, "changed_files": changed,
        "requirements": by_req.into_values().collect::<Vec<_>>(),
        "tests": tests.into_iter().map(|(f, syms)| json!({"file": f, "symbols": syms.into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "evals": evals, "criteria_at_risk": at_risk, "untraced_changes": untraced,
    }))
}

pub fn to_markdown(rep: &Value) -> String {
    let n = |k: &str| rep[k].as_array().map(Vec::len).unwrap_or(0);
    let mut out = vec![
        format!("### reqforge impact — `{}` vs `{}`", rep["component"].as_str().unwrap_or(""), rep["base"].as_str().unwrap_or("")),
        format!(
            "{} changed files · **{} requirements touched** · {} test files and {} evals to re-run · {} verified criteria at risk",
            n("changed_files"), n("requirements"), n("tests"), n("evals"), n("criteria_at_risk")
        ),
    ];
    if n("requirements") > 0 {
        out.push(String::new());
        out.push("| requirement | via |".into());
        out.push("|---|---|".into());
        for r in rep["requirements"].as_array().into_iter().flatten() {
            let via: Vec<String> = r["via"]
                .as_array()
                .into_iter()
                .flatten()
                .take(4)
                .map(|v| format!("{} `{}:{}`", v["kind"].as_str().unwrap_or(""), v["file"].as_str().unwrap_or(""), v["line"]))
                .collect();
            out.push(format!("| {} {} | {} |", r["id"].as_str().unwrap_or(""), r["title"].as_str().unwrap_or(""), via.join("<br>")));
        }
    }
    let risk: Vec<&str> = rep["criteria_at_risk"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !risk.is_empty() {
        out.push(String::new());
        out.push(format!("**Must re-verify:** {}", risk.join(", ")));
    }
    let untraced: Vec<&str> = rep["untraced_changes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if !untraced.is_empty() {
        out.push(String::new());
        out.push(format!("Changed code with no trace tags ({}): {}", untraced.len(), untraced.iter().take(15).map(|f| format!("`{f}`")).collect::<Vec<_>>().join(", ")));
    }
    out.join("\n") + "\n"
}
