use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;

use reqforge::model::Kind;
use reqforge::store::Store;
use reqforge::workspace::{Workspace, WORKSPACE_FILE};
use serde_json::{json, Value};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_reqforge");

fn req(title: &str) -> serde_json::Map<String, Value> {
    json!({"title": title, "type": "functional", "category": "checkout", "status": "proposed",
           "statement": format!("The system shall {title}."), "acceptance_criteria": [{"id": "AC1", "text": "works"}]})
    .as_object()
    .unwrap()
    .clone()
}

#[test]
fn create_list_rename_default() {
    let d = TempDir::new().unwrap();
    let ws = Workspace::open(d.path()).unwrap();
    assert!(d.path().join(WORKSPACE_FILE).exists());
    ws.create("shop", "Shop", None, true).unwrap();
    ws.create("PAY", "Payments", None, true).unwrap();
    assert_eq!(ws.create("PAY", "dup", None, true).unwrap_err().status, 409);
    assert_eq!(ws.create("x", "bad key", None, true).unwrap_err().status, 400);
    assert_eq!(ws.create("1AB", "bad key", None, true).unwrap_err().status, 400);
    assert!(d.path().join("shop/reqforge.json").exists());
    let l = ws.list();
    let keys: Vec<&str> = l["projects"].as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap()).collect();
    assert_eq!(keys, vec!["SHOP", "PAY"]);
    assert_eq!(l["default"], json!("SHOP"));
    ws.store("PAY").unwrap().create(Kind::Requirements, &req("charge cards"), None).unwrap();
    assert_eq!(ws.describe(&ws.entry("PAY").unwrap())["artifacts"]["requirements"], json!(1));
    ws.rename("pay", "Payments platform").unwrap();
    assert_eq!(ws.store("PAY").unwrap().config_value()["name"], json!("Payments platform"));
    ws.set_default("PAY").unwrap();
    // registry persists
    let ws2 = Workspace::open(d.path()).unwrap();
    assert_eq!(ws2.default_key().as_deref(), Some("PAY"));
    assert_eq!(ws2.entry("PAY").unwrap().name, "Payments platform");
}

#[test]
fn delete_removes_everything_and_needs_confirmation() {
    let d = TempDir::new().unwrap();
    let ws = Workspace::open(d.path()).unwrap();
    ws.create("SHOP", "Shop", None, true).unwrap();
    ws.create("PAY", "Payments", None, true).unwrap();
    let s = ws.store("SHOP").unwrap();
    let r = s.create(Kind::Requirements, &req("check out"), None).unwrap();
    let ep = s.create(Kind::Epics, json!({"title": "Checkout", "requirements": [r["id"]]}).as_object().unwrap(), None).unwrap();
    s.create(Kind::Stories, json!({"title": "Pay", "epic": ep["id"], "requirements": [r["id"]]}).as_object().unwrap(), None).unwrap();
    s.save_session("kickoff", "notes", None).unwrap();
    reqforge::changes::propose(&s, &json!({"title": "x", "ops": [{"op": "update", "id": r["id"], "patch": {"priority": "must"}}]})).unwrap();
    drop(s);

    assert_eq!(ws.delete("SHOP", "", false).unwrap_err().status, 400);
    assert_eq!(ws.delete("SHOP", "PAY", false).unwrap_err().status, 400);
    assert!(d.path().join("shop").exists());

    let out = ws.delete("shop", "SHOP", false).unwrap();
    assert_eq!(out["removed"], json!({"requirements": 1, "epics": 1, "stories": 1, "tasks": 0, "components": 0, "changesets": 1, "sessions": 1, "reports": 0, "code_indexes": 0, "evidence": 0}));
    assert!(!d.path().join("shop").exists(), "directory must be gone");
    assert_eq!(ws.entry("SHOP").unwrap_err().status, 404);
    assert_eq!(out["default"], json!("PAY"));
    assert_eq!(Workspace::open(d.path()).unwrap().list()["projects"].as_array().unwrap().len(), 1);
    // the key can be reused for a fresh, empty project
    ws.create("SHOP", "Shop again", None, true).unwrap();
    assert_eq!(ws.store("SHOP").unwrap().all(Kind::Requirements).len(), 0);
}

#[test]
fn delete_refuses_unsafe_paths() {
    let d = TempDir::new().unwrap();
    let ws = Workspace::open(d.path()).unwrap();
    // a registered path that is not (or no longer) a reqforge repository is never removed
    let other = d.path().join("notes");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("keep.txt"), "important").unwrap();
    Store::init(&other, "NOTES", "Notes", None, true).unwrap();
    ws.import(&other, None).unwrap();
    std::fs::remove_file(other.join("reqforge.json")).unwrap();
    assert_eq!(ws.delete("NOTES", "NOTES", false).unwrap_err().status, 409);
    assert!(other.join("keep.txt").exists());
    // a project whose path contains the workspace is refused
    let outer = TempDir::new().unwrap();
    Store::init(outer.path(), "OUTER", "Outer", None, true).unwrap();
    let inner = outer.path().join("ws");
    let ws2 = Workspace::open(&inner).unwrap();
    ws2.import(outer.path(), None).unwrap();
    assert_eq!(ws2.delete("OUTER", "OUTER", false).unwrap_err().status, 409);
    assert!(inner.join(WORKSPACE_FILE).exists());
}

#[test]
fn import_existing_repository() {
    let d = TempDir::new().unwrap();
    let repo = TempDir::new().unwrap();
    Store::init(repo.path(), "legacy", "Legacy", None, true).unwrap();
    let ws = Workspace::open(d.path()).unwrap();
    let p = ws.import(repo.path(), None).unwrap();
    assert_eq!(p["key"], json!("LEGACY"));
    assert_eq!(ws.import(repo.path(), Some("OTHER")).unwrap_err().status, 409); // same path twice
}

// ------------------------------------------------------------------ HTTP

fn http(port: u16, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let r = ureq::request(method, &format!("http://127.0.0.1:{port}{path}"));
    let res = match body {
        Some(b) => r.send_json(b),
        None => r.call(),
    };
    match res {
        Ok(r) => (r.status(), r.into_json().unwrap_or(Value::Null)),
        Err(ureq::Error::Status(c, r)) => (c, r.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn http_projects_are_isolated_and_deletable() {
    let d = TempDir::new().unwrap();
    let ws = Arc::new(Workspace::open(d.path()).unwrap());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let port = rt.block_on(async { reqforge::api::serve_workspace(ws, "127.0.0.1", 0).await.unwrap().0.port() });

    assert_eq!(http(port, "GET", "/api/requirements", None).0, 404); // no projects yet
    assert_eq!(http(port, "POST", "/api/projects", Some(json!({"key": "SHOP", "name": "Shop"}))).0, 201);
    assert_eq!(http(port, "POST", "/api/projects", Some(json!({"key": "PAY", "name": "Payments"}))).0, 201);
    assert_eq!(http(port, "POST", "/api/p/SHOP/requirements", Some(Value::Object(req("check out")))).0, 201);
    assert_eq!(http(port, "POST", "/api/p/PAY/requirements", Some(Value::Object(req("charge")))).0, 201);
    assert_eq!(http(port, "POST", "/api/p/PAY/requirements", Some(Value::Object(req("refund")))).0, 201);
    assert_eq!(http(port, "GET", "/api/p/SHOP/requirements?limit=10", None).1["total"], json!(1));
    assert_eq!(http(port, "GET", "/api/p/pay/requirements?limit=10", None).1["total"], json!(2));
    assert_eq!(http(port, "GET", "/api/requirements?limit=10", None).1["total"], json!(1)); // default = SHOP
    assert_eq!(http(port, "GET", "/api/p/PAY/meta", None).1["config"]["name"], json!("Payments"));
    assert_eq!(http(port, "GET", "/api/p/NOPE/requirements", None).0, 404);

    let list = http(port, "GET", "/api/projects", None).1;
    assert_eq!(list["projects"][1]["artifacts"]["requirements"], json!(2));
    assert_eq!(http(port, "PATCH", "/api/projects/PAY", Some(json!({"default": true, "name": "Pay"}))).1["name"], json!("Pay"));
    assert_eq!(http(port, "GET", "/api/requirements?limit=10", None).1["total"], json!(2)); // default = PAY now

    assert_eq!(http(port, "DELETE", "/api/projects/PAY", None).0, 400); // no confirmation
    let (code, out) = http(port, "DELETE", "/api/projects/PAY?confirm=PAY", None);
    assert_eq!(code, 200);
    assert_eq!(out["removed"]["requirements"], json!(2));
    assert!(!d.path().join("pay").exists());
    assert_eq!(http(port, "GET", "/api/p/PAY/requirements", None).0, 404);
    assert_eq!(http(port, "GET", "/api/projects", None).1["default"], json!("SHOP"));
}

#[test]
fn single_project_mode_cannot_manage_projects() {
    let d = TempDir::new().unwrap();
    let store = Store::init(d.path(), "ONE", "One", None, true).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let port = rt.block_on(async { reqforge::api::serve(Arc::new(store), "127.0.0.1", 0).await.unwrap().0.port() });
    let l = http(port, "GET", "/api/projects", None).1;
    assert_eq!((l["single"].clone(), l["projects"][0]["key"].clone()), (json!(true), json!("ONE")));
    assert_eq!(http(port, "POST", "/api/projects", Some(json!({"key": "TWO", "name": "Two"}))).0, 400);
    assert_eq!(http(port, "DELETE", "/api/projects/ONE?confirm=ONE", None).0, 400);
    assert!(d.path().join("reqforge.json").exists());
    assert_eq!(http(port, "GET", "/api/p/ONE/requirements?limit=1", None).0, 200);
}

// ------------------------------------------------------------------ CLI + MCP

#[test]
fn cli_projects() {
    let d = TempDir::new().unwrap();
    let ws = d.path().to_str().unwrap();
    let cwd = TempDir::new().unwrap(); // outside any repo
    let run = |args: &[&str]| {
        Command::new(BIN).args(args).current_dir(cwd.path()).env_remove("REQFORGE_REPO").env_remove("REQFORGE_PROJECT").env("REQFORGE_WORKSPACE", ws).output().unwrap()
    };
    assert!(run(&["project", "create", "SHOP", "--name", "Shop"]).status.success());
    assert!(run(&["project", "create", "PAY", "--name", "Payments"]).status.success());
    assert!(run(&["-P", "PAY", "add", "req", "--data", &Value::Object(req("charge")).to_string()]).status.success());
    assert!(run(&["add", "req", "--data", &Value::Object(req("check out")).to_string()]).status.success()); // default SHOP
    let pay = String::from_utf8(run(&["--project", "pay", "list", "req"]).stdout).unwrap();
    assert!(pay.contains("charge") && !pay.contains("check out"));
    let list = String::from_utf8(run(&["project", "list"]).stdout).unwrap();
    assert!(list.contains("* SHOP") && list.contains("PAY"), "{list}");
    assert_eq!(run(&["project", "delete", "PAY", "--confirm", "SHOP"]).status.code(), Some(2));
    assert!(run(&["project", "delete", "PAY", "--confirm", "PAY"]).status.success());
    assert!(!d.path().join("pay").exists());
    assert_eq!(run(&["-P", "PAY", "list", "req"]).status.code(), Some(2));
}

#[test]
fn mcp_projects() {
    let d = TempDir::new().unwrap();
    let msgs = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "create_project", "arguments": {"key": "SHOP", "name": "Shop"}}}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "create_project", "arguments": {"key": "PAY", "name": "Pay"}}}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "create", "arguments": {"project": "PAY", "kind": "requirements", "data": req("charge")}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "list_projects", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "search", "arguments": {"kind": "requirements"}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/list"}),
    ];
    let cwd = TempDir::new().unwrap();
    let mut child = Command::new(BIN)
        .arg("mcp")
        .current_dir(cwd.path())
        .env_remove("REQFORGE_REPO")
        .env_remove("REQFORGE_PROJECT")
        .env("REQFORGE_WORKSPACE", d.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(msgs.iter().map(|m| m.to_string() + "\n").collect::<String>().as_bytes()).unwrap();
    let out: Vec<Value> = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let text = |i: usize| serde_json::from_str::<Value>(out[i]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text(2)["id"], json!("REQ-0001"));
    assert_eq!(text(3)["projects"][1]["artifacts"]["requirements"], json!(1));
    assert_eq!(text(4), json!([])); // default project SHOP is empty
    let tools = out[5]["result"]["tools"].as_array().unwrap();
    assert!(!tools.iter().any(|t| t["name"] == json!("delete_project")), "agents must not delete projects");
    assert!(tools.iter().find(|t| t["name"] == json!("search")).unwrap()["inputSchema"]["properties"].get("project").is_some());
}
