//! Query layer for large repositories: paginated/sorted listing, facet counts, the
//! requirement category tree (type -> category with coverage and lint health), and paged lint.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::changes::{lint_memo, links};
use crate::model::{s, Kind, Rec, TAXONOMY};
use crate::store::{keep, parse_query, Source, Store};

pub fn facet_fields(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Requirements => &["type", "category", "status", "priority", "tags"],
        Kind::Epics => &["status", "tags"],
        Kind::Stories => &["epic", "status", "deliverable", "component", "tags"],
        Kind::Tasks => &["kind", "status", "tags"],
    }
}

fn link_count(lk: &Value, map: &str, id: &str) -> usize {
    lk[map][id].as_array().map(Vec::len).unwrap_or(0)
}

fn annotate(kind: Kind, rec: &Rec, lk: &Value) -> Value {
    let mut r = rec.clone();
    let id = s(rec, "id");
    match kind {
        Kind::Requirements => {
            r.insert("_stories".into(), json!(link_count(lk, "req_stories", id)));
            r.insert("_children".into(), json!(link_count(lk, "children", id)));
        }
        Kind::Stories => {
            r.insert("_tasks".into(), json!(link_count(lk, "story_tasks", id)));
            r.insert("_evals".into(), json!(rec.get("evals").and_then(Value::as_array).map(Vec::len).unwrap_or(0)));
        }
        _ => {}
    }
    Value::Object(r)
}

/// Pseudo-field `covered:yes|no` — requirements with / without a story.
fn covered_filter(kind: Kind, w: &mut Map<String, Value>, lk: &Value) -> impl Fn(&Rec) -> bool {
    let want = w.remove("covered").and_then(|v| v.as_str().map(String::from));
    let active = kind == Kind::Requirements && matches!(want.as_deref(), Some("yes") | Some("no"));
    let yes = want.as_deref() == Some("yes");
    let lk = lk.clone();
    move |r: &Rec| !active || (link_count(&lk, "req_stories", s(r, "id")) > 0) == yes
}

fn sort_key(v: Option<&Value>) -> (u8, f64, String) {
    match v {
        Some(Value::Number(n)) => (0, n.as_f64().unwrap_or(0.0), String::new()),
        Some(Value::Array(a)) => (0, a.len() as f64, String::new()),
        Some(Value::String(x)) => (1, 0.0, x.to_lowercase()),
        Some(Value::Null) | None => (1, 0.0, String::new()),
        Some(other) => (1, 0.0, other.to_string().to_lowercase()),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn page(store: &Store, kind: Kind, q: &str, where_: &Map<String, Value>, sort: &str, order: &str, offset: usize, limit: usize) -> Value {
    let lk = links(store);
    let (words, mut w) = parse_query(q, where_);
    let cov = covered_filter(kind, &mut w, &lk);
    let mut rows: Vec<Value> = store
        .entries(kind)
        .into_iter()
        .filter(|e| keep(&e.rec, &e.blob, &words, &w) && cov(&e.rec))
        .map(|e| annotate(kind, &e.rec, &lk))
        .collect();
    if !sort.is_empty() && sort != "id" {
        // stable in both directions: ties keep id order (like Python's sort(reverse=True))
        let desc = order == "desc";
        rows.sort_by(|a, b| {
            let o = sort_key(a.get(sort)).partial_cmp(&sort_key(b.get(sort))).unwrap_or(std::cmp::Ordering::Equal);
            if desc { o.reverse() } else { o }
        });
    } else if order == "desc" {
        rows.reverse();
    }
    let limit = limit.clamp(1, 1000);
    let total = rows.len();
    let items: Vec<Value> = rows.into_iter().skip(offset).take(limit).collect();
    json!({"total": total, "offset": offset, "limit": limit, "items": items})
}

/// Counts per facet value. Each facet ignores its own filter (standard faceting).
pub fn facets(store: &Store, kind: Kind, q: &str, where_: &Map<String, Value>) -> Value {
    let lk = links(store);
    let (words, mut w) = parse_query(q, where_);
    let cov = covered_filter(kind, &mut w, &lk);
    let entries = store.entries(kind);
    let text_rows: Vec<_> = entries.iter().filter(|e| keep(&e.rec, &e.blob, &words, &Map::new()) && cov(&e.rec)).collect();
    let mut out = Map::new();
    for f in facet_fields(kind) {
        let others: Map<String, Value> = w.iter().filter(|(k, _)| k.as_str() != *f).map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut order: Vec<String> = vec![];
        for e in &text_rows {
            if !keep(&e.rec, "", &[], &others) {
                continue;
            }
            let vals: Vec<String> = match e.rec.get(*f) {
                Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect(),
                Some(Value::String(x)) if !x.is_empty() => vec![x.clone()],
                Some(Value::Null) | None => vec!["(none)".into()],
                Some(Value::String(_)) => vec!["(none)".into()],
                Some(other) => vec![other.to_string()],
            };
            for v in vals {
                let c = counts.entry(v.clone()).or_insert(0);
                if *c == 0 {
                    order.push(v);
                }
                *c += 1;
            }
        }
        // most_common: count desc, first-seen order for ties (matches Python Counter)
        let mut ranked: Vec<(usize, String)> = order.into_iter().enumerate().collect();
        ranked.sort_by(|a, b| counts[&b.1].cmp(&counts[&a.1]).then(a.0.cmp(&b.0)));
        let cap = if ["tags", "category", "epic", "component"].contains(f) { 50 } else { usize::MAX };
        let m: Map<String, Value> = ranked.into_iter().take(cap).map(|(_, v)| (v.clone(), json!(counts[&v]))).collect();
        out.insert(f.to_string(), Value::Object(m));
    }
    if kind == Kind::Requirements {
        let tree_where: Map<String, Value> = w.iter().filter(|(k, _)| !["type", "category"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        let reqs: Vec<&Rec> = text_rows.iter().filter(|e| keep(&e.rec, "", &[], &tree_where)).map(|e| e.rec.as_ref()).collect();
        out.insert("_tree".into(), tree(store, &reqs));
    }
    if kind == Kind::Stories {
        let titles: HashMap<String, String> =
            store.records(Kind::Epics).iter().map(|e| (s(e, "id").to_string(), s(e, "title").to_string())).collect();
        let et: Map<String, Value> = out["epic"]
            .as_object()
            .map(|m| m.keys().map(|k| (k.clone(), json!(titles.get(k).cloned().unwrap_or_default()))).collect())
            .unwrap_or_default();
        out.insert("_epic_titles".into(), Value::Object(et));
    }
    Value::Object(out)
}

pub fn tree(store: &Store, reqs: &[&Rec]) -> Value {
    let lk = links(store);
    let lr = lint_memo(store);
    let mut health: HashMap<String, (usize, usize)> = HashMap::new();
    for f in lr["findings"].as_array().into_iter().flatten() {
        for id in f["ids"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let h = health.entry(id.to_string()).or_default();
            match f["severity"].as_str() {
                Some("error") => h.0 += 1,
                Some("warning") => h.1 += 1,
                _ => {}
            }
        }
    }
    let waivers = store.config_value().get("coverage_waivers").cloned().unwrap_or(json!({}));
    let mut nodes = vec![];
    for t in &TAXONOMY {
        let mut cats: Vec<Map<String, Value>> = vec![];
        let mut idx: HashMap<String, usize> = HashMap::new();
        for (c, _) in t.categories.unwrap_or(&[]) {
            let waived = waivers.get(format!("{}/{}", t.name, c)).or_else(|| waivers.get(t.name)).cloned().unwrap_or(Value::Null);
            idx.insert(c.to_string(), cats.len());
            cats.push(json!({"category": c, "count": 0, "covered": 0, "errors": 0, "warnings": 0, "waived": waived}).as_object().unwrap().clone());
        }
        for r in reqs.iter().filter(|r| s(r, "type") == t.name) {
            let c = if s(r, "category").is_empty() { "(none)" } else { s(r, "category") };
            let i = *idx.entry(c.to_string()).or_insert_with(|| {
                cats.push(json!({"category": c, "count": 0, "covered": 0, "errors": 0, "warnings": 0, "waived": null}).as_object().unwrap().clone());
                cats.len() - 1
            });
            let node = &mut cats[i];
            let inc = |node: &mut Map<String, Value>, k: &str, by: usize| {
                let v = node[k].as_u64().unwrap_or(0) + by as u64;
                node.insert(k.into(), json!(v));
            };
            inc(node, "count", 1);
            inc(node, "covered", usize::from(link_count(&lk, "req_stories", s(r, "id")) > 0));
            let (e, wn) = health.get(s(r, "id")).copied().unwrap_or((0, 0));
            inc(node, "errors", e);
            inc(node, "warnings", wn);
        }
        if t.categories.is_none() {
            cats.sort_by(|a, b| {
                b["count"].as_u64().cmp(&a["count"].as_u64()).then(a["category"].as_str().cmp(&b["category"].as_str()))
            });
        }
        let sum = |k: &str| cats.iter().map(|c| c[k].as_u64().unwrap_or(0)).sum::<u64>();
        nodes.push(json!({"type": t.name, "count": sum("count"), "covered": sum("covered"), "errors": sum("errors"),
                          "warnings": sum("warnings"), "categories": cats}));
    }
    json!(nodes)
}

/// Lint findings filtered by rule/severity/taxonomy cell/text, with per-rule counts.
#[allow(clippy::too_many_arguments)]
pub fn lint_page(store: &Store, rule: &str, severity: &str, type_: &str, category: &str, q: &str, offset: usize, limit: usize) -> Value {
    let lr = lint_memo(store);
    let cell: HashMap<String, (String, String)> = store
        .records(Kind::Requirements)
        .iter()
        .map(|r| (s(r, "id").to_string(), (s(r, "type").to_string(), s(r, "category").to_string())))
        .collect();
    let mut by_rule: std::collections::BTreeMap<String, Map<String, Value>> = Default::default();
    let mut items: Vec<Value> = vec![];
    let ql = q.to_lowercase();
    for f in lr["findings"].as_array().into_iter().flatten() {
        let ids: Vec<&str> = f["ids"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if !type_.is_empty() || !category.is_empty() {
            let cells: Vec<(String, String)> = if f["rule"] == json!("coverage-gap") {
                let msg = f["message"].as_str().unwrap_or("");
                let gap = msg.split_once(" covers ").map(|x| x.1).unwrap_or("").split(';').next().unwrap_or("");
                let mut it = gap.split('/');
                vec![(it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())]
            } else {
                ids.iter().map(|i| cell.get(*i).cloned().unwrap_or_default()).collect()
            };
            if !cells.iter().any(|(t, c)| (type_.is_empty() || t == type_) && (category.is_empty() || c == category)) {
                continue;
            }
        }
        if !ql.is_empty() && !format!("{} {}", f["message"].as_str().unwrap_or(""), ids.join(" ")).to_lowercase().contains(&ql) {
            continue;
        }
        let r = f["rule"].as_str().unwrap_or("").to_string();
        let sev = f["severity"].as_str().unwrap_or("").to_string();
        let e = by_rule.entry(r.clone()).or_default();
        let n = e.get(&sev).and_then(Value::as_u64).unwrap_or(0) + 1;
        e.insert(sev.clone(), json!(n));
        if (rule.is_empty() || r == rule) && (severity.is_empty() || sev == severity) {
            items.push(f.clone());
        }
    }
    let rank = |sv: &str| match sv {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    };
    items.sort_by(|a, b| {
        rank(a["severity"].as_str().unwrap_or(""))
            .cmp(&rank(b["severity"].as_str().unwrap_or("")))
            .then(a["rule"].as_str().cmp(&b["rule"].as_str()))
            .then(a["ids"].to_string().cmp(&b["ids"].to_string()))
    });
    let limit = limit.clamp(1, 1000);
    let total = items.len();
    json!({"ok": lr["ok"], "requirements": lr["requirements"], "counts": lr["counts"], "coverage": lr["coverage"],
           "by_rule": by_rule, "total": total, "offset": offset, "limit": limit,
           "items": items.into_iter().skip(offset).take(limit).collect::<Vec<_>>()})
}
