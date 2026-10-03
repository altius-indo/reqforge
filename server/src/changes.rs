//! Change sets: reviewable, atomic batches of create/update/delete ops across any kind.
//!
//! The chat agent can only SIMULATE and PROPOSE; a human applies. Simulation runs the ops on
//! an in-memory overlay and reports validation errors, dangling references, the lint (MECE)
//! delta, the traceability delta and the blast radius. Apply re-checks that nothing it
//! touches changed since the proposal, then writes everything as one git commit.
//!
//! ops: {"op":"create","kind":..,"ref":"r1","data":{..}} | {"op":"update","id":..,"patch":{..},"add":{..},"remove":{..}}
//!      | {"op":"delete","id":..}. Later ops may reference earlier creates as "$r1" (also inside strings).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::model::{coerce, defaults, is_system, objs, s, schema, strs, validate, FType, Kind, Rec, KINDS};
use crate::store::{as_list, dump, now, Res, Source, Store, StoreError};
use crate::{lint, trace};

static REF_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$([A-Za-z][A-Za-z0-9_-]*)").unwrap());
static NUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]+-(\d+)$").unwrap());

/// Read-only, store-shaped view over in-memory records (what lint/trace need).
pub struct View {
    config: Value,
    pub recs: HashMap<Kind, BTreeMap<String, Arc<Rec>>>,
}

impl Source for View {
    fn records(&self, kind: Kind) -> Vec<Arc<Rec>> {
        self.recs.get(&kind).map(|m| m.values().cloned().collect()).unwrap_or_default()
    }
    fn config(&self) -> Value {
        self.config.clone()
    }
    fn exists(&self, kind: Kind, id: &str) -> bool {
        self.recs.get(&kind).map(|m| m.contains_key(id)).unwrap_or(false)
    }
}

pub fn base_view(store: &Store) -> View {
    let recs = KINDS.iter().map(|k| (*k, store.records(*k).into_iter().map(|r| (s(&r, "id").to_string(), r)).collect())).collect();
    View { config: store.config_value(), recs }
}

fn resolve(v: &Value, refmap: &Map<String, Value>) -> Value {
    match v {
        Value::String(st) => Value::String(
            REF_RE
                .replace_all(st, |c: &regex::Captures| {
                    refmap.get(&c[1]).and_then(Value::as_str).map(String::from).unwrap_or_else(|| c[0].to_string())
                })
                .into_owned(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, refmap)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, refmap))).collect()),
        other => other.clone(),
    }
}

fn dangling(view: &View) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for k in KINDS {
        for rec in view.records(k) {
            for f in schema(k) {
                let refs: Vec<&str> = match f.ftype {
                    FType::Ref => rec.get(f.name).and_then(Value::as_str).filter(|x| !x.is_empty()).into_iter().collect(),
                    FType::RefList => strs(&rec, f.name),
                    _ => continue,
                };
                for r in refs {
                    if !view.exists(f.ref_kind.unwrap(), r) {
                        out.insert(format!("{}.{} -> {}", s(&rec, "id"), f.name, r));
                    }
                }
            }
        }
    }
    out
}

pub struct Materialized {
    pub view: View,
    pub base: View,
    pub ops: Vec<Value>,
    pub errors: Vec<String>,
    pub refmap: Map<String, Value>,
}

pub fn materialize(store: &Store, ops: &[Value]) -> Materialized {
    let base = base_view(store);
    let mut recs = base.recs.clone();
    let mut nexts: HashMap<Kind, u64> = HashMap::new();
    for k in KINDS {
        let max = recs[&k].keys().filter_map(|id| NUM_RE.captures(id).and_then(|c| c[1].parse::<u64>().ok())).max().unwrap_or(0);
        nexts.insert(k, max + 1);
    }
    let (mut refmap, mut errors, mut resolved) = (Map::new(), vec![], vec![]);
    let t = now();
    for (i, op) in ops.iter().enumerate() {
        let kind_op = op.get("op").and_then(Value::as_str).unwrap_or("");
        let r: Result<(), String> = (|| {
            match kind_op {
                "create" => {
                    let kind = Kind::parse(op.get("kind").and_then(Value::as_str).ok_or("'kind'")?)?;
                    let n = nexts[&kind];
                    let id = format!("{}-{:04}", kind.prefix(), n);
                    nexts.insert(kind, n + 1);
                    if let Some(rf) = op.get("ref").and_then(Value::as_str).filter(|x| !x.is_empty()) {
                        refmap.insert(rf.into(), json!(id));
                    }
                    let data = resolve(op.get("data").unwrap_or(&json!({})), &refmap);
                    let mut rec = Rec::new();
                    rec.insert("id".into(), json!(id));
                    rec.extend(defaults(kind));
                    for (k, v) in data.as_object().into_iter().flatten() {
                        if !is_system(k) {
                            rec.insert(k.clone(), coerce(kind, k, v.clone()));
                        }
                    }
                    rec.insert("version".into(), json!(1));
                    rec.insert("created".into(), json!(t));
                    rec.insert("updated".into(), json!(t));
                    resolved.push(json!({"i": i, "op": "create", "kind": kind.as_str(), "id": id, "ref": op.get("ref").cloned().unwrap_or(Value::Null),
                        "title": rec.get("title").cloned().unwrap_or(Value::Null), "reason": op.get("reason").cloned().unwrap_or(Value::Null),
                        "data": Value::Object(rec.clone())}));
                    recs.get_mut(&kind).unwrap().insert(id, Arc::new(rec));
                }
                "update" | "delete" => {
                    let id = resolve(op.get("id").ok_or("'id'")?, &refmap).as_str().unwrap_or("").to_string();
                    let kind = Kind::of_id(&id)?;
                    let cur = recs[&kind].get(&id).cloned().ok_or_else(|| format!("{id} does not exist"))?;
                    let base_version = base.recs[&kind].get(&id).and_then(|r| r.get("version").cloned()).unwrap_or(Value::Null);
                    if kind_op == "delete" {
                        recs.get_mut(&kind).unwrap().remove(&id);
                        resolved.push(json!({"i": i, "op": "delete", "kind": kind.as_str(), "id": id, "title": cur.get("title").cloned().unwrap_or(Value::Null),
                            "reason": op.get("reason").cloned().unwrap_or(Value::Null), "base_version": base_version}));
                        return Ok(());
                    }
                    let mut rec = (*cur).clone();
                    for (k, v) in resolve(op.get("patch").unwrap_or(&json!({})), &refmap).as_object().into_iter().flatten() {
                        if !is_system(k) {
                            rec.insert(k.clone(), coerce(kind, k, v.clone()));
                        }
                    }
                    for (k, vals) in resolve(op.get("add").unwrap_or(&json!({})), &refmap).as_object().into_iter().flatten() {
                        let mut list = rec.get(k).map(as_list).unwrap_or_default();
                        for v in as_list(vals) {
                            if !list.contains(&v) {
                                list.push(v);
                            }
                        }
                        rec.insert(k.clone(), Value::Array(list));
                    }
                    for (k, vals) in resolve(op.get("remove").unwrap_or(&json!({})), &refmap).as_object().into_iter().flatten() {
                        let drop = as_list(vals);
                        let list = rec.get(k).map(as_list).unwrap_or_default().into_iter().filter(|v| !drop.contains(v)).collect();
                        rec.insert(k.clone(), Value::Array(list));
                    }
                    let mut changes = Map::new();
                    for (k, v) in &rec {
                        if !is_system(k) && cur.get(k) != Some(v) {
                            changes.insert(k.clone(), json!([cur.get(k).cloned().unwrap_or(Value::Null), v]));
                        }
                    }
                    let v = cur.get("version").and_then(Value::as_i64).unwrap_or(0) + 1;
                    rec.insert("version".into(), json!(v));
                    rec.insert("updated".into(), json!(t));
                    resolved.push(json!({"i": i, "op": "update", "kind": kind.as_str(), "id": id, "title": rec.get("title").cloned().unwrap_or(Value::Null),
                        "reason": op.get("reason").cloned().unwrap_or(Value::Null), "changes": changes, "base_version": base_version}));
                    recs.get_mut(&kind).unwrap().insert(id, Arc::new(rec));
                }
                other => return Err(format!("unknown op '{other}' (expected create, update or delete)")),
            }
            Ok(())
        })();
        if let Err(e) = r {
            errors.push(format!("op {i} ({kind_op}): {e}"));
        }
    }
    let view = View { config: store.config_value(), recs };
    for r in &resolved {
        if r["op"] == json!("delete") {
            continue;
        }
        let kind = Kind::parse(r["kind"].as_str().unwrap()).unwrap();
        let id = r["id"].as_str().unwrap();
        if let Some(rec) = view.recs[&kind].get(id) {
            let ex = |k: Kind, x: &str| view.exists(k, x);
            for e in validate(kind, rec, Some(&ex)) {
                errors.push(format!("{id}: {e}"));
            }
        }
    }
    let before = dangling(&base);
    for d in dangling(&view).difference(&before) {
        errors.push(format!("dangling reference {d} (remap or delete the referencing record in this changeset)"));
    }
    Materialized { view, base, ops: resolved, errors, refmap }
}

pub fn blast_radius(views: &[&View], ids: &HashSet<String>) -> Value {
    let reqs: HashSet<&str> = ids.iter().map(String::as_str).filter(|i| i.starts_with("REQ-")).collect();
    let touched_stories: HashSet<&str> = ids.iter().map(String::as_str).filter(|i| i.starts_with("STORY-")).collect();
    let mut children = BTreeSet::new();
    let mut stories: BTreeMap<String, Value> = BTreeMap::new();
    let mut tasks: BTreeMap<String, Value> = BTreeMap::new();
    let mut evals: BTreeMap<String, Value> = BTreeMap::new();
    let mut components = BTreeSet::new();
    for v in views {
        for r in v.records(Kind::Requirements) {
            if reqs.contains(s(&r, "parent")) {
                children.insert(s(&r, "id").to_string());
            }
        }
        for st in v.records(Kind::Stories) {
            let sid = s(&st, "id");
            let mut linked: Vec<&str> = strs(&st, "requirements").into_iter().filter(|r| reqs.contains(r)).collect();
            linked.sort_unstable();
            if linked.is_empty() && !touched_stories.contains(sid) {
                continue;
            }
            stories.insert(sid.into(), json!({"id": sid, "title": s(&st, "title"), "status": s(&st, "status"),
                "component": st.get("component").cloned().unwrap_or(Value::Null), "via": linked}));
            if !s(&st, "component").is_empty() {
                components.insert(s(&st, "component").to_string());
            }
            for ev in objs(&st, "evals") {
                let covers = strs(ev, "covers");
                if touched_stories.contains(sid) || covers.iter().any(|c| reqs.contains(c.split('#').next().unwrap_or(""))) {
                    evals.insert(format!("{sid}/{}", s(ev, "id")), json!({"story": sid, "id": s(ev, "id"), "name": ev.get("name").cloned().unwrap_or(Value::Null),
                        "kind": ev.get("kind").cloned().unwrap_or(Value::Null), "command": ev.get("command").cloned().unwrap_or(Value::Null), "covers": covers}));
                }
            }
        }
    }
    for v in views {
        for t in v.records(Kind::Tasks) {
            if stories.contains_key(s(&t, "story")) {
                tasks.insert(s(&t, "id").into(), json!({"id": s(&t, "id"), "title": s(&t, "title"), "kind": s(&t, "kind"),
                    "status": s(&t, "status"), "story": s(&t, "story")}));
            }
        }
    }
    let busy = |x: &Value| matches!(x["status"].as_str(), Some("in-progress") | Some("done"));
    let in_progress: Vec<Value> = tasks.values().chain(stories.values()).filter(|x| busy(x)).map(|x| x["id"].clone()).collect();
    let mut rq: Vec<&str> = reqs.into_iter().collect();
    rq.sort_unstable();
    json!({"requirements": rq, "children": children, "stories": stories.into_values().collect::<Vec<_>>(),
           "tasks": tasks.into_values().collect::<Vec<_>>(), "evals": evals.into_values().collect::<Vec<_>>(),
           "components": components, "in_progress_work": in_progress})
}

fn lint_key(f: &Value) -> String {
    format!("{}|{}|{}", f["rule"], f["ids"], f["message"])
}

pub fn lint_memo(store: &Store) -> Arc<Value> {
    store.memo("lint", || lint::lint(store))
}

pub fn trace_memo(store: &Store) -> Arc<Value> {
    store.memo("trace", || trace::evaluate(store))
}

pub fn simulate(store: &Store, cs: &Value) -> Value {
    let ops = cs.get("ops").and_then(Value::as_array).cloned().unwrap_or_default();
    let m = materialize(store, &ops);
    let (before_l, before_t) = (lint_memo(store), trace_memo(store));
    let (after_l, after_t) = (lint::lint(&m.view), trace::evaluate(&m.view));
    let nonin = |rep: &Value| -> Vec<(String, Value)> {
        rep["findings"].as_array().into_iter().flatten().filter(|f| f["severity"] != json!("info")).map(|f| (lint_key(f), f.clone())).collect()
    };
    let bl = nonin(&before_l);
    let al = nonin(&after_l);
    let bkeys: HashSet<&String> = bl.iter().map(|(k, _)| k).collect();
    let akeys: HashSet<&String> = al.iter().map(|(k, _)| k).collect();
    let new_lint: Vec<Value> = al.iter().filter(|(k, _)| !bkeys.contains(k)).map(|(_, f)| f.clone()).collect();
    let resolved: Vec<Value> = bl.iter().filter(|(k, _)| !akeys.contains(k)).map(|(_, f)| f.clone()).collect();
    let bchk: HashMap<String, &Value> =
        before_t["checks"].as_array().into_iter().flatten().map(|c| (c["id"].as_str().unwrap_or("").to_string(), c)).collect();
    let mut tdelta = vec![];
    for c in after_t["checks"].as_array().into_iter().flatten() {
        let old: BTreeSet<String> = bchk
            .get(c["id"].as_str().unwrap_or(""))
            .map(|b| b["failures"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        let new: BTreeSet<String> = c["failures"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        if old != new {
            tdelta.push(json!({"check": c["id"], "name": c["name"], "severity": c["severity"],
                "new_failures": new.difference(&old).collect::<Vec<_>>(), "fixed": old.difference(&new).collect::<Vec<_>>()}));
        }
    }
    let touched: HashSet<String> = m.ops.iter().filter_map(|o| o["id"].as_str().map(String::from)).collect();
    // any new overlap breaks mutual exclusivity; a new gap breaks exhaustiveness
    let mece_ok = !new_lint.iter().any(|f| f["severity"] == json!("error") || f["rule"] == json!("overlap") || f["rule"] == json!("coverage-gap"));
    let ops_out: Vec<Value> = m
        .ops
        .iter()
        .map(|o| {
            let mut o = o.clone();
            if let Some(d) = o.get("data").and_then(Value::as_object) {
                let brief: Map<String, Value> = d
                    .iter()
                    .filter(|(k, v)| !["created", "updated", "version"].contains(&k.as_str()) && !crate::model::is_empty(Some(v)))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                o["data"] = Value::Object(brief);
            }
            o
        })
        .collect();
    json!({
        "valid": m.errors.is_empty(),
        "errors": m.errors,
        "ops": ops_out,
        "refmap": m.refmap,
        "lint": {"before": before_l["counts"], "after": after_l["counts"], "new": new_lint, "resolved": resolved,
                 "gaps_before": before_l["coverage"]["gaps"].as_array().map(Vec::len).unwrap_or(0),
                 "gaps_after": after_l["coverage"]["gaps"].as_array().map(Vec::len).unwrap_or(0),
                 "mece_ok": mece_ok},
        "trace": {"ok_before": before_t["ok"], "ok_after": after_t["ok"], "metrics_before": before_t["metrics"],
                  "metrics_after": after_t["metrics"], "delta": tdelta},
        "impact": blast_radius(&[&m.base, &m.view], &touched),
    })
}

// ------------------------------------------------------------------- persistence

fn dir(store: &Store) -> std::path::PathBuf {
    let d = store.root.join("changesets");
    fs::create_dir_all(&d).ok();
    d
}

pub fn get(store: &Store, id: &str) -> Res<Value> {
    let p = dir(store).join(format!("{id}.json"));
    let text = fs::read_to_string(&p).map_err(|_| StoreError::new(format!("{id} not found"), 404))?;
    serde_json::from_str(&text).map_err(|e| StoreError::bad(e.to_string()))
}

fn save(store: &Store, cs: &Value) -> Res<()> {
    let id = cs["id"].as_str().unwrap_or("CS-0000");
    fs::write(dir(store).join(format!("{id}.json")), dump(cs)).map_err(|e| StoreError::bad(e.to_string()))
}

pub fn list(store: &Store, status: Option<&str>) -> Vec<Value> {
    let mut paths: Vec<_> = fs::read_dir(dir(store))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("CS-")).unwrap_or(false))
        .collect();
    paths.sort();
    paths.reverse();
    paths
        .iter()
        .filter_map(|p| serde_json::from_str::<Value>(&fs::read_to_string(p).ok()?).ok())
        .filter(|cs| status.map(|st| cs["status"] == json!(st)).unwrap_or(true))
        .map(|cs| {
            json!({"id": cs["id"], "title": cs["title"], "status": cs["status"], "created": cs["created"],
                   "applied_at": cs.get("applied_at").cloned().unwrap_or(Value::Null), "valid": cs["valid"],
                   "ops": cs["ops"].as_array().map(Vec::len).unwrap_or(0)})
        })
        .collect()
}

pub fn propose(store: &Store, cs: &Value) -> Res<Value> {
    if cs.get("ops").and_then(Value::as_array).map(Vec::is_empty).unwrap_or(true) {
        return Err(StoreError::new("changeset has no ops", 422));
    }
    let sim = simulate(store, cs);
    let _g = store.lock()?;
    let re = Regex::new(r"^CS-(\d+)\.json$").unwrap();
    let max = fs::read_dir(dir(store))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| re.captures(&e.file_name().to_string_lossy()).and_then(|c| c[1].parse::<u64>().ok()))
        .max()
        .unwrap_or(0);
    let id = format!("CS-{:04}", max + 1);
    let mut base_versions = Map::new();
    for o in sim["ops"].as_array().into_iter().flatten() {
        if let (Some(rid), Some(v)) = (o["id"].as_str(), o.get("base_version")) {
            if !v.is_null() {
                base_versions.insert(rid.into(), v.clone());
            }
        }
    }
    let title = cs.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("untitled change");
    let rec = json!({
        "id": id, "title": title, "summary": cs.get("summary").cloned().unwrap_or(json!("")),
        "rationale": cs.get("rationale").cloned().unwrap_or(json!("")), "status": "pending", "created": now(),
        "valid": sim["valid"], "ops": cs["ops"], "impact_notes": cs.get("impact").cloned().unwrap_or(json!({})),
        "base_versions": base_versions, "analysis": sim,
    });
    save(store, &rec)?;
    store.commit(&format!("{id}: proposed — {title}"));
    let impact_counts: Map<String, Value> =
        sim["impact"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), json!(v.as_array().map(Vec::len).unwrap_or(0)))).collect();
    Ok(json!({"changeset_id": id, "valid": sim["valid"], "errors": sim["errors"], "mece_ok": sim["lint"]["mece_ok"],
              "new_lint_findings": sim["lint"]["new"].as_array().map(Vec::len).unwrap_or(0),
              "trace_ok_after": sim["trace"]["ok_after"], "impact": impact_counts,
              "note": "Shown to the user as a card with Apply/Reject. Nothing is written until they apply."}))
}

pub fn apply(store: &Store, id: &str, exclude: &[usize]) -> Res<Value> {
    let (refmap, written) = {
        let _g = store.lock()?;
        let mut cs = get(store, id)?;
        if cs["status"] != json!("pending") {
            return Err(StoreError::new(format!("{id} is {}, not pending", cs["status"].as_str().unwrap_or("?")), 409));
        }
        let mut stale = vec![];
        for (rid, ver) in cs["base_versions"].as_object().cloned().unwrap_or_default() {
            let Ok(kind) = Kind::of_id(&rid) else { continue };
            match store.get(kind, &rid) {
                Err(_) => stale.push(format!("{rid} was deleted")),
                Ok(cur) if cur.get("version") != Some(&ver) => {
                    stale.push(format!("{rid} changed (v{} -> v{})", ver, cur.get("version").cloned().unwrap_or(Value::Null)))
                }
                _ => {}
            }
        }
        if !stale.is_empty() {
            cs["status"] = json!("stale");
            cs["stale_reasons"] = json!(stale);
            save(store, &cs)?;
            store.commit(&format!("{id}: stale"));
            return Err(StoreError::with(
                format!("{id} is stale; ask the agent to re-propose"),
                409,
                stale.into_iter().map(Value::String).collect(),
            ));
        }
        let ops: Vec<Value> =
            cs["ops"].as_array().cloned().unwrap_or_default().into_iter().enumerate().filter(|(i, _)| !exclude.contains(i)).map(|(_, o)| o).collect();
        let m = materialize(store, &ops);
        if !m.errors.is_empty() {
            return Err(StoreError::with(format!("{id} no longer applies cleanly"), 422, m.errors.into_iter().map(Value::String).collect()));
        }
        let mut touched: BTreeSet<(Kind, String)> = BTreeSet::new();
        for o in &m.ops {
            touched.insert((Kind::parse(o["kind"].as_str().unwrap()).unwrap(), o["id"].as_str().unwrap().to_string()));
        }
        for (kind, rid) in &touched {
            match m.view.recs[kind].get(rid) {
                Some(rec) => store.write_unlocked(*kind, rec)?,
                None => {
                    let p = store.path(*kind, rid);
                    if p.exists() {
                        fs::remove_file(p).map_err(|e| StoreError::bad(e.to_string()))?;
                    }
                }
            }
        }
        let mut ex: Vec<usize> = exclude.to_vec();
        ex.sort_unstable();
        cs["status"] = json!("applied");
        cs["applied_at"] = json!(now());
        cs["excluded_ops"] = json!(ex);
        cs["assigned_ids"] = Value::Object(m.refmap.clone());
        save(store, &cs)?;
        store.commit(&format!("{id}: apply — {}", cs["title"].as_str().unwrap_or("")));
        (m.refmap, touched.into_iter().map(|(_, i)| i).collect::<BTreeSet<_>>())
    };
    let t = trace::evaluate(store);
    let l = lint::lint(store);
    let failing: Vec<Value> = t["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["passed"] == json!(false))
        .map(|c| json!({"check": c["id"], "failures": c["failures"].as_array().map(|a| a.iter().take(20).cloned().collect::<Vec<_>>()).unwrap_or_default()}))
        .collect();
    Ok(json!({"changeset_id": id, "status": "applied", "assigned_ids": refmap, "written": written,
              "lint": l["counts"], "trace_ok": t["ok"], "trace_metrics": t["metrics"], "failing_checks": failing}))
}

pub fn reject(store: &Store, id: &str, reason: &str) -> Res<Value> {
    let _g = store.lock()?;
    let mut cs = get(store, id)?;
    if cs["status"] != json!("pending") {
        return Err(StoreError::new(format!("{id} is {}, not pending", cs["status"].as_str().unwrap_or("?")), 409));
    }
    cs["status"] = json!("rejected");
    cs["rejected_reason"] = json!(reason);
    cs["rejected_at"] = json!(now());
    save(store, &cs)?;
    store.commit(&format!("{id}: rejected"));
    Ok(json!({"changeset_id": id, "status": "rejected"}))
}

// ------------------------------------------------------------------- context

/// Memoised link maps used by list annotations, facets and record context.
pub fn links(store: &Store) -> Arc<Value> {
    store.memo("links", || {
        let (mut req_stories, mut children, mut story_tasks) = (Map::new(), Map::new(), Map::new());
        let push = |m: &mut Map<String, Value>, k: &str, v: &str| {
            m.entry(k.to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!(v));
        };
        for st in store.records(Kind::Stories) {
            for rid in strs(&st, "requirements") {
                push(&mut req_stories, rid, s(&st, "id"));
            }
        }
        for r in store.records(Kind::Requirements) {
            if !s(&r, "parent").is_empty() {
                push(&mut children, s(&r, "parent"), s(&r, "id"));
            }
        }
        for t in store.records(Kind::Tasks) {
            push(&mut story_tasks, s(&t, "story"), s(&t, "id"));
        }
        json!({"req_stories": req_stories, "children": children, "story_tasks": story_tasks})
    })
}

pub fn context(store: &Store, id: &str) -> Res<Value> {
    let kind = Kind::of_id(id).map_err(StoreError::bad)?;
    let rec = store.get(kind, id)?;
    let mut out = json!({"record": rec, "referenced_by": store.references_to(id)});
    if kind == Kind::Requirements {
        let lk = links(store);
        out["parent"] = rec.get("parent").cloned().unwrap_or(Value::Null);
        let kids: Vec<Value> = lk["children"][id]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|c| json!({"id": c, "title": store.get(Kind::Requirements, c).map(|r| r.get("title").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null)}))
            .collect();
        out["children"] = json!(kids);
        out["impact"] = blast_radius(&[&base_view(store)], &HashSet::from([id.to_string()]));
        let lr = lint_memo(store);
        out["lint"] = json!(lr["findings"].as_array().into_iter().flatten().filter(|f| f["ids"].as_array().map(|a| a.contains(&json!(id))).unwrap_or(false)).cloned().collect::<Vec<_>>());
    }
    Ok(out)
}
