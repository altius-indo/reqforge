//! Code traceability: trace tags in source and tests, scanned into a per-component index.
//!
//! reqforge:off  (the grammar below is documentation, not tags)
//! Tag grammar (language-neutral, lives in the code so it moves with refactors and is reviewed in PRs):
//!   `reqforge: implements REQ-0042`            on implementation entry points
//!   `reqforge: verifies REQ-0042#AC1, REQ-0043` anywhere (explicit)
//!   In test files, any requirement id is a "verifies" tag, so framework-native markers work as-is:
//!     pytest  @pytest.mark.req("REQ-0042#AC1")     Jest/Vitest  test("[REQ-0042#AC1] declined card", …)
//!     JUnit   @Tag("REQ-0042")                     Go/Rust      // REQ-0042#AC1
//! reqforge:on
//! A tag without `#AC…` applies to every acceptance criterion of the requirement.
//! Decision ids (`DEC-0007`) are tagged exactly like requirement ids.
//! Suppression: lines between `reqforge:off` and `reqforge:on` are skipped, and a file whose first
//! 10 lines contain `reqforge:ignore-file` is skipped entirely (fixtures, docs, examples that
//! mention ids as data). A component with `tag_mode: explicit` only honours explicit comments.
//!
//! `scan` walks a component's files (respecting .gitignore), attaches each tag to the nearest
//! symbol (function/test/class; heuristic, language-agnostic), hashes every tagged file, and writes
//! `code/<component-key>.json` in the requirements repo. File hashes drive "suspect" detection:
//! evidence recorded against an older version of a file no longer counts as verification.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use globset::{Glob, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::model::{s, strs, Kind, Rec};
use crate::store::{dump, now, Res, Source, Store, StoreError};

static EXPLICIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)reqforge:\s*(implements|implement|impl|verifies|verify|tests|test)\s+((?:(?:REQ|DEC)-\d{4,}(?:#[A-Za-z0-9_.-]+)?[\s,;]*)+)").unwrap()
});
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b((?:REQ|DEC)-\d{4,})(?:#([A-Za-z0-9_.-]+))?").unwrap());
static TEST_FILE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?x)(^|/)(tests?|__tests__|specs?|e2e|integration|testing)/
          |(^|/)test_[^/]*\.py$ |_test\.(py|go|rs|rb|exs|ex)$ |\.(test|spec)\.[cm]?[jt]sx?$
          |(Test|Tests|IT)\.(java|kt|scala|cs|swift)$ |_spec\.rb$ |(^|/)conftest\.py$",
    )
    .unwrap()
});
/// Symbol heuristics, tried in order; group 1 is the name.
static SYMBOLS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r#"^\s*(?:it|test|describe|scenario|context)(?:\.(?:each|only|skip|concurrent)(?:\([^)]*\))?)?\s*\(\s*['"`]([^'"`]+)"#,
        r"^\s*(?:async\s+)?def\s+(\w+)",
        r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)",
        r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)",
        r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>",
        r"^\s*func\s+(?:\([^)]*\)\s*)?(\w+)",
        r"^\s*(?:(?:public|private|protected|internal|static|final|override|abstract|suspend|async|virtual)\s+)*(?:fun\s+|void\s+|[\w<>\[\],.?]+\s+)(\w+)\s*\(",
        r"^\s*(?:export\s+)?(?:abstract\s+)?(?:class|struct|enum|trait|interface|impl|module|object)\s+(\w+)",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
const KEYWORDS: &[&str] = &["if", "for", "while", "switch", "return", "catch", "new", "else", "match", "await"];
const EXCLUDE_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".git", "vendor", ".venv", "venv", "__pycache__", ".next", "coverage", ".reqforge",
];
const MAX_FILE: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tag {
    pub req: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ac: Option<String>,
    /// "implements" | "verifies"
    pub kind: String,
    pub file: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub text: String,
    pub component: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Index {
    pub component: String,
    pub root: String,
    #[serde(default)]
    pub commit: Option<String>,
    pub scanned_at: String,
    pub files_scanned: usize,
    /// sha256 of every file that carries at least one tag
    pub files: BTreeMap<String, String>,
    pub tags: Vec<Tag>,
}

/// Requirement and decision ids (with optional criterion) mentioned in a piece of text.
pub fn ids_in(text: &str) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = vec![];
    for c in ID.captures_iter(text) {
        let id = (c[1].to_string(), c.get(2).map(|m| m.as_str().to_string()));
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

pub fn is_test_file(rel: &str) -> bool {
    TEST_FILE.is_match(rel)
}

pub fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn symbol_of(line: &str) -> Option<String> {
    for re in SYMBOLS.iter() {
        if let Some(c) = re.captures(line) {
            let name = c[1].trim().to_string();
            if !KEYWORDS.contains(&name.as_str()) && !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

/// Nearest symbol: the tag line itself, then up to 6 lines below (decorators/annotations sit
/// above the definition), then the enclosing definition up to 80 lines above.
fn attach_symbol(lines: &[&str], idx: usize) -> Option<String> {
    if let Some(sym) = symbol_of(lines[idx]) {
        return Some(sym);
    }
    for l in lines.iter().skip(idx + 1).take(6) {
        if let Some(sym) = symbol_of(l) {
            return Some(sym);
        }
    }
    (idx.saturating_sub(80)..idx).rev().find_map(|i| symbol_of(lines[i]))
}

/// Extract the tags in one file's text (auto mode).
pub fn tags_in(rel: &str, text: &str, component: &str) -> Vec<Tag> {
    tags_in_mode(rel, text, component, false)
}

static OFF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"reqforge:off\b").unwrap());
static ON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"reqforge:on\b").unwrap());

// reqforge: implements REQ-0021
// reqforge: implements REQ-0061
/// Extract the tags in one file's text; `explicit_only` ignores bare ids in test files.
pub fn tags_in_mode(rel: &str, text: &str, component: &str, explicit_only: bool) -> Vec<Tag> {
    let test_file = is_test_file(rel) && !explicit_only;
    let lines: Vec<&str> = text.lines().collect();
    if lines.iter().take(10).any(|l| l.contains("reqforge:ignore-file")) {
        return vec![];
    }
    let mut out = vec![];
    let mut off = false;
    for (i, line) in lines.iter().enumerate() {
        if OFF.is_match(line) {
            off = true;
            continue;
        }
        if ON.is_match(line) {
            off = false;
            continue;
        }
        if off || !(line.contains("REQ-") || line.contains("DEC-")) {
            continue;
        }
        let mut seen: Vec<(String, Option<String>)> = vec![];
        let mut push = |req: String, ac: Option<String>, kind: &str, out: &mut Vec<Tag>| {
            if seen.contains(&(req.clone(), ac.clone())) {
                return;
            }
            seen.push((req.clone(), ac.clone()));
            out.push(Tag {
                req,
                ac,
                kind: kind.into(),
                file: rel.into(),
                line: i + 1,
                symbol: attach_symbol(&lines, i),
                text: line.trim().chars().take(200).collect(),
                component: component.into(),
            });
        };
        for c in EXPLICIT.captures_iter(line) {
            let verb = c[1].to_lowercase();
            let kind = if verb.starts_with("impl") { "implements" } else { "verifies" };
            for id in ID.captures_iter(&c[2]) {
                push(id[1].to_string(), id.get(2).map(|m| m.as_str().to_string()), kind, &mut out);
            }
        }
        if test_file {
            for id in ID.captures_iter(line) {
                push(id[1].to_string(), id.get(2).map(|m| m.as_str().to_string()), "verifies", &mut out);
            }
        }
    }
    out
}

pub fn git_head(root: &Path) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(root).args(["rev-parse", "HEAD"]).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Scan `root` (files matching `globs`, default everything) for trace tags.
pub fn scan_dir(root: &Path, component: &str, globs: &[String]) -> Res<Index> {
    scan_dir_excluding(root, component, globs, None)
}

pub fn scan_dir_excluding(root: &Path, component: &str, globs: &[String], exclude: Option<&Path>) -> Res<Index> {
    scan_dir_mode(root, component, globs, exclude, false)
}

/// Like `scan_dir`, skipping everything under `exclude` (the requirements repo when it sits
/// inside the component tree: its JSON and index files mention requirement ids by design).
pub fn scan_dir_mode(root: &Path, component: &str, globs: &[String], exclude: Option<&Path>, explicit_only: bool) -> Res<Index> {
    if !root.is_dir() {
        return Err(StoreError::bad(format!("component {component}: {} is not a directory", root.display())));
    }
    let mut gb = GlobSetBuilder::new();
    let patterns: Vec<String> = if globs.is_empty() { vec!["**".into()] } else { globs.to_vec() };
    for g in &patterns {
        gb.add(Glob::new(g).map_err(|e| StoreError::bad(format!("component {component}: bad glob '{g}': {e}")))?);
    }
    let set = gb.build().map_err(|e| StoreError::bad(e.to_string()))?;
    let mut idx = Index {
        component: component.into(),
        root: root.display().to_string(),
        commit: git_head(root),
        scanned_at: now(),
        ..Default::default()
    };
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false) // dot-directories such as .github are real sources; noise dirs are excluded below
        .git_ignore(true)
        .require_git(false)
        .filter_entry(|e| !EXCLUDE_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if exclude.map(|x| path.starts_with(x)).unwrap_or(false) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !set.is_match(&rel) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = fs::read(path) else { continue };
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        idx.files_scanned += 1;
        let tags = tags_in_mode(&rel, text, component, explicit_only);
        if !tags.is_empty() {
            idx.files.insert(rel.clone(), sha256(&bytes));
            idx.tags.extend(tags);
        }
    }
    idx.tags.sort_by(|a, b| (a.file.as_str(), a.line, a.req.as_str()).cmp(&(b.file.as_str(), b.line, b.req.as_str())));
    Ok(idx)
}

// ------------------------------------------------------------------ components + stored index

pub fn component_root(store: &Store, comp: &Rec) -> Option<PathBuf> {
    let p = s(comp, "path");
    if p.is_empty() {
        return None;
    }
    let pb = PathBuf::from(p);
    Some(if pb.is_absolute() { pb } else { store.root.join(pb) })
}

pub fn component_by_key(src: &dyn Source, key: &str) -> Option<std::sync::Arc<Rec>> {
    src.records(Kind::Components).into_iter().find(|c| s(c, "key") == key)
}

fn index_path(store: &Store, key: &str) -> PathBuf {
    store.root.join("code").join(format!("{key}.json"))
}

pub fn load_index(root: &Path, key: &str) -> Option<Index> {
    serde_json::from_str(&fs::read_to_string(root.join("code").join(format!("{key}.json"))).ok()?).ok()
}

/// All stored indexes of a project (one per scanned component).
pub fn load_all(root: &Path) -> Vec<Index> {
    let mut out: Vec<Index> = fs::read_dir(root.join("code"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok())
        .collect();
    out.sort_by(|a: &Index, b: &Index| a.component.cmp(&b.component));
    out
}

// reqforge: implements REQ-0021
/// Scan components and store their indexes. `root_override` scans one component at a given
/// checkout (CI: `--root .`); it needs `only` to name the component unless exactly one exists.
pub fn scan(store: &Store, only: &[String], root_override: Option<&Path>, write: bool) -> Res<Value> {
    let comps = store.records(Kind::Components);
    if comps.is_empty() {
        return Err(StoreError::bad("no components defined: add one (kind components: title, key, path, globs) before scanning"));
    }
    let selected: Vec<_> = if only.is_empty() {
        comps.clone()
    } else {
        only.iter()
            .map(|k| component_by_key(store, k).ok_or_else(|| StoreError::new(format!("unknown component '{k}'"), 404)))
            .collect::<Res<_>>()?
    };
    if root_override.is_some() && selected.len() != 1 {
        return Err(StoreError::bad("--root scans a single component: pass --component KEY"));
    }
    let mut results = vec![];
    let mut written = vec![];
    for c in &selected {
        let key = s(c, "key").to_string();
        let root = match root_override.map(Path::to_path_buf).or_else(|| component_root(store, c)) {
            Some(r) => r,
            None => {
                results.push(json!({"component": key, "skipped": "no path set (set the component's path, or scan with --root)"}));
                continue;
            }
        };
        let globs: Vec<String> = strs(c, "globs").into_iter().map(String::from).collect();
        let idx = scan_dir_mode(&fs::canonicalize(&root).unwrap_or(root), &key, &globs, Some(&store.root), s(c, "tag_mode") == "explicit")?;
        let implements = idx.tags.iter().filter(|t| t.kind == "implements").count();
        results.push(json!({"component": key, "root": idx.root, "commit": idx.commit, "files_scanned": idx.files_scanned,
                            "tagged_files": idx.files.len(), "tags": idx.tags.len(), "implements": implements,
                            "verifies": idx.tags.len() - implements}));
        if write {
            let p = index_path(store, &key);
            fs::create_dir_all(p.parent().unwrap()).ok();
            fs::write(&p, dump(&serde_json::to_value(&idx).unwrap())).map_err(|e| StoreError::bad(e.to_string()))?;
            written.push(key);
        }
    }
    if write && !written.is_empty() {
        let _g = store.lock()?;
        store.commit(&format!("code: scan {}", written.join(", ")));
    }
    Ok(json!({"scanned": results}))
}
