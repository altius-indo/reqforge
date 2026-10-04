//! Requirement-set lint: mutual exclusivity (overlap), collective exhaustiveness
//! (taxonomy coverage), and per-requirement quality (ISO/IEC/IEEE 29148).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::model::{objs, s, Kind, Rec, TAXONOMY, VAGUE_TERMS};
use crate::store::Source;

const STOP: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "is", "are", "be", "shall", "must",
    "should", "will", "system", "user", "users", "it", "its", "that", "this", "from", "as", "at", "can", "may", "each",
    "all", "any", "when", "then",
];
const OVERLAP_THRESHOLD: f64 = 0.6;

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z0-9]+").unwrap());
static SHALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bshall\b").unwrap());
static COMPOUND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bshall\b[^.]*\band\b[^.]*\bshall\b").unwrap());
static DIGIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d").unwrap());

pub fn tokens(text: &str) -> HashSet<String> {
    let low = text.to_lowercase();
    WORD.find_iter(&low).map(|m| m.as_str()).filter(|w| w.len() > 2 && !STOP.contains(w)).map(String::from).collect()
}

pub fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    inter / (a.len() as f64 + b.len() as f64 - inter)
}

/// Whole-word match where letters and hyphens are word characters (so "fast" does not hit "breakfast").
fn has_term(low: &str, term: &str) -> bool {
    let is_word = |c: char| c.is_ascii_lowercase() || c == '-';
    let mut start = 0;
    while let Some(pos) = low[start..].find(term) {
        let i = start + pos;
        let before = low[..i].chars().next_back();
        let after = low[i + term.len()..].chars().next();
        if !before.map(is_word).unwrap_or(false) && !after.map(is_word).unwrap_or(false) {
            return true;
        }
        start = i + term.len().max(1);
        if start >= low.len() {
            break;
        }
    }
    false
}

fn pct(x: f64) -> String {
    format!("{:.0}%", x * 100.0)
}

// reqforge: implements REQ-0009
pub fn lint(src: &dyn Source) -> Value {
    let reqs: Vec<std::sync::Arc<Rec>> =
        src.records(Kind::Requirements).into_iter().filter(|r| s(r, "status") != "deprecated").collect();
    let config = src.config();
    let waivers = config.get("coverage_waivers").cloned().unwrap_or(json!({}));
    let waived = |k: &str| waivers.get(k).is_some();
    let mut findings: Vec<Value> = vec![];
    let mut add = |severity: &str, rule: &str, ids: Vec<&str>, message: String| {
        findings.push(json!({"severity": severity, "rule": rule, "ids": ids, "message": message}));
    };

    // ---- per-requirement quality (singular, unambiguous, verifiable)
    for r in &reqs {
        let id = s(r, "id");
        let st = s(r, "statement");
        let low = st.to_lowercase();
        if !SHALL.is_match(&low) {
            add("warning", "statement-form", vec![id], "statement should use 'shall' (ISO 29148 normative form)".into());
        }
        let vague: Vec<&str> = VAGUE_TERMS.iter().copied().filter(|t| has_term(&low, t)).collect();
        if !vague.is_empty() {
            add("warning", "ambiguity", vec![id], format!("vague/unverifiable terms: {}", vague.join(", ")));
        }
        if SHALL.find_iter(&low).count() > 1 || COMPOUND.is_match(&low) {
            add("warning", "singular", vec![id], "statement bundles several requirements; split it".into());
        }
        let acs = objs(r, "acceptance_criteria");
        let ac_text: Vec<&str> = acs.iter().map(|a| a.get("text").and_then(Value::as_str).unwrap_or("")).collect();
        if s(r, "type") == "quality" && !DIGIT.is_match(&format!("{st} {}", ac_text.join(" "))) {
            add("error", "measurable", vec![id], "quality requirement has no measurable threshold".into());
        }
        if acs.is_empty() {
            let sev = if ["approved", "implemented", "verified"].contains(&s(r, "status")) { "error" } else { "warning" };
            add(sev, "acceptance-criteria", vec![id], "no acceptance criteria".into());
        }
        if s(r, "rationale").is_empty() {
            add("info", "rationale", vec![id], "no rationale recorded".into());
        }
    }

    // ---- mutual exclusivity: near-duplicate statements. Candidate pairs come from an
    // inverted index over informative terms, so this stays fast with thousands of requirements.
    let toks: Vec<HashSet<String>> = reqs.iter().map(|r| tokens(&format!("{} {}", s(r, "title"), s(r, "statement")))).collect();
    let mut index: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, ts) in toks.iter().enumerate() {
        for t in ts {
            index.entry(t.as_str()).or_default().push(i);
        }
    }
    let cap = 50.max(reqs.len() / 20);
    let mut shared: HashMap<(usize, usize), u32> = HashMap::new();
    for posting in index.values() {
        if posting.len() > cap {
            continue;
        }
        let mut p = posting.clone();
        p.sort_unstable();
        for x in 0..p.len() {
            for y in x + 1..p.len() {
                *shared.entry((p[x], p[y])).or_default() += 1;
            }
        }
    }
    let mut pairs: Vec<(usize, usize)> = shared.into_iter().filter(|(_, n)| *n >= 2).map(|(k, _)| k).collect();
    pairs.sort_unstable();
    for (i, j) in pairs {
        let (a, b) = (&reqs[i], &reqs[j]);
        if s(a, "parent") == s(b, "id") || s(b, "parent") == s(a, "id") {
            continue;
        }
        let sim = jaccard(&toks[i], &toks[j]);
        if sim >= OVERLAP_THRESHOLD {
            add(
                if sim >= 0.85 { "error" } else { "warning" },
                "overlap",
                vec![s(a, "id"), s(b, "id")],
                format!(
                    "statements overlap ({} shared terms); merge, split the shared part into a parent, or sharpen the boundary",
                    pct(sim)
                ),
            );
        }
    }

    // ---- collective exhaustiveness: every taxonomy cell populated or waived
    let present: HashSet<(String, String)> = reqs.iter().map(|r| (s(r, "type").to_string(), s(r, "category").to_string())).collect();
    let present_types: HashSet<&str> = present.iter().map(|(t, _)| t.as_str()).collect();
    let mut gaps: Vec<String> = vec![];
    for t in &TAXONOMY {
        match t.categories {
            None => {
                if !present_types.contains(t.name) && !waived(t.name) {
                    gaps.push(t.name.to_string());
                }
            }
            Some(cats) => {
                for (c, _) in cats {
                    let key = format!("{}/{}", t.name, c);
                    if !present.contains(&(t.name.to_string(), c.to_string())) && !waived(&key) && !waived(t.name) {
                        gaps.push(key);
                    }
                }
            }
        }
    }
    for g in &gaps {
        add(
            "warning",
            "coverage-gap",
            vec![],
            format!("no requirement covers {g}; add one or waive it in reqforge.json coverage_waivers with a reason"),
        );
    }

    // ---- structure
    let ids: HashSet<&str> = reqs.iter().map(|r| s(r, "id")).collect();
    for r in &reqs {
        let p = s(r, "parent");
        if !p.is_empty() && !ids.contains(p) {
            add("error", "dangling-parent", vec![s(r, "id")], format!("parent {p} missing or deprecated"));
        }
    }

    // ---- design documents: every realises entry must name an existing requirement
    findings.extend(crate::design::lint_findings(src));

    let mut counts: BTreeMap<&str, usize> = [("error", 0), ("warning", 0), ("info", 0)].into_iter().collect();
    for f in &findings {
        *counts.entry(f["severity"].as_str().unwrap_or("info")).or_default() += 1;
    }
    let cells: usize = TAXONOMY.iter().map(|t| t.categories.map(|c| c.len()).unwrap_or(1)).sum();
    json!({
        "requirements": reqs.len(),
        "counts": {"error": counts["error"], "warning": counts["warning"], "info": counts["info"]},
        "coverage": {"cells": cells, "gaps": gaps, "waived": waivers},
        "ok": counts["error"] == 0,
        "findings": findings,
    })
}

pub fn to_markdown(rep: &Value) -> String {
    let c = &rep["counts"];
    let mut lines = vec![
        format!("# Requirement lint — {} requirements", rep["requirements"]),
        format!("errors {} · warnings {} · info {}", c["error"], c["warning"], c["info"]),
        String::new(),
    ];
    for f in rep["findings"].as_array().into_iter().flatten() {
        let ids: Vec<&str> = f["ids"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        lines.push(format!(
            "- **{}** `{}` {} — {}",
            f["severity"].as_str().unwrap_or(""),
            f["rule"].as_str().unwrap_or(""),
            ids.join(" "),
            f["message"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n") + "\n"
}
