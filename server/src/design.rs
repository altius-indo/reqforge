//! Design documents: design/<slug>.md files in the requirements repository, each with
//! front matter giving a title and the requirement ids it realises. Served read-only.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};

use crate::model::Kind;
use crate::store::{Res, Source, StoreError};

pub const DIR: &str = "design";

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").unwrap());
static REQ_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^REQ-[0-9]+$").unwrap());

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DesignDoc {
    pub slug: String,
    pub title: String,
    pub realises: Vec<String>,
}

pub fn valid_slug(slug: &str) -> bool {
    SLUG.is_match(slug)
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let q = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if q { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

/// Parse the `---` front matter: `title: ...` and `realises: [A, B]` or a `- A` block list.
pub fn parse_front_matter(text: &str) -> (String, Vec<String>) {
    let mut lines = text.lines();
    let (mut title, mut realises) = (String::new(), vec![]);
    if lines.next().map(str::trim_end) != Some("---") {
        return (title, realises);
    }
    let mut in_list = false;
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        let t = line.trim();
        if in_list {
            if let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix('-').filter(|_| t == "-")) {
                let item = unquote(item);
                if !item.is_empty() {
                    realises.push(item);
                }
                continue;
            }
            in_list = false;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        match k.trim() {
            "title" => title = unquote(v),
            "realises" => {
                let v = v.trim();
                if let Some(inner) = v.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
                    realises = inner.split(',').map(unquote).filter(|x| !x.is_empty()).collect();
                } else if v.is_empty() {
                    in_list = true;
                } else {
                    realises = vec![unquote(v)];
                }
            }
            _ => {}
        }
    }
    (title, realises)
}

// reqforge: implements REQ-0054
/// Every design/<slug>.md with a valid slug, sorted by slug.
pub fn list(root: &Path) -> Vec<DesignDoc> {
    let mut out: Vec<DesignDoc> = fs::read_dir(root.join(DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let slug = name.strip_suffix(".md").filter(|s| valid_slug(s))?.to_string();
            let text = fs::read_to_string(e.path()).ok()?;
            let (title, realises) = parse_front_matter(&text);
            Some(DesignDoc { title: if title.is_empty() { slug.clone() } else { title }, slug, realises })
        })
        .collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

// reqforge: implements REQ-0054
/// Raw Markdown of design/<slug>.md. The slug is validated before any file is touched,
/// and the resolved path must stay inside design/ (no symlink escapes).
pub fn read(root: &Path, slug: &str) -> Res<String> {
    if !valid_slug(slug) {
        return Err(StoreError::bad(format!("invalid design slug '{slug}': must match ^[a-z0-9][a-z0-9-]{{0,63}}$")));
    }
    let missing = || StoreError::new(format!("design document {slug} not found"), 404);
    let dir = fs::canonicalize(root.join(DIR)).map_err(|_| missing())?;
    let path = fs::canonicalize(dir.join(format!("{slug}.md"))).map_err(|_| missing())?;
    if !path.starts_with(&dir) || !path.is_file() {
        return Err(missing());
    }
    fs::read_to_string(path).map_err(|_| missing())
}

/// Design documents that realise the given requirement.
pub fn realising(docs: &[DesignDoc], id: &str) -> Value {
    json!(docs.iter().filter(|d| d.realises.iter().any(|r| r == id)).map(|d| json!({"slug": d.slug, "title": d.title})).collect::<Vec<_>>())
}

// reqforge: implements REQ-0054
/// Lint findings: one error per realises entry that is not an existing requirement id.
pub fn lint_findings(src: &dyn Source) -> Vec<Value> {
    let mut out = vec![];
    for d in src.design_docs() {
        for id in &d.realises {
            if !REQ_ID.is_match(id) || !src.exists(Kind::Requirements, id) {
                out.push(json!({"severity": "error", "rule": "design-realises", "ids": [id], "file": format!("{DIR}/{}.md", d.slug),
                    "message": format!("{DIR}/{}.md realises {id}, which is not an existing requirement id", d.slug)}));
            }
        }
    }
    out
}
