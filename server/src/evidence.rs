//! Evidence: CI results tied to commits, mapped to requirement acceptance criteria.
//!
//! Inputs: JUnit XML (any framework that emits it: pytest, Jest/Vitest, JUnit, go-junit-report,
//! cargo-nextest, …), Rust libtest text output (`cargo test 2>&1 | tee test.log`), and reqforge eval
//! reports (`reqforge-reports/evals-<stage>.json`).
//! A JUnit test case maps to criteria through (a) requirement ids in its name, or (b) the trace
//! tags attached to the same test symbol in the same file (from the code index). Each evidence
//! record stores the hashes of the files it vouches for (the test file and the requirement's
//! implementing files); when a later scan shows different hashes, the evidence is "suspect".

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::codetrace::{load_all, Index, Tag};
use crate::model::{objs, s, Kind};
use crate::store::{now, Res, Source, Store, StoreError};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Evidence {
    /// "REQ-0042#AC1", or "REQ-0042" for a requirement without acceptance criteria
    pub target: String,
    /// "test:<component>:<file>::<symbol>" or "eval:<STORY>/<EVAL>"
    pub source: String,
    /// "passed" | "failed"
    pub status: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
    pub at: String,
    #[serde(default)]
    pub component: Option<String>,
    /// "<component>:<file>" -> sha256 at the time of the run
    #[serde(default)]
    pub hashes: BTreeMap<String, String>,
}

pub type Latest = BTreeMap<String, Evidence>;

pub fn load_latest(root: &Path) -> Latest {
    fs::read_to_string(root.join("evidence/latest.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

#[derive(Debug, Default)]
pub struct TestCase {
    pub name: String,
    pub classname: String,
    pub file: String,
    pub status: String, // passed | failed | skipped
}

pub fn parse_junit(xml: &str) -> Result<Vec<TestCase>, String> {
    let mut r = Reader::from_str(xml);
    let mut out = vec![];
    let mut cur: Option<TestCase> = None;
    let attrs = |e: &quick_xml::events::BytesStart| -> TestCase {
        let mut tc = TestCase { status: "passed".into(), ..Default::default() };
        for a in e.attributes().flatten() {
            let v = a.unescape_value().map(|v| v.to_string()).unwrap_or_default();
            match a.key.as_ref() {
                b"name" => tc.name = v,
                b"classname" => tc.classname = v,
                b"file" | b"filepath" => tc.file = v,
                _ => {}
            }
        }
        tc
    };
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"testcase" => cur = Some(attrs(&e)),
                b"failure" | b"error" => {
                    if let Some(c) = cur.as_mut() {
                        c.status = "failed".into()
                    }
                }
                b"skipped" => {
                    if let Some(c) = cur.as_mut() {
                        if c.status != "failed" {
                            c.status = "skipped".into()
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"testcase" => out.push(attrs(&e)),
                b"failure" | b"error" => {
                    if let Some(c) = cur.as_mut() {
                        c.status = "failed".into()
                    }
                }
                b"skipped" => {
                    if let Some(c) = cur.as_mut() {
                        if c.status != "failed" {
                            c.status = "skipped".into()
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) if e.name().as_ref() == b"testcase" => {
                if let Some(c) = cur.take() {
                    out.push(c);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("invalid JUnit XML at byte {}: {e}", r.buffer_position())),
            _ => {}
        }
    }
    Ok(out)
}

static LIBTEST: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)^test (\S+) \.\.\. (ok|FAILED|ignored)").unwrap());

// reqforge: implements REQ-0022
/// Rust libtest text output (`cargo test`): `test name ... ok|FAILED|ignored`.
pub fn parse_libtest(text: &str) -> Vec<TestCase> {
    LIBTEST
        .captures_iter(text)
        .map(|c| TestCase {
            name: c[1].rsplit("::").next().unwrap_or(&c[1]).to_string(),
            classname: String::new(),
            file: String::new(),
            status: match &c[2] {
                "ok" => "passed",
                "FAILED" => "failed",
                _ => "skipped",
            }
            .into(),
        })
        .collect()
}

fn stem(file: &str) -> &str {
    file.rsplit_once('.').map(|(a, _)| a).unwrap_or(file)
}

fn file_matches(tc: &TestCase, tag_file: &str) -> bool {
    if !tc.file.is_empty() {
        let f = tc.file.trim_start_matches("./");
        return tag_file.ends_with(f) || f.ends_with(tag_file);
    }
    if tc.classname.is_empty() {
        return true;
    }
    let cls = tc.classname.replace('.', "/");
    let st = stem(tag_file);
    st == cls || cls.starts_with(&format!("{st}/")) || st.ends_with(&format!("/{cls}")) || cls.ends_with(&format!("/{st}")) || st.ends_with(&cls)
}

fn symbol_matches(name: &str, symbol: &str) -> bool {
    let base = name.split('[').next().unwrap_or(name).trim(); // pytest parametrization: test_x[case]
    base == symbol || base.ends_with(symbol) || name.contains(symbol)
}

/// Expand a tag/id to concrete targets: REQ#AC, or every AC of the requirement.
pub fn targets_for(src: &dyn Source, req: &str, ac: Option<&str>) -> Vec<String> {
    if let Some(ac) = ac {
        return vec![format!("{req}#{ac}")];
    }
    let acs: Vec<String> = src
        .records(Kind::Requirements)
        .iter()
        .find(|r| s(r, "id") == req)
        .map(|r| objs(r, "acceptance_criteria").iter().map(|a| format!("{req}#{}", s(a, "id"))).collect())
        .unwrap_or_default();
    if acs.is_empty() {
        vec![req.to_string()]
    } else {
        acs
    }
}

/// Files whose content a passing result for `req` vouches for: the given test file plus the
/// requirement's implementing files.
fn hashes_for(indexes: &[Index], req: &str, test: Option<(&str, &str)>) -> BTreeMap<String, String> {
    let mut h = BTreeMap::new();
    for idx in indexes {
        for t in idx.tags.iter().filter(|t| t.req == req && t.kind == "implements") {
            if let Some(sha) = idx.files.get(&t.file) {
                h.insert(format!("{}:{}", idx.component, t.file), sha.clone());
            }
        }
        if let Some((comp, file)) = test {
            if comp == idx.component {
                if let Some(sha) = idx.files.get(file) {
                    h.insert(format!("{comp}:{file}"), sha.clone());
                }
            }
        }
    }
    h
}

pub struct IngestOpts<'a> {
    pub component: Option<&'a str>,
    pub commit: Option<&'a str>,
    pub run: Option<&'a str>,
}

// reqforge: implements REQ-0022
// reqforge: implements REQ-0038
/// Ingest result files (JUnit XML or reqforge eval report JSON). Writes evidence/latest.json
/// (newest result per target+source) and appends evidence/history.jsonl.
pub fn ingest(store: &Store, files: &[(String, String)], o: &IngestOpts) -> Res<Value> {
    let indexes: Vec<Index> = load_all(&store.root).into_iter().filter(|i| o.component.map(|c| c == i.component).unwrap_or(true)).collect();
    let commit = o.commit.map(String::from).or_else(|| indexes.iter().find_map(|i| i.commit.clone()));
    let at = now();
    let mut new: Vec<Evidence> = vec![];
    let (mut cases, mut matched, mut skipped) = (0usize, 0usize, 0usize);
    let mut unmatched: Vec<String> = vec![];
    for (name, content) in files {
        let t = content.trim_start();
        let is_xml = t.starts_with('<');
        let is_libtest = !is_xml && !t.starts_with('{') && LIBTEST.is_match(content);
        if is_xml || is_libtest {
            let cases_in = if is_xml { parse_junit(content).map_err(|e| StoreError::bad(format!("{name}: {e}")))? } else { parse_libtest(content) };
            for tc in cases_in {
                cases += 1;
                if tc.status == "skipped" {
                    skipped += 1;
                    continue;
                }
                // (a) ids in the test name
                let mut hits: Vec<(Option<&Tag>, String, Option<String>)> =
                    crate::codetrace::ids_in(&tc.name).into_iter().map(|(r, a)| (None, r, a)).collect();
                // (b) tags on the same symbol in the same file
                if hits.is_empty() {
                    for idx in &indexes {
                        for tag in idx.tags.iter().filter(|t| t.kind == "verifies") {
                            if let Some(sym) = &tag.symbol {
                                if file_matches(&tc, &tag.file) && symbol_matches(&tc.name, sym) {
                                    hits.push((Some(tag), tag.req.clone(), tag.ac.clone()));
                                }
                            }
                        }
                    }
                }
                if hits.is_empty() {
                    if unmatched.len() < 50 {
                        unmatched.push(format!("{}::{}", tc.classname, tc.name));
                    }
                    continue;
                }
                matched += 1;
                for (tag, req, ac) in hits {
                    let (comp, file) = match tag {
                        Some(t) => (t.component.clone(), t.file.clone()),
                        None => (o.component.unwrap_or("").to_string(), if tc.file.is_empty() { tc.classname.replace('.', "/") } else { tc.file.clone() }),
                    };
                    for target in targets_for(store, &req, ac.as_deref()) {
                        new.push(Evidence {
                            target,
                            source: format!("test:{comp}:{file}::{}", tc.name),
                            status: tc.status.clone(),
                            commit: commit.clone(),
                            run: o.run.map(String::from),
                            at: at.clone(),
                            component: (!comp.is_empty()).then(|| comp.clone()),
                            hashes: hashes_for(&indexes, &req, Some((comp.as_str(), file.as_str()))),
                        });
                    }
                }
            }
        } else {
            let rep: Value = serde_json::from_str(content).map_err(|e| StoreError::bad(format!("{name}: not JUnit XML, cargo test output or a reqforge eval report: {e}")))?;
            let results = rep.get("results").and_then(Value::as_array).ok_or_else(|| StoreError::bad(format!("{name}: no 'results' array (expected a reqforge eval report)")))?;
            for r in results {
                cases += 1;
                let status = r["status"].as_str().unwrap_or("");
                if status != "passed" && status != "failed" {
                    skipped += 1;
                    continue;
                }
                let covers: Vec<&str> = r["covers"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                if covers.is_empty() {
                    unmatched.push(format!("eval {}/{}", r["story"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or("")));
                    continue;
                }
                matched += 1;
                for c in covers {
                    let (req, ac) = c.split_once('#').map(|(a, b)| (a, Some(b))).unwrap_or((c, None));
                    // an eval vouches for the implementing files and the tests tagged for this criterion
                    let mut hashes = hashes_for(&indexes, req, None);
                    for idx in &indexes {
                        for t in idx.tags.iter().filter(|t| t.kind == "verifies" && t.req == req && (t.ac.is_none() || t.ac.as_deref() == ac)) {
                            if let Some(sha) = idx.files.get(&t.file) {
                                hashes.insert(format!("{}:{}", idx.component, t.file), sha.clone());
                            }
                        }
                    }
                    for target in targets_for(store, req, ac) {
                        new.push(Evidence {
                            target,
                            source: format!("eval:{}/{}", r["story"].as_str().unwrap_or(""), r["id"].as_str().unwrap_or("")),
                            status: status.into(),
                            commit: commit.clone(),
                            run: o.run.map(String::from),
                            at: at.clone(),
                            component: o.component.map(String::from),
                            hashes: hashes.clone(),
                        });
                    }
                }
            }
        }
    }
    let _g = store.lock()?;
    let dir = store.root.join("evidence");
    fs::create_dir_all(&dir).map_err(|e| StoreError::bad(e.to_string()))?;
    let mut latest = load_latest(&store.root);
    let mut hist = OpenOptions::new().create(true).append(true).open(dir.join("history.jsonl")).map_err(|e| StoreError::bad(e.to_string()))?;
    let (mut passed, mut failed) = (0, 0);
    let mut targets = BTreeSet::new();
    for e in &new {
        if e.status == "passed" { passed += 1 } else { failed += 1 }
        targets.insert(e.target.clone());
        let _ = writeln!(hist, "{}", serde_json::to_string(e).unwrap());
        latest.insert(format!("{}|{}", e.target, e.source), e.clone());
    }
    fs::write(dir.join("latest.json"), crate::store::dump(&serde_json::to_value(&latest).unwrap())).map_err(|e| StoreError::bad(e.to_string()))?;
    store.commit(&format!("evidence: {} results ({} passed, {} failed){}", new.len(), passed, failed, commit.as_deref().map(|c| format!(" @ {}", &c[..c.len().min(10)])).unwrap_or_default()));
    Ok(json!({"cases": cases, "matched": matched, "skipped": skipped, "unmatched": unmatched, "evidence": new.len(),
              "passed": passed, "failed": failed, "targets": targets.len(), "commit": commit}))
}
