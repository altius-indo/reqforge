//! Project snapshot: `state/HOT.md` in the requirements repo (requirements/design/context-management.md).
//!
//! One short, human-approved statement of where the project is: `## Now`, `## Next` (exactly one
//! item) and `## Watch`, plus a `Last reconciled: YYYY-MM-DD` line, at most 8,192 bytes. It changes
//! only when a changeset with a `snapshot` op is applied (`changes::apply` is the only caller of
//! `write_unlocked`). Chat sessions and coding-agent runs get its full text as a `<project-state>`
//! block, and the plugin's SessionStart/compact hook supplies it again after compaction.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use chrono::NaiveDate;
use regex::Regex;
use serde_json::{json, Value};

use crate::store::{Res, Source, StoreError};

/// Location of the snapshot, relative to the requirements root.
pub const PATH: &str = "state/HOT.md";
pub const MAX_BYTES: usize = 8192;
/// Lint warns when the snapshot was last reconciled more than this many days ago.
pub const STALE_DAYS: i64 = 21;
const HEADINGS: [&str; 3] = ["Now", "Next", "Watch"];
const OPEN: &str = "<project-state";
const CLOSE: &str = "</project-state>";

static DATE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Last reconciled: (\d{4}-\d{2}-\d{2})$").unwrap());
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[-*] |\d+\. )").unwrap());

pub fn read(root: &Path) -> Option<String> {
    fs::read_to_string(root.join(PATH)).ok()
}

/// sha256 of the content, or "absent"; the changeset base version of the snapshot.
pub fn version_of(content: Option<&str>) -> String {
    content.map(|c| crate::codetrace::sha256(c.as_bytes())).unwrap_or_else(|| "absent".into())
}

fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn lines(content: &str) -> impl Iterator<Item = &str> {
    content.lines().map(|l| l.trim_end_matches('\r'))
}

/// Errors in the snapshot; empty when it is valid (REQ-0057#AC1, AC3).
// reqforge: implements REQ-0057
pub fn validate(content: &str) -> Vec<String> {
    let mut errors = vec![];
    if content.len() > MAX_BYTES {
        errors.push(format!("snapshot: {} bytes, limit is {}", thousands(content.len()), thousands(MAX_BYTES)));
    }
    let ls: Vec<&str> = lines(content).collect();
    let mut at: Vec<Option<usize>> = vec![];
    for h in HEADINGS {
        let pos: Vec<usize> = ls.iter().enumerate().filter(|(_, l)| l.trim_end() == format!("## {h}")).map(|(i, _)| i).collect();
        match pos.len() {
            0 => errors.push(format!("snapshot: missing heading '## {h}'")),
            1 => {}
            n => errors.push(format!("snapshot: heading '## {h}' appears {n} times, must appear once")),
        }
        at.push(pos.first().copied());
    }
    if let [Some(a), Some(b), Some(c)] = at[..] {
        if !(a < b && b < c) {
            errors.push("snapshot: headings out of order (expected Now, Next, Watch)".into());
        }
    }
    if let Some(next) = at[1] {
        let items = ls[next + 1..].iter().take_while(|l| !(l.starts_with("## ") || l.starts_with("# "))).filter(|l| ITEM.is_match(l)).count();
        if items != 1 {
            errors.push(format!("snapshot: Next has {items} items, must have exactly 1"));
        }
    }
    let dates: Vec<&str> = ls.iter().filter_map(|l| DATE_LINE.captures(l).map(|c| c.get(1).unwrap().as_str())).collect();
    match dates.as_slice() {
        [] => errors.push("snapshot: missing line 'Last reconciled: YYYY-MM-DD'".into()),
        [d] => {
            if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() {
                errors.push(format!("snapshot: Last reconciled date {d} is not a real date"));
            }
        }
        _ => errors.push(format!("snapshot: {} 'Last reconciled' lines, must have exactly 1", dates.len())),
    }
    if content.contains(OPEN) || content.contains(CLOSE) {
        errors.push(format!("snapshot: must not contain '{OPEN}' or '{CLOSE}'"));
    }
    errors
}

pub fn last_reconciled(content: &str) -> Option<NaiveDate> {
    lines(content).find_map(|l| DATE_LINE.captures(l)).and_then(|c| NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").ok())
}

/// Today's date for staleness; `REQFORGE_TODAY=YYYY-MM-DD` overrides it in tests.
pub fn today() -> NaiveDate {
    std::env::var("REQFORGE_TODAY")
        .ok()
        .and_then(|d| NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").ok())
        .unwrap_or_else(|| chrono::Local::now().date_naive())
}

/// Plain LCS line diff: [{"t": " "|"+"|"-", "line": …}]. An absent old side is empty.
pub fn line_diff(old: &str, new: &str) -> Vec<Value> {
    let a: Vec<&str> = if old.is_empty() { vec![] } else { lines(old).collect() };
    let b: Vec<&str> = lines(new).collect();
    let row = |t: &str, l: &str| json!({"t": t, "line": l});
    // oversized (hence invalid) content: skip the quadratic table, show a full replacement
    if a.len() * b.len() > 4_000_000 {
        return a.iter().map(|l| row("-", l)).chain(b.iter().map(|l| row("+", l))).collect();
    }
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, vec![]);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            out.push(row(" ", a[i]));
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            out.push(row("+", b[j]));
            j += 1;
        } else {
            out.push(row("-", a[i]));
            i += 1;
        }
    }
    out
}

/// The snapshot as injected into a session: marked as project state, content verbatim.
// reqforge: implements REQ-0058
pub fn context_block(content: &str) -> String {
    let date = last_reconciled(content).map(|d| format!(" last-reconciled=\"{d}\"")).unwrap_or_default();
    let nl = if content.ends_with('\n') { "" } else { "\n" };
    format!("{OPEN} source=\"{PATH}\"{date}>\n{content}{nl}{CLOSE}")
}

/// Write the snapshot (temp file + rename). Only `changes::apply` calls this, under the store lock.
pub(crate) fn write_unlocked(root: &Path, content: &str) -> Res<()> {
    let path = root.join(PATH);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| StoreError::bad(e.to_string()))?;
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| StoreError::bad(e.to_string()))?;
    fs::rename(&tmp, &path).map_err(|e| StoreError::bad(e.to_string()))
}

/// Re-supply the snapshot in the system prompt on every turn (fallback for the compaction hook).
pub fn resupply_in_system_prompt() -> bool {
    std::env::var("REQFORGE_SNAPSHOT_RESUPPLY").map(|v| v.trim() == "system").unwrap_or(false)
}

/// SessionStart hook output after compaction, or None when there is no snapshot (REQ-0058#AC3).
/// For an agent run (`task` set) the task's next action block comes first.
// reqforge: implements REQ-0058
pub fn hook_output(root: &Path, task: Option<&str>) -> Option<String> {
    let content = read(root)?;
    let mut ctx = String::new();
    if let Some(t) = task.filter(|t| !t.is_empty()) {
        let next = crate::store::Store::open(root).ok().and_then(|s| s.get(crate::model::Kind::Tasks, t).ok()).and_then(|r| crate::taskflow::next_action_block(&r));
        if let Some(n) = next {
            ctx.push_str(&n);
            ctx.push_str("\n\n");
        }
    }
    ctx.push_str(&context_block(&content));
    Some(json!({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}).to_string())
}

/// `GET …/snapshot`: whether it exists, and its size, date, age and validation errors.
pub fn status(root: &Path) -> Value {
    let Some(content) = read(root) else { return json!({"exists": false}) };
    let lr = last_reconciled(&content);
    let age = lr.map(|d| (today() - d).num_days());
    json!({"exists": true, "path": PATH, "content": content, "bytes": content.len(), "last_reconciled": lr.map(|d| d.to_string()),
           "age_days": age, "stale": age.map(|a| a > STALE_DAYS).unwrap_or(false), "errors": validate(&content)})
}

// reqforge: implements REQ-0057
/// Monitor counts: whether there is a snapshot, its age in days, whether it is stale and by how
/// many days past STALE_DAYS (0 when fresh or absent).
pub fn monitor_counts(src: &dyn Source) -> Value {
    let Some(content) = src.snapshot() else {
        return json!({"exists": false, "last_reconciled": null, "age_days": null, "stale": false, "days_over": 0, "limit_days": STALE_DAYS, "valid": false});
    };
    let lr = last_reconciled(&content);
    let age = lr.map(|d| (today() - d).num_days());
    let over = age.map(|a| (a - STALE_DAYS).max(0)).unwrap_or(0);
    json!({"exists": true, "last_reconciled": lr.map(|d| d.to_string()), "age_days": age, "stale": over > 0, "days_over": over,
           "limit_days": STALE_DAYS, "valid": validate(&content).is_empty()})
}

/// Lint findings: a stale or invalid snapshot; none when there is no snapshot (REQ-0057#AC4).
// reqforge: implements REQ-0057
pub fn lint_findings(src: &dyn Source) -> Vec<Value> {
    let Some(content) = src.snapshot() else { return vec![] };
    if let Some(first) = validate(&content).into_iter().next() {
        return vec![json!({"severity": "warning", "rule": "snapshot-invalid", "ids": [], "message": format!("{PATH} is invalid: {first}")})];
    }
    let Some(d) = last_reconciled(&content) else { return vec![] };
    let age = (today() - d).num_days();
    if age > STALE_DAYS {
        return vec![json!({"severity": "warning", "rule": "snapshot-stale", "ids": [],
            "message": format!("{PATH} last reconciled {d} ({age} days ago, limit {STALE_DAYS})")})];
    }
    vec![]
}
