//! MCP server over stdio (JSON-RPC 2.0, newline-delimited). Gives the plugin's agents typed
//! access to the requirements repository: every write is validated, versioned and committed.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::model::{Kind, Rec};
use crate::store::{Res, Store, StoreError};
use crate::workspace::{resolve, Workspace};
use crate::{changes, evals, lint, trace};

const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description, "inputSchema": {"type": "object", "properties": props, "required": required}})
}

pub fn tools() -> Vec<Value> {
    let mut t = base_tools();
    // every project-level tool accepts an optional project key
    for tool in t.iter_mut() {
        let name = tool["name"].as_str().unwrap_or("").to_string();
        if !["init_repo", "list_projects", "create_project"].contains(&name.as_str()) {
            tool["inputSchema"]["properties"]["project"] =
                json!({"type": "string", "description": "project key in the workspace (default: the current/default project)"});
        }
    }
    t
}

fn base_tools() -> Vec<Value> {
    let kind = json!({"type": "string", "enum": ["requirements", "epics", "stories", "tasks"]});
    let obj = json!({"type": "object"});
    let strs = json!({"type": "array", "items": {"type": "string"}});
    let s = json!({"type": "string"});
    vec![
        tool("taxonomy", "Requirement taxonomy (decision-ordered types and categories), field schemas, enums and project config. Call before classifying or creating records.", json!({}), &[]),
        tool("search", "Search records. q is free text; tokens like status:approved or type:quality|data filter exactly.", json!({"kind": kind, "q": s, "where": obj}), &["kind"]),
        tool("get", "Get one record by id (REQ-0001, EPIC-0001, STORY-0001, TASK-0001).", json!({"id": s}), &["id"]),
        tool("create", "Create one record; id is assigned. Returns the record.", json!({"kind": kind, "data": obj}), &["kind", "data"]),
        tool("upsert_many", "Create or update many records of one kind (rows with an existing id are patched). Use for writing a whole elicited requirement set or a whole plan.", json!({"kind": kind, "rows": {"type": "array", "items": obj}, "message": s}), &["kind", "rows"]),
        tool("update", "Patch a record. Pass version for optimistic concurrency.", json!({"id": s, "patch": obj, "version": {"type": "integer"}}), &["id", "patch"]),
        tool("bulk_update", "Mass update records selected by ids or by q/where. set replaces fields; add/remove edit list fields (e.g. tags). All-or-nothing; use dry_run first.", json!({"kind": kind, "ids": strs, "q": s, "where": obj, "set": obj, "add": obj, "remove": obj, "dry_run": {"type": "boolean"}}), &["kind"]),
        tool("delete", "Delete a record (refuses if referenced unless force).", json!({"id": s, "force": {"type": "boolean"}}), &["id"]),
        tool("lint", "MECE + quality lint of the requirement set: overlaps, taxonomy coverage gaps, vague/unmeasurable statements.", json!({}), &[]),
        tool("trace", "Deterministic traceability evaluation: requirement->story coverage, orphans, evals per code story, acceptance-criteria coverage, quality-eval matching, lifecycle coverage.", json!({}), &[]),
        tool("eval_registry", "List evals defined on stories, optionally for one pipeline stage.", json!({"stage": s, "component": s}), &[]),
        tool("save_session", "Persist an elicitation session transcript (markdown: request, research findings with sources, questions and answers, decisions). Returns session id ELI-NNNN.", json!({"title": s, "markdown": s, "id": s}), &["title", "markdown"]),
        tool("config", "Read, or patch with `patch`, the project config (gates, coverage_waivers, components, cicd).", json!({"patch": obj}), &[]),
        tool("sync", "Commit pending changes, pull --rebase and push the requirements repo to GitHub.", json!({"message": s}), &[]),
        tool("context", "A record plus its links: parent/children, stories, tasks, evals and components it affects (impact), and its lint findings.", json!({"id": s}), &["id"]),
        tool("simulate_changeset", "Dry-run a changeset on an in-memory copy: validation errors, dangling references, lint (MECE) delta, traceability delta and blast radius. Writes nothing; iterate until clean. changeset = {title, summary, rationale, ops: [{op: create, kind, ref, data} | {op: update, id, patch, add, remove} | {op: delete, id}], impact}. Use \"$ref\" to point at records created earlier in the same changeset.", json!({"changeset": obj}), &["changeset"]),
        tool("propose_changeset", "Store a changeset for the user to review and apply in the UI. Returns changeset_id. Nothing is written to records until the user applies.", json!({"changeset": obj}), &["changeset"]),
        tool("get_changeset", "Get a stored changeset with its analysis and status.", json!({"id": s}), &["id"]),
        tool("list_changesets", "List changesets, optionally by status (pending, applied, rejected, stale).", json!({"status": s}), &[]),
        tool("apply_changeset", "Apply a pending changeset atomically (only after the user explicitly confirmed it). exclude = op indexes to skip.", json!({"id": s, "exclude": {"type": "array", "items": {"type": "integer"}}}), &["id"]),
        tool("reject_changeset", "Reject a pending changeset.", json!({"id": s, "reason": s}), &["id"]),
        tool("verification", "Verification report: per requirement and acceptance criterion, its status (verified / pending / untested / suspect / failing), tagged tests, implementing code locations, covering evals and evidence. Without `req`: summary, gate checks and a status per requirement.", json!({"req": s}), &[]),
        tool("impact", "Impact of a code change in a component checkout: changed files, requirements touched (via trace tags), tests and evals to re-run, verified criteria put at risk, untraced changes.", json!({"component": s, "base": s, "root": s}), &[]),
        tool("scan_code", "Scan component sources for trace tags and store the code index (writes code/<component>.json and commits).", json!({"components": strs, "root": s}), &[]),
        tool("ingest_evidence", "Ingest CI result files (JUnit XML or reqforge eval report JSON, by path) as verification evidence.", json!({"paths": strs, "component": s, "commit": s, "run": s}), &["paths"]),
        tool("list_projects", "List the projects in the workspace (key, name, path, GitHub remote, artifact counts) and which one is the default.", json!({}), &[]),
        tool("create_project", "Create a new project (its own requirements repository) in the workspace, optionally with a GitHub repo owner/name.", json!({"key": s, "name": s, "github": s, "private": {"type": "boolean"}}), &["key", "name"]),
        tool("init_repo", "Initialise a requirements repository (optionally creating the GitHub repo owner/name).", json!({"path": s, "key": s, "name": s, "github": s, "private": {"type": "boolean"}}), &["path", "key", "name"]),
    ]
}

fn arg<'a>(a: &'a Value, k: &str) -> Res<&'a str> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| StoreError::bad(format!("missing argument '{k}'")))
}
fn kind(a: &Value) -> Res<Kind> {
    Kind::parse(arg(a, "kind")?).map_err(StoreError::bad)
}
fn idkind(a: &Value) -> Res<(Kind, String)> {
    let id = arg(a, "id")?.to_string();
    Ok((Kind::of_id(&id).map_err(StoreError::bad)?, id))
}
fn o(a: &Value, k: &str) -> Rec {
    a.get(k).and_then(Value::as_object).cloned().unwrap_or_default()
}

pub fn call(name: &str, a: &Value) -> Res<Value> {
    if name == "init_repo" {
        let st = Store::init(arg(a, "path")?, arg(a, "key")?, arg(a, "name")?, a.get("github").and_then(Value::as_str).filter(|s| !s.is_empty()), a.get("private").and_then(Value::as_bool).unwrap_or(true))?;
        return Ok(json!({"root": st.root.display().to_string(), "config": st.config_value()}));
    }
    if name == "list_projects" || name == "create_project" {
        let ws = Workspace::open(&Workspace::locate(None).unwrap_or_else(Workspace::default_root))?;
        return if name == "list_projects" {
            Ok(ws.list())
        } else {
            ws.create(arg(a, "key")?, arg(a, "name")?, a.get("github").and_then(Value::as_str), a.get("private").and_then(Value::as_bool).unwrap_or(true))
        };
    }
    let s = resolve(None, a.get("project").and_then(Value::as_str).filter(|p| !p.is_empty()), None)?;
    let s: &Store = &s;
    Ok(match name {
        "taxonomy" => crate::api::meta(s),
        "search" => json!(s.search(kind(a)?, a.get("q").and_then(Value::as_str).unwrap_or(""), &o(a, "where")).iter().map(|r| Value::Object((**r).clone())).collect::<Vec<_>>()),
        "get" => {
            let (k, id) = idkind(a)?;
            Value::Object(s.get(k, &id)?)
        }
        "create" => Value::Object(s.create(kind(a)?, &o(a, "data"), None)?),
        "upsert_many" => {
            let rows: Vec<Rec> = a.get("rows").and_then(Value::as_array).into_iter().flatten().filter_map(|r| r.as_object().cloned()).collect();
            s.upsert_many(kind(a)?, &rows, a.get("message").and_then(Value::as_str))?
        }
        "update" => {
            let (k, id) = idkind(a)?;
            Value::Object(s.update(k, &id, &o(a, "patch"), a.get("version").and_then(Value::as_i64), None)?)
        }
        "bulk_update" => {
            let ids = a.get("ids").and_then(Value::as_array).map(|x| x.iter().filter_map(Value::as_str).map(String::from).collect());
            s.bulk_update(kind(a)?, ids, a.get("q").and_then(Value::as_str).unwrap_or(""), &o(a, "where"), &o(a, "set"), &o(a, "add"), &o(a, "remove"), a.get("dry_run").and_then(Value::as_bool).unwrap_or(false), None)?
        }
        "delete" => {
            let (k, id) = idkind(a)?;
            s.delete(k, &id, a.get("force").and_then(Value::as_bool).unwrap_or(false))?
        }
        "lint" => lint::lint(s),
        "trace" => trace::evaluate(s),
        "eval_registry" => json!(evals::registry(s, a.get("stage").and_then(Value::as_str), a.get("component").and_then(Value::as_str))),
        "save_session" => json!({"id": s.save_session(arg(a, "title")?, arg(a, "markdown")?, a.get("id").and_then(Value::as_str))?}),
        "config" => match a.get("patch").and_then(Value::as_object) {
            Some(p) if !p.is_empty() => s.save_config(p)?,
            _ => s.config_value(),
        },
        "sync" => s.sync(a.get("message").and_then(Value::as_str).unwrap_or("reqforge: sync"))?,
        "context" => changes::context(s, arg(a, "id")?)?,
        "verification" => {
            let full = crate::verify::report(s);
            match a.get("req").and_then(Value::as_str) {
                Some(r) => full["requirements"].get(r).cloned().ok_or_else(|| StoreError::new(format!("{r} not found"), 404))?,
                None => {
                    let mut v = crate::verify::summary(&full);
                    v["statuses"] = full["statuses"].clone();
                    v
                }
            }
        }
        "impact" => crate::impact::impact(s, a.get("component").and_then(Value::as_str), a.get("root").and_then(Value::as_str).map(std::path::Path::new), a.get("base").and_then(Value::as_str))?,
        "scan_code" => {
            let only: Vec<String> = a.get("components").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
            crate::codetrace::scan(s, &only, a.get("root").and_then(Value::as_str).map(std::path::Path::new), true)?
        }
        "ingest_evidence" => {
            let mut files = vec![];
            for p in a.get("paths").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                files.push((p.to_string(), std::fs::read_to_string(p).map_err(|e| StoreError::bad(format!("{p}: {e}")))?));
            }
            let o = crate::evidence::IngestOpts { component: a.get("component").and_then(Value::as_str), commit: a.get("commit").and_then(Value::as_str), run: a.get("run").and_then(Value::as_str) };
            crate::evidence::ingest(s, &files, &o)?
        }
        "simulate_changeset" => changes::simulate(s, a.get("changeset").unwrap_or(&Value::Null)),
        "propose_changeset" => changes::propose(s, a.get("changeset").unwrap_or(&Value::Null))?,
        "get_changeset" => changes::get(s, arg(a, "id")?)?,
        "list_changesets" => json!(changes::list(s, a.get("status").and_then(Value::as_str))),
        "apply_changeset" => {
            let ex: Vec<usize> = a.get("exclude").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).map(|x| x as usize).collect();
            changes::apply(s, arg(a, "id")?, &ex)?
        }
        "reject_changeset" => changes::reject(s, arg(a, "id")?, a.get("reason").and_then(Value::as_str).unwrap_or(""))?,
        other => return Err(StoreError::bad(format!("unknown tool {other}"))),
    })
}

// reqforge: implements REQ-0027
/// Handle one JSON-RPC message; None for notifications. Err((code, message)) for protocol errors.
pub fn handle(msg: &Value) -> Option<Result<Value, (i64, String)>> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let is_notification = msg.get("id").map(Value::is_null).unwrap_or(true);
    let r = match method {
        "initialize" => {
            let want = msg.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("");
            let v = if PROTOCOLS.contains(&want) { want } else { PROTOCOLS[0] };
            Ok(json!({"protocolVersion": v, "capabilities": {"tools": {"listChanged": false}},
                      "serverInfo": {"name": "reqforge", "version": crate::VERSION}}))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = msg.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            Ok(match call(name, &args) {
                Ok(v) => json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}]}),
                Err(e) => json!({"isError": true, "content": [{"type": "text", "text": json!({"error": e.message, "details": e.details}).to_string()}]}),
            })
        }
        _ if is_notification => return None,
        other => Err((-32601, format!("method not found: {other}"))),
    };
    if is_notification {
        return None;
    }
    Some(r)
}

pub fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else { continue };
        let Some(r) = handle(&msg) else { continue };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let resp = match r {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}

