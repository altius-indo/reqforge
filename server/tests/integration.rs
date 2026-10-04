use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

use reqforge::changes;
use reqforge::console::Console;
use reqforge::model::{Kind, Rec};
use reqforge::store::{Source, Store};
use reqforge::{cicd, csvio, evals, lint, query, trace};
use serde_json::{json, Map, Value};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_reqforge");

fn rec(v: Value) -> Rec {
    v.as_object().unwrap().clone()
}
fn req_login() -> Value {
    json!({"title": "Password login", "type": "functional", "category": "authentication", "priority": "must", "status": "approved",
           "statement": "The system shall authenticate users with email and password.", "rationale": "Baseline access control.",
           "acceptance_criteria": [{"id": "AC1", "text": "Valid credentials yield a session"},
                                   {"id": "AC2", "text": "Invalid credentials are rejected with a generic error"}]})
}
fn req_latency() -> Value {
    json!({"title": "Login latency", "type": "quality", "category": "performance-efficiency", "priority": "should", "status": "approved",
           "statement": "The system shall complete login within 300 ms at p95 under 200 rps.",
           "acceptance_criteria": [{"id": "AC1", "text": "p95 < 300 ms at 200 rps"}]})
}
fn merge(a: Value, b: Value) -> Rec {
    let mut r = rec(a);
    for (k, v) in b.as_object().unwrap() {
        r.insert(k.clone(), v.clone());
    }
    r
}

struct Fx {
    dir: TempDir,
    store: Store,
}

fn fx() -> Fx {
    let dir = TempDir::new().unwrap();
    let store = Store::init(dir.path(), "demo", "Demo", None, true).unwrap();
    Fx { dir, store }
}

impl Fx {
    fn id(r: &Rec) -> String {
        r["id"].as_str().unwrap().to_string()
    }
    /// requirement ids (login, latency), epic, story
    fn seed_plan(&self, with_evals: bool) -> (String, String, String, Rec) {
        let s = &self.store;
        let r1 = Self::id(&s.create(Kind::Requirements, &rec(req_login()), None).unwrap());
        let r2 = Self::id(&s.create(Kind::Requirements, &rec(req_latency()), None).unwrap());
        let ep = Self::id(&s.create(Kind::Epics, &rec(json!({"title": "Access", "requirements": [r1, r2]})), None).unwrap());
        let evs = if with_evals {
            json!([{"id": "E1", "name": "login unit", "kind": "unit", "command": "true", "covers": [format!("{r1}#AC1"), format!("{r1}#AC2")]},
                   {"id": "E2", "name": "login load", "kind": "performance", "command": "true", "covers": [format!("{r2}#AC1")]}])
        } else {
            json!([])
        };
        let st = s.create(Kind::Stories, &rec(json!({"title": "Log in", "epic": ep, "requirements": [r1, r2], "evals": evs})), None).unwrap();
        for k in ["design", "code", "deployment", "monitoring"] {
            s.create(Kind::Tasks, &rec(json!({"title": format!("{k} login"), "story": st["id"], "kind": k})), None).unwrap();
        }
        (r1, r2, ep, st)
    }
    fn git_log(&self) -> String {
        String::from_utf8(Command::new("git").arg("-C").arg(self.dir.path()).args(["log", "--format=%s"]).output().unwrap().stdout).unwrap()
    }
}

// ============================================================================ store

// reqforge: verifies REQ-0003#AC1
// reqforge: verifies REQ-0037#AC1
#[test]
fn create_assigns_ids_and_commits() {
    let f = fx();
    let r = f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    assert_eq!((r["id"].as_str().unwrap(), r["version"].as_i64().unwrap()), ("REQ-0001", 1));
    assert!(f.git_log().contains("REQ-0001: create"));
    // on-disk order: id, schema fields, system fields
    let text = std::fs::read_to_string(f.dir.path().join("requirements/REQ-0001.json")).unwrap();
    assert!(text.starts_with("{\n  \"id\": \"REQ-0001\",\n  \"title\""));
}

// reqforge: verifies REQ-0004#AC1
// reqforge: verifies REQ-0004#AC2
#[test]
fn validation_rejects_bad_category_and_refs() {
    let f = fx();
    let e = f.store.create(Kind::Requirements, &merge(req_latency(), json!({"category": "speed"})), None).unwrap_err();
    assert!(e.details[0].as_str().unwrap().starts_with("category"));
    assert!(f.store.create(Kind::Stories, &rec(json!({"title": "x", "epic": "EPIC-0099"})), None).is_err());
}

// reqforge: verifies REQ-0005#AC1
#[test]
fn optimistic_concurrency() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    f.store.update(Kind::Requirements, "REQ-0001", &rec(json!({"priority": "should"})), Some(1), None).unwrap();
    let e = f.store.update(Kind::Requirements, "REQ-0001", &rec(json!({"priority": "could"})), Some(1), None).unwrap_err();
    assert_eq!(e.status, 409);
}

// reqforge: verifies REQ-0006#AC1
// reqforge: verifies REQ-0007#AC1
#[test]
fn search_and_bulk() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    f.store.create(Kind::Requirements, &rec(req_latency()), None).unwrap();
    assert_eq!(f.store.search(Kind::Requirements, "type:quality", &Map::new()).len(), 1);
    assert_eq!(f.store.search(Kind::Requirements, "password", &Map::new()).len(), 1);
    let res = f
        .store
        .bulk_update(Kind::Requirements, None, "status:approved", &Map::new(), &rec(json!({"status": "implemented"})), &rec(json!({"tags": "v1"})), &Map::new(), false, None)
        .unwrap();
    assert_eq!(res["changed"].as_array().unwrap().len(), 2);
    assert!(f.store.all(Kind::Requirements).iter().all(|r| r["tags"] == json!(["v1"])));
}

// reqforge: verifies REQ-0007#AC2
#[test]
fn bulk_is_all_or_nothing() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    f.store.create(Kind::Requirements, &rec(req_latency()), None).unwrap();
    let w = rec(json!({"status": "approved"}));
    assert!(f.store.bulk_update(Kind::Requirements, None, "", &w, &rec(json!({"category": "regulatory"})), &Map::new(), &Map::new(), false, None).is_err());
    assert_eq!(f.store.get(Kind::Requirements, "REQ-0001").unwrap()["category"], json!("authentication"));
}

// reqforge: verifies REQ-0003#AC2
#[test]
fn delete_refuses_when_referenced() {
    let f = fx();
    let (_, _, ep, _) = f.seed_plan(true);
    assert_eq!(f.store.delete(Kind::Epics, &ep, false).unwrap_err().status, 409);
}

// reqforge: verifies REQ-0008#AC1
#[test]
fn csv_roundtrip() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    let text = csvio::export(&f.store.all(Kind::Requirements), Kind::Requirements).replace("must", "could");
    f.store.upsert_many(Kind::Requirements, &csvio::parse(&text, Kind::Requirements).unwrap(), None).unwrap();
    let r = f.store.get(Kind::Requirements, "REQ-0001").unwrap();
    assert_eq!(r["priority"], json!("could"));
    assert_eq!(r["acceptance_criteria"].as_array().unwrap().len(), 2);
}

// ============================================================================ analysis

// reqforge: verifies REQ-0009#AC1
#[test]
fn lint_flags_overlap_vagueness_and_gaps() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    f.store.create(Kind::Requirements, &merge(req_login(), json!({"title": "Password login again"})), None).unwrap();
    f.store.create(Kind::Requirements, &merge(req_latency(), json!({"statement": "Login shall be fast.", "acceptance_criteria": []})), None).unwrap();
    let rep = lint::lint(&f.store);
    let rules: Vec<&str> = rep["findings"].as_array().unwrap().iter().map(|x| x["rule"].as_str().unwrap()).collect();
    for r in ["overlap", "ambiguity", "measurable", "coverage-gap"] {
        assert!(rules.contains(&r), "missing {r}");
    }
    assert_eq!(rep["ok"], json!(false));
}

// reqforge: verifies REQ-0009#AC2
#[test]
fn waivers_close_coverage_gaps() {
    let f = fx();
    f.store.save_config(&rec(json!({"coverage_waivers": {"constraint": "n/a", "interface": "n/a", "data": "n/a", "quality": "n/a"}}))).unwrap();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    assert_eq!(lint::lint(&f.store)["coverage"]["gaps"], json!([]));
}

// reqforge: verifies REQ-0010#AC1
#[test]
fn trace_passes_for_complete_plan() {
    let f = fx();
    f.seed_plan(true);
    let rep = trace::evaluate(&f.store);
    assert_eq!(rep["ok"], json!(true), "{}", rep["checks"]);
    assert_eq!(rep["metrics"]["criteria_coverage"], json!(1.0));
}

// reqforge: verifies REQ-0010#AC2
#[test]
fn trace_fails_without_evals() {
    let f = fx();
    f.seed_plan(false);
    let rep = trace::evaluate(&f.store);
    let failed: Vec<&str> = rep["checks"].as_array().unwrap().iter().filter(|c| c["passed"] == json!(false)).map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(rep["ok"], json!(false));
    for c in ["story-evals", "criteria-coverage", "quality-evals"] {
        assert!(failed.contains(&c), "{c}");
    }
}

// reqforge: verifies REQ-0011#AC1
#[test]
fn eval_runner_maps_failures_to_requirements() {
    let f = fx();
    let (r1, _, _, st) = f.seed_plan(true);
    let evs = json!([{"id": "E1", "name": "x", "kind": "unit", "command": "exit 3", "covers": [format!("{r1}#AC1")]}]);
    f.store.update(Kind::Stories, st["id"].as_str().unwrap(), &rec(json!({"evals": evs})), None, None).unwrap();
    let wd = TempDir::new().unwrap();
    let rep = evals::run(&f.store, "commit", wd.path(), None, None).unwrap();
    assert_eq!(rep["ok"], json!(false));
    assert!(rep["requirements_at_risk"].as_array().unwrap().contains(&json!(r1)));
    assert!(wd.path().join("reqforge-reports/evals-commit.json").exists());
}

// reqforge: verifies REQ-0012#AC1
// reqforge: verifies REQ-0044#AC1
#[test]
fn cicd_generation() {
    let f = fx();
    f.seed_plan(true);
    let code = TempDir::new().unwrap();
    let mut c = f.store.config_value()["cicd"].clone();
    c["requirements_repo"] = json!("acme/reqs");
    f.store.save_config(&rec(json!({"cicd": c}))).unwrap();
    let written = cicd::generate(&f.store, code.path(), "", true).unwrap();
    let wf = std::fs::read_to_string(&written[0]).unwrap();
    for job in ["traceability:", "commit:", "acceptance:", "security:", "performance:", "deploy:", "post-deploy:", "monitor:"] {
        assert!(wf.contains(job), "{job}");
    }
    assert!(wf.contains("repository: acme/reqs"));
    for stage in ["commit", "acceptance", "security", "performance", "post-deploy", "monitor"] {
        assert!(wf.contains(&format!("reqforge evals run --stage {stage}")), "{stage} job must read evals at run time");
    }
    assert!(wf.contains("cargo install --locked --no-default-features --path .reqforge/server reqforge"));
    assert!(code.path().join(".reqforge/server/src/main.rs").exists());
    assert!(!code.path().join(".reqforge/server/target").exists());
}

// ============================================================================ query

// reqforge: verifies REQ-0016#AC1
#[test]
fn page_sort_and_annotations() {
    let f = fx();
    let (r1, ..) = f.seed_plan(true);
    for i in 0..25 {
        f.store
            .create(Kind::Requirements, &merge(req_login(), json!({"title": format!("Extra {i:02}"), "statement": format!("The system shall do thing {i}."), "status": "draft"})), None)
            .unwrap();
    }
    let pg = query::page(&f.store, Kind::Requirements, "status:draft", &Map::new(), "title", "desc", 5, 10);
    assert_eq!((pg["total"].as_u64().unwrap(), pg["items"].as_array().unwrap().len()), (25, 10));
    assert_eq!(pg["items"][0]["title"], json!("Extra 19"));
    let first = &query::page(&f.store, Kind::Requirements, "", &Map::new(), "id", "asc", 0, 1)["items"][0];
    assert_eq!((first["id"].as_str().unwrap(), first["_stories"].as_u64().unwrap()), (r1.as_str(), 1));
}

// reqforge: verifies REQ-0017#AC1
#[test]
fn facets_and_tree() {
    let f = fx();
    f.seed_plan(true);
    let fc = query::facets(&f.store, Kind::Requirements, "", &rec(json!({"type": "quality"})));
    assert_eq!(fc["type"], json!({"functional": 1, "quality": 1}));
    assert_eq!(fc["status"], json!({"approved": 1}));
    let quality = fc["_tree"].as_array().unwrap().iter().find(|n| n["type"] == json!("quality")).unwrap();
    let perf = quality["categories"].as_array().unwrap().iter().find(|c| c["category"] == json!("performance-efficiency")).unwrap();
    assert_eq!((perf["count"].as_u64().unwrap(), perf["covered"].as_u64().unwrap()), (1, 1));
    assert_eq!(quality["categories"].as_array().unwrap().len(), 9);
}

// ============================================================================ changesets

// reqforge: verifies REQ-0013#AC1
#[test]
fn simulate_create_with_refs_and_remap() {
    let f = fx();
    let (_, _, _, st) = f.seed_plan(true);
    let mut evs = st["evals"].as_array().unwrap().clone();
    evs.push(json!({"id": "E9", "name": "mfa", "kind": "unit", "command": "true", "covers": ["$mfa#AC1"]}));
    let cs = json!({"title": "Add MFA", "ops": [
        {"op": "create", "kind": "requirements", "ref": "mfa", "data": {"title": "MFA", "type": "functional", "category": "authentication",
            "status": "proposed", "statement": "The system shall require a second factor for administrators.",
            "acceptance_criteria": [{"id": "AC1", "text": "admin login without OTP is refused"}]}},
        {"op": "update", "id": st["id"], "add": {"requirements": ["$mfa"]}, "patch": {"evals": evs}}]});
    let sim = changes::simulate(&f.store, &cs);
    assert_eq!(sim["valid"], json!(true), "{}", sim["errors"]);
    assert_eq!(sim["refmap"], json!({"mfa": "REQ-0003"}));
    assert_eq!(sim["trace"]["ok_after"], json!(true));
    assert!(sim["impact"]["stories"].as_array().unwrap().iter().any(|s| s["id"] == st["id"]));
    assert!(!f.store.exists(Kind::Requirements, "REQ-0003"));
}

// reqforge: verifies REQ-0013#AC2
#[test]
fn delete_without_remap_is_rejected() {
    let f = fx();
    let (_, r2, ep, st) = f.seed_plan(true);
    let sim = changes::simulate(&f.store, &json!({"ops": [{"op": "delete", "id": r2}]}));
    assert_eq!(sim["valid"], json!(false));
    assert!(sim["errors"].as_array().unwrap().iter().any(|e| e.as_str().unwrap().contains("dangling")));
    let keep: Vec<Value> = st["evals"].as_array().unwrap().iter().filter(|e| e["kind"] != json!("performance")).cloned().collect();
    let ok = changes::simulate(&f.store, &json!({"ops": [
        {"op": "update", "id": ep, "remove": {"requirements": [r2]}},
        {"op": "update", "id": st["id"], "remove": {"requirements": [r2]}, "patch": {"evals": keep}},
        {"op": "delete", "id": r2}]}));
    assert_eq!(ok["valid"], json!(true), "{}", ok["errors"]);
}

// reqforge: verifies REQ-0013#AC3
#[test]
fn mece_delta_flags_new_overlap() {
    let f = fx();
    f.seed_plan(true);
    let sim = changes::simulate(&f.store, &json!({"ops": [{"op": "create", "kind": "requirements", "data": merge(req_login(), json!({"title": "Password login duplicate"}))}]}));
    assert_eq!(sim["valid"], json!(true));
    assert_eq!(sim["lint"]["mece_ok"], json!(false));
    assert!(sim["lint"]["new"].as_array().unwrap().iter().any(|f| f["rule"] == json!("overlap")));
}

// reqforge: verifies REQ-0014#AC1
// reqforge: verifies REQ-0014#AC2
#[test]
fn propose_apply_and_stale() {
    let f = fx();
    let (r1, r2, ..) = f.seed_plan(true);
    let res = changes::propose(&f.store, &json!({"title": "Tighten latency", "ops": [
        {"op": "update", "id": r2, "patch": {"statement": "The system shall complete login within 200 ms at p95 under 200 rps."}}]})).unwrap();
    assert_eq!(res["changeset_id"], json!("CS-0001"));
    assert_eq!(f.store.get(Kind::Requirements, &r2).unwrap()["version"], json!(1));
    let out = changes::apply(&f.store, "CS-0001", &[]).unwrap();
    assert_eq!(out["status"], json!("applied"));
    assert!(f.store.get(Kind::Requirements, &r2).unwrap()["statement"].as_str().unwrap().contains("200 ms"));
    assert_eq!(changes::get(&f.store, "CS-0001").unwrap()["status"], json!("applied"));
    assert!(f.git_log().lines().next().unwrap().contains("CS-0001: apply"));
    changes::propose(&f.store, &json!({"title": "x", "ops": [{"op": "update", "id": r1, "patch": {"priority": "could"}}]})).unwrap();
    f.store.update(Kind::Requirements, &r1, &rec(json!({"priority": "should"})), None, None).unwrap();
    assert_eq!(changes::apply(&f.store, "CS-0002", &[]).unwrap_err().status, 409);
    assert_eq!(changes::get(&f.store, "CS-0002").unwrap()["status"], json!("stale"));
}

// ============================================================================ interfaces

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().unwrap()
}

fn start(store: Store) -> (tokio::runtime::Runtime, u16) {
    let rt = rt();
    let (addr, _) = rt.block_on(reqforge::api::serve(Arc::new(store), "127.0.0.1", 0)).unwrap();
    (rt, addr.port())
}

fn http(port: u16, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let url = format!("http://127.0.0.1:{port}{path}");
    let req = ureq::request(method, &url);
    let res = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match res {
        Ok(r) => {
            let code = r.status();
            (code, r.into_json().unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(code, r)) => (code, r.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("{e}"),
    }
}

fn raw_http(port: u16, req: &str) -> u16 {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok();
    buf.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0)
}

// reqforge: verifies REQ-0026#AC1
// reqforge: verifies REQ-0046#AC1
#[test]
fn rest_api() {
    let f = fx();
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    assert_eq!(http(port, "POST", "/api/requirements", Some(req_login())).0, 201);
    assert_eq!(http(port, "GET", "/api/requirements?q=password", None).1[0]["id"], json!("REQ-0001"));
    assert_eq!(http(port, "PATCH", "/api/requirements/REQ-0001", Some(json!({"priority": "could", "_version": 1}))).0, 200);
    assert_eq!(http(port, "PATCH", "/api/requirements/REQ-0001", Some(json!({"priority": "must", "_version": 1}))).0, 409);
    let (code, res) = http(port, "POST", "/api/requirements/bulk", Some(json!({"q": "status:approved", "add": {"tags": ["x"]}})));
    assert_eq!((code, res["changed"].clone()), (200, json!(["REQ-0001"])));
    assert!(http(port, "GET", "/api/trace", None).1.get("checks").is_some());
    assert!(http(port, "GET", "/api/meta", None).1["taxonomy"].get("quality").is_some());
    let pg = http(port, "GET", "/api/requirements?limit=1&sort=title", None).1;
    assert_eq!(pg["total"], json!(1));
    assert!(http(port, "GET", "/api/requirements/facets", None).1.get("_tree").is_some());
    assert_eq!(http(port, "GET", "/api/lint?rule=coverage-gap&limit=5", None).1["items"].as_array().unwrap().len(), 5);
    assert_eq!(http(port, "GET", "/api/context/REQ-0001", None).1["record"]["id"], json!("REQ-0001"));
    let csv = ureq::get(&format!("http://127.0.0.1:{port}/api/requirements/export.csv")).call().unwrap().into_string().unwrap();
    assert!(csv.starts_with("id,title,statement"));
    let page = ureq::get(&format!("http://127.0.0.1:{port}/")).call().unwrap();
    assert!(page.content_type().contains("html"));
    assert_eq!(http(port, "GET", "/api/nope", None).0, 404);
}

// reqforge: verifies REQ-0040#AC1
#[test]
fn security_guard() {
    let f = fx();
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    let body = req_login().to_string();
    let post = |ct: &str, extra: &str| {
        format!("POST /api/requirements HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len())
    };
    assert_eq!(raw_http(port, &post("text/plain", "")), 403);
    assert_eq!(raw_http(port, &post("application/json", "Origin: https://evil.example\r\n")), 403);
    assert_eq!(raw_http(port, "GET /api/requirements HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n"), 403);
    let chat = r#"{"message":"x"}"#;
    assert_eq!(
        raw_http(port, &format!("POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{chat}", chat.len())),
        403
    );
    assert_eq!(raw_http(port, &post("application/json", &format!("Origin: http://127.0.0.1:{port}\r\n"))), 201);
}

// reqforge: verifies REQ-0040#AC2
#[test]
fn token_protects_api_including_chat() {
    let f = fx();
    let store = Arc::new(Store::open(f.dir.path()).unwrap());
    let rt = rt();
    let port = rt.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = reqforge::api::router_with_token(store, "s3cret".into());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        port
    });
    assert_eq!(http(port, "GET", "/api/meta", None).0, 401);
    assert_eq!(http(port, "POST", "/api/chat", Some(json!({"message": "x"}))).0, 401);
    let ok = ureq::get(&format!("http://127.0.0.1:{port}/api/meta")).set("Authorization", "Bearer s3cret").call().unwrap();
    assert_eq!(ok.status(), 200);
}

// reqforge: verifies REQ-0040#AC3
#[test]
fn client_paths_validated() {
    let f = fx();
    let tmp = TempDir::new().unwrap();
    let code = tmp.path().join("code");
    let other = tmp.path().join("other");
    for d in [&code, &other] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("a.py"), "# reqforge: implements REQ-0001\ndef f(): pass\n").unwrap();
    }
    std::os::unix::fs::symlink(&other, tmp.path().join("evil")).unwrap();
    std::os::unix::fs::symlink(&code, tmp.path().join("alias")).unwrap();
    f.store.create(Kind::Components, &rec(json!({"title": "App", "key": "app", "path": code.display().to_string()})), None).unwrap();
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    let idx = f.dir.path().join("code/app.json");
    let scan = |root: &Path| http(port, "POST", "/api/code/scan", Some(json!({"components": ["app"], "root": root.display().to_string()})));
    // outside paths, symlinks escaping to them, traversal and missing paths: 400 and nothing scanned
    for bad in [other.clone(), tmp.path().join("evil"), code.join("../other"), tmp.path().join("missing"), "/etc".into()] {
        assert_eq!(scan(&bad).0, 400, "{}", bad.display());
        assert!(!idx.exists(), "{} was scanned", bad.display());
        let q = form_urlencoded::byte_serialize(bad.display().to_string().as_bytes()).collect::<String>();
        assert_eq!(http(port, "GET", &format!("/api/impact?component=app&root={q}"), None).0, 400, "{}", bad.display());
    }
    // the configured path, also via a symlink that resolves to it
    let (code_, res) = scan(&tmp.path().join("alias"));
    assert_eq!((code_, res["scanned"][0]["files_scanned"].clone()), (200, json!(1)));

    // project import: absolute directory containing reqforge.json only
    let wsd = TempDir::new().unwrap();
    let ws = Arc::new(reqforge::workspace::Workspace::open(wsd.path()).unwrap());
    let (_rt2, wport) = {
        let rt = rt();
        let (addr, _) = rt.block_on(reqforge::api::serve_workspace(ws, "127.0.0.1", 0)).unwrap();
        (rt, addr.port())
    };
    let import = |p: &str| http(wport, "POST", "/api/projects/import", Some(json!({"path": p}))).0;
    let repo = TempDir::new().unwrap();
    Store::init(repo.path(), "imp", "Imported", None, true).unwrap();
    std::os::unix::fs::symlink(&other, tmp.path().join("other-link")).unwrap();
    for bad in [other.display().to_string(), tmp.path().join("other-link").display().to_string(), "/etc".into(), "relative/dir".into(), repo.path().join("reqforge.json").display().to_string()] {
        assert_eq!(import(&bad), 400, "{bad}");
    }
    assert_eq!(import(&repo.path().display().to_string()), 201);
}

fn mcp_session(repo: &Path, msgs: &[Value]) -> Vec<Value> {
    let mut child = Command::new(BIN).arg("mcp").env("REQFORGE_REPO", repo).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let input: String = msgs.iter().map(|m| m.to_string() + "\n").collect();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

// reqforge: verifies REQ-0027#AC1
#[test]
fn mcp_protocol() {
    let f = fx();
    let out = mcp_session(
        f.dir.path(),
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "upsert_many", "arguments": {"kind": "requirements", "rows": [req_login(), req_latency()]}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "search", "arguments": {"kind": "requirements", "q": "type:quality"}}}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "create", "arguments": {"kind": "requirements", "data": {"title": "bad"}}}}),
            json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "simulate_changeset", "arguments": {"changeset": {"ops": [{"op": "update", "id": "REQ-0001", "patch": {"priority": "could"}}]}}}}),
            json!({"jsonrpc": "2.0", "id": 7, "method": "nope"}),
        ],
    );
    let ids: Vec<i64> = out.iter().map(|o| o["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![1, 2, 3, 4, 5, 6, 7]);
    assert_eq!(out[0]["result"]["protocolVersion"], json!("2025-06-18"));
    assert!(out[1]["result"]["tools"].as_array().unwrap().len() >= 22);
    let text = |i: usize| serde_json::from_str::<Value>(out[i]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text(2)["created"], json!(["REQ-0001", "REQ-0002"]));
    assert_eq!(text(3)[0]["id"], json!("REQ-0002"));
    assert_eq!(out[4]["result"]["isError"], json!(true));
    assert_eq!(text(5)["valid"], json!(true));
    assert_eq!(out[6]["error"]["code"], json!(-32601));
}

// reqforge: verifies REQ-0028#AC1
#[test]
fn cli() {
    let f = fx();
    let run = |args: &[&str]| Command::new(BIN).args(args).env("REQFORGE_REPO", f.dir.path()).output().unwrap();
    let r = run(&["add", "req", "--data", &req_login().to_string()]);
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert!(String::from_utf8_lossy(&run(&["list", "req", "-q", "status:approved"]).stdout).contains("REQ-0001"));
    assert!(run(&["bulk", "req", "-q", "type:functional", "--add", "tags=auth"]).status.success());
    assert_eq!(run(&["bulk", "req", "-s", "status=draft"]).status.code(), Some(2));
    assert_eq!(run(&["trace", "--gate"]).status.code(), Some(1));
    let cfg = run(&["config", "--set", r#"components={"web":"../web"}"#]);
    assert!(String::from_utf8_lossy(&cfg.stdout).contains("\"web\""));
    assert!(String::from_utf8_lossy(&run(&["taxonomy"]).stdout).contains("4. quality"));
}

// reqforge: verifies REQ-0029#AC1
#[test]
fn console() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    let mut out = vec![];
    {
        let mut c = Console::new(&f.store, &mut out);
        c.onecmd("ls req status:approved");
        c.onecmd("bulk req _ -- priority=could +tags=ui");
        c.onecmd("set REQ-0001 status=implemented");
    }
    let r = f.store.get(Kind::Requirements, "REQ-0001").unwrap();
    assert_eq!((r["priority"].clone(), r["status"].clone(), r["tags"].clone()), (json!("could"), json!("implemented"), json!(["ui"])));
}

const FAKE_CLAUDE: &str = r#"#!/bin/sh
prompt=$(cat)
last=$(printf '%s\n' "$prompt" | tail -n 1)
resume=False
for a in "$@"; do [ "$a" = "--resume" ] && resume=True; done
echo '{"type":"system","subtype":"init","session_id":"sess-1","mcp_servers":[{"name":"plugin:reqforge:reqforge","status":"connected"}]}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__plugin_reqforge_reqforge__propose_changeset","input":{"changeset":{"title":"demo","ops":[1]}}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\"changeset_id\": \"CS-0007\"}"}]}]}}'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"echo:%s resume=%s"}]}}\n' "$last" "$resume"
echo '{"type":"result","subtype":"success","session_id":"sess-1","total_cost_usd":0.01,"num_turns":2,"is_error":false}'
"#;

// reqforge: verifies REQ-0015#AC1
// reqforge: verifies REQ-0047#AC1
#[test]
fn sse_chat_bridge() {
    let f = fx();
    let fake = f.dir.path().join("fake-claude");
    std::fs::write(&fake, FAKE_CLAUDE).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("REQFORGE_CLAUDE_BIN", &fake);
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    let body = json!({"chat_id": "c1", "message": "add MFA", "session_id": "sess-1", "context": {"view": {"type": "quality"}, "selected": ["REQ-0001"]}});
    let r = ureq::post(&format!("http://127.0.0.1:{port}/api/chat")).send_json(body).unwrap();
    assert_eq!(r.content_type(), "text/event-stream");
    let text = r.into_string().unwrap();
    let events: Vec<Value> = text.lines().filter_map(|l| l.strip_prefix("data: ")).map(|l| serde_json::from_str(l).unwrap()).collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, vec!["session", "tool", "changeset", "text", "done"]);
    assert_eq!(events[2]["id"], json!("CS-0007"));
    assert_eq!(events[3]["text"], json!("echo:add MFA resume=True"));
    assert!(events[1]["text"].as_str().unwrap().contains("propose changeset"));
}

// reqforge: verifies REQ-0041#AC1
#[test]
fn chat_tool_policy_excludes_writes() {
    let allowed = reqforge::chat::allowed();
    for w in ["__create", "__update", "__delete", "__bulk_update", "__upsert_many", "__apply_changeset"] {
        assert!(!allowed.iter().any(|t| t.ends_with(w)), "{w}");
    }
    let denied = reqforge::chat::denied();
    assert!(denied.contains(&"Bash".to_string()));
    assert!(denied.contains(&"mcp__plugin_reqforge_reqforge__apply_changeset".to_string()));
}

/// Run a chat-role MCP server pinned to the project at `repo` (as ChatRunner starts it).
fn chat_mcp_session(repo: &Path, key: &str, workspace: &Path, calls: &[(&str, Value)]) -> Vec<Value> {
    let runner = reqforge::chat::ChatRunner::new(repo.to_path_buf(), &json!({"key": key}));
    let mut msgs = vec![json!({"jsonrpc": "2.0", "id": 0, "method": "tools/list"})];
    for (i, (name, args)) in calls.iter().enumerate() {
        msgs.push(json!({"jsonrpc": "2.0", "id": i + 1, "method": "tools/call", "params": {"name": name, "arguments": args}}));
    }
    let mut child = Command::new(BIN)
        .arg("mcp")
        .envs(runner.mcp_env())
        .env("REQFORGE_WORKSPACE", workspace)
        .env_remove("REQFORGE_PROJECT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let input: String = msgs.iter().map(|m| m.to_string() + "\n").collect();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn tool_text(r: &Value) -> Value {
    serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

// reqforge: verifies REQ-0041#AC2
#[test]
fn chat_project_pinned_refuses_other_projects() {
    let d = TempDir::new().unwrap();
    let ws = reqforge::workspace::Workspace::open(d.path()).unwrap();
    ws.create("SHOP", "Shop", None, true).unwrap();
    ws.create("PAY", "Payments", None, true).unwrap();
    let shop = ws.store("SHOP").unwrap();
    let pay = ws.store("PAY").unwrap();
    shop.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    pay.create(Kind::Requirements, &rec(req_latency()), None).unwrap();
    let cs = json!({"title": "x", "ops": [{"op": "update", "id": "REQ-0001", "patch": {"priority": "could"}}]});
    let out = chat_mcp_session(
        &shop.root,
        "SHOP",
        d.path(),
        &[
            ("search", json!({"kind": "requirements", "project": "PAY"})),
            ("get", json!({"id": "REQ-0001", "project": "PAY"})),
            ("propose_changeset", json!({"changeset": cs, "project": "PAY"})),
            ("search", json!({"kind": "requirements"})),
            ("search", json!({"kind": "requirements", "project": "shop"})),
        ],
    );
    for i in 1..=3 {
        assert_eq!(out[i]["result"]["isError"], json!(true), "call {i} on PAY must be refused");
        assert!(tool_text(&out[i])["error"].as_str().unwrap().contains("pinned to project SHOP"));
    }
    assert!(changes::list(&pay, None).is_empty(), "nothing proposed in PAY");
    for i in [4, 5] {
        let rows = tool_text(&out[i]);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["title"], json!(req_login()["title"]), "reads come from SHOP");
    }
}

// reqforge: verifies REQ-0041#AC3
#[test]
fn mcp_chat_role_refuses_writes() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    let log_before = f.git_log();
    let before = f.store.get(Kind::Requirements, "REQ-0001").unwrap();
    let cs_id = changes::propose(&f.store, &json!({"title": "x", "ops": [{"op": "update", "id": "REQ-0001", "patch": {"priority": "could"}}]})).unwrap()["changeset_id"].as_str().unwrap().to_string();
    let after_propose = f.git_log();
    let key = f.store.config_value()["key"].as_str().unwrap().to_string();
    let calls: Vec<(&str, Value)> = vec![
        ("create", json!({"kind": "requirements", "data": req_latency()})),
        ("update", json!({"id": "REQ-0001", "patch": {"priority": "could"}})),
        ("delete", json!({"id": "REQ-0001", "force": true})),
        ("bulk_update", json!({"kind": "requirements", "set": {"priority": "could"}})),
        ("upsert_many", json!({"kind": "requirements", "rows": [req_latency()]})),
        ("apply_changeset", json!({"id": cs_id})),
        ("reject_changeset", json!({"id": cs_id})),
        ("config", json!({"patch": {"name": "pwned"}})),
        ("sync", json!({})),
        ("init_repo", json!({"path": f.dir.path().join("x").display().to_string(), "key": "X", "name": "x"})),
        ("scan_code", json!({})),
        ("ingest_evidence", json!({"paths": []})),
        ("create_project", json!({"key": "EVIL", "name": "evil"})),
    ];
    assert_eq!(calls.len(), reqforge::chat::WRITE_TOOLS.len(), "every deny-listed tool is exercised");
    let ws = TempDir::new().unwrap();
    let out = chat_mcp_session(f.dir.path(), &key, ws.path(), &calls);
    let listed: Vec<&str> = out[0]["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for (i, (name, _)) in calls.iter().enumerate() {
        assert!(!listed.contains(name), "{name} must not be listed");
        assert_eq!(out[i + 1]["result"]["isError"], json!(true), "{name} must be refused");
        assert!(tool_text(&out[i + 1])["error"].as_str().unwrap().contains("not available to the chat agent"), "{name}");
    }
    let s = Store::open(f.dir.path()).unwrap();
    assert_eq!(s.records(Kind::Requirements).len(), 1);
    assert_eq!(s.get(Kind::Requirements, "REQ-0001").unwrap(), before);
    assert_eq!(s.config_value()["name"], json!("Demo"));
    assert_eq!(changes::get(&s, &cs_id).unwrap()["status"], json!("pending"));
    assert_eq!(f.git_log(), after_propose);
    assert_ne!(log_before, after_propose);
    assert!(!f.dir.path().join("x").exists());
}

// ============================================================================ scale

// reqforge: verifies REQ-0039#AC1
#[test]
fn thousands_of_requirements() {
    let f = fx();
    let cats = ["security", "reliability", "performance-efficiency"];
    let rows: Vec<Rec> = (1..=3000)
        .map(|i| {
            let quality = i % 3 == 0;
            rec(json!({"id": format!("REQ-{i:04}"), "title": format!("Requirement {i}"), "status": "approved",
                "type": if quality { "quality" } else { "functional" },
                "category": if quality { cats[(i / 3) % 3] } else { ["checkout", "search", "orders"][i % 3] },
                "statement": format!("The system shall handle case {i} for area {} within {} ms.", i % 17, 100 + i % 50),
                "acceptance_criteria": [{"id": "AC1", "text": format!("check {i}")}]}))
        })
        .collect();
    let t0 = Instant::now();
    f.store.upsert_many(Kind::Requirements, &rows, None).unwrap();
    let load = t0.elapsed();
    let s = Store::open(f.dir.path()).unwrap();
    let t0 = Instant::now();
    s.all(Kind::Requirements);
    let cold = t0.elapsed();
    let t0 = Instant::now();
    let pg = query::page(&s, Kind::Requirements, "type:quality", &Map::new(), "title", "asc", 0, 100);
    let fc = query::facets(&s, Kind::Requirements, "", &rec(json!({"type": "quality"})));
    let warm = t0.elapsed();
    assert_eq!(pg["items"].as_array().unwrap().len(), 100);
    assert_eq!(fc["_tree"].as_array().unwrap().iter().map(|n| n["count"].as_u64().unwrap()).sum::<u64>(), 3000);
    assert!(warm.as_secs_f64() < 2.0, "page+facets {warm:?} (cold {cold:?}, load {load:?})");
    assert_eq!(s.records(Kind::Requirements).len(), 3000);
}

// reqforge: verifies REQ-0042#AC1
#[test]
fn crash_before_rename_keeps_previous_version() {
    let f = fx();
    f.store.create(Kind::Requirements, &rec(req_login()), None).unwrap();
    // simulate a crash mid-write: the temp file exists, the rename never happened
    std::fs::write(f.dir.path().join("requirements/REQ-0001.json.tmp"), "{\"id\": \"REQ-0001\", \"title\": \"half writ").unwrap();
    let s = Store::open(f.dir.path()).unwrap();
    assert_eq!(s.get(Kind::Requirements, "REQ-0001").unwrap()["version"], json!(1));
    assert_eq!(s.all(Kind::Requirements).len(), 1);
}

fn task(f: &Fx, title: &str, deps: Value) -> Result<Rec, reqforge::store::StoreError> {
    f.store.create(Kind::Tasks, &rec(json!({"title": title, "story": "STORY-0001", "kind": "code", "depends_on": deps})), None)
}

// reqforge: verifies REQ-0049#AC1
#[test]
fn task_depends_on_validates_ids() {
    let f = fx();
    f.seed_plan(true); // TASK-0001..0004
    let t = task(&f, "build on design", json!(["TASK-0001"])).unwrap();
    assert_eq!(t["depends_on"], json!(["TASK-0001"]));
    let e = task(&f, "bad", json!(["TASK-0099"])).unwrap_err();
    assert!(e.details.iter().any(|d| d.as_str().unwrap() == "depends_on: TASK-0099 does not exist"), "{:?}", e.details);
    // CSV round-trips the list
    let csv = reqforge::csvio::export(&f.store.all(Kind::Tasks), Kind::Tasks);
    assert!(csv.contains("TASK-0001"));
}

// reqforge: verifies REQ-0049#AC2
#[test]
fn task_depends_on_rejects_self_and_cycles() {
    let f = fx();
    f.seed_plan(true);
    let e = f.store.update(Kind::Tasks, "TASK-0001", &rec(json!({"depends_on": ["TASK-0001"]})), None, None).unwrap_err();
    assert!(e.details[0].as_str().unwrap().contains("cannot depend on itself"));
    f.store.update(Kind::Tasks, "TASK-0002", &rec(json!({"depends_on": ["TASK-0001"]})), None, None).unwrap();
    f.store.update(Kind::Tasks, "TASK-0003", &rec(json!({"depends_on": ["TASK-0002"]})), None, None).unwrap();
    let e = f.store.update(Kind::Tasks, "TASK-0001", &rec(json!({"depends_on": ["TASK-0003"]})), None, None).unwrap_err();
    assert_eq!(e.details[0], json!("depends_on: dependency cycle TASK-0001 -> TASK-0003 -> TASK-0002 -> TASK-0001"));
    // the simulator catches the same cycle in a changeset
    let sim = changes::simulate(&f.store, &json!({"ops": [{"op": "update", "id": "TASK-0001", "patch": {"depends_on": ["TASK-0003"]}}]}));
    assert_eq!(sim["valid"], json!(false));
    assert!(sim["errors"][0].as_str().unwrap().contains("dependency cycle"));
}

// reqforge: verifies REQ-0049#AC3
#[test]
fn task_depends_on_blocks_delete() {
    let f = fx();
    f.seed_plan(true);
    f.store.update(Kind::Tasks, "TASK-0002", &rec(json!({"depends_on": ["TASK-0001"]})), None, None).unwrap();
    let e = f.store.delete(Kind::Tasks, "TASK-0001", false).unwrap_err();
    assert_eq!(e.status, 409);
    assert!(e.message.contains("TASK-0002"));
    f.store.delete(Kind::Tasks, "TASK-0001", true).unwrap();
}

// reqforge: verifies REQ-0050#AC2
// reqforge: verifies REQ-0050#AC3
#[test]
fn task_start_cascades_in_one_commit() {
    let f = fx();
    f.seed_plan(true);
    let before = f.git_log().lines().count();
    let r = reqforge::taskflow::start(&f.store, "TASK-0001", Some(1)).unwrap();
    assert_eq!(r["changed"], json!(["TASK-0001", "STORY-0001", "EPIC-0001"]));
    assert_eq!(f.git_log().lines().count(), before + 1, "one commit");
    assert!(f.git_log().lines().next().unwrap().starts_with("TASK-0001: start"));
    for (k, id) in [(Kind::Tasks, "TASK-0001"), (Kind::Stories, "STORY-0001"), (Kind::Epics, "EPIC-0001")] {
        assert_eq!(f.store.get(k, id).unwrap()["status"], json!("in-progress"), "{id}");
    }
    // a second task leaves the already in-progress / blocked parents alone
    f.store.update(Kind::Epics, "EPIC-0001", &rec(json!({"status": "blocked"})), None, None).unwrap();
    let r = reqforge::taskflow::start(&f.store, "TASK-0002", None).unwrap();
    assert_eq!(r["changed"], json!(["TASK-0002"]));
    assert_eq!(f.store.get(Kind::Epics, "EPIC-0001").unwrap()["status"], json!("blocked"));
}

// reqforge: verifies REQ-0050#AC4
// reqforge: verifies REQ-0050#AC5
#[test]
fn task_start_refuses_stale_and_blocked() {
    let f = fx();
    f.seed_plan(true);
    f.store.update(Kind::Tasks, "TASK-0002", &rec(json!({"depends_on": ["TASK-0001"]})), None, None).unwrap(); // v2
    assert_eq!(reqforge::taskflow::start(&f.store, "TASK-0002", Some(1)).unwrap_err().status, 409); // stale
    let e = reqforge::taskflow::start(&f.store, "TASK-0002", Some(2)).unwrap_err();
    assert_eq!(e.status, 409);
    assert!(e.message.contains("blocked by unfinished dependencies: TASK-0001"));
    assert_eq!(f.store.get(Kind::Tasks, "TASK-0002").unwrap()["status"], json!("todo"));
    let rd = reqforge::taskflow::readiness(&f.store, "TASK-0002").unwrap();
    assert_eq!(rd["can_start"], json!(false));
    assert_eq!(rd["unfinished"][0]["id"], json!("TASK-0001"));
    f.store.update(Kind::Tasks, "TASK-0001", &rec(json!({"status": "done"})), None, None).unwrap();
    assert_eq!(reqforge::taskflow::readiness(&f.store, "TASK-0002").unwrap()["can_start"], json!(true));
    reqforge::taskflow::start(&f.store, "TASK-0002", None).unwrap();
    assert_eq!(reqforge::taskflow::start(&f.store, "TASK-0002", None).unwrap_err().status, 409); // no longer todo
}

// ============================================================================ design documents

fn write_design(f: &Fx, slug: &str, body: &str) {
    let d = f.dir.path().join("design");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(format!("{slug}.md")), body).unwrap();
}

fn get_text(port: u16, path: &str) -> (u16, String) {
    match ureq::get(&format!("http://127.0.0.1:{port}{path}")).call() {
        Ok(r) => (r.status(), r.into_string().unwrap()),
        Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap_or_default()),
        Err(e) => panic!("{e}"),
    }
}

// reqforge: verifies REQ-0054#AC1
#[test]
fn design_docs_front_matter_and_list() {
    let f = fx();
    write_design(&f, "login-flow", "---\ntitle: \"Login flow\"\nrealises: [REQ-0001, REQ-0002]\n---\n# Login\n");
    write_design(&f, "audit", "---\ntitle: Audit trail\nrealises:\n  - REQ-0003\n  - 'REQ-0004'\n---\n\nbody\n");
    write_design(&f, "Bad_Name", "---\ntitle: skipped\nrealises: []\n---\n");
    std::fs::write(f.dir.path().join("design/notes.txt"), "not markdown").unwrap();
    let docs = reqforge::design::list(f.dir.path());
    let got: Vec<(&str, &str, Vec<&str>)> = docs.iter().map(|d| (d.slug.as_str(), d.title.as_str(), d.realises.iter().map(String::as_str).collect())).collect();
    assert_eq!(got, vec![("audit", "Audit trail", vec!["REQ-0003", "REQ-0004"]), ("login-flow", "Login flow", vec!["REQ-0001", "REQ-0002"])]);
    assert!(reqforge::design::valid_slug("a") && reqforge::design::valid_slug(&format!("a{}", "-".repeat(63))));
    for bad in ["", "-a", "A", "a_b", "a.b", "../x", &"a".repeat(65)] {
        assert!(!reqforge::design::valid_slug(bad), "{bad}");
    }
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    let (code, list) = http(port, "GET", "/api/design", None);
    assert_eq!(code, 200);
    assert_eq!(list, json!([{"slug": "audit", "title": "Audit trail", "realises": ["REQ-0003", "REQ-0004"]},
                            {"slug": "login-flow", "title": "Login flow", "realises": ["REQ-0001", "REQ-0002"]}]));
}

// reqforge: verifies REQ-0054#AC2
#[test]
fn design_docs_lint_unknown_realises() {
    let f = fx();
    let (r1, _, _, _) = f.seed_plan(true);
    let before = changes::lint_memo(&f.store);
    assert!(!before["findings"].as_array().unwrap().iter().any(|x| x["rule"] == json!("design-realises")));
    write_design(&f, "login-flow", &format!("---\ntitle: Login flow\nrealises: [{r1}, REQ-9999, STORY-0001]\n---\n"));
    let rep = changes::lint_memo(&f.store);
    let hits: Vec<&Value> = rep["findings"].as_array().unwrap().iter().filter(|x| x["rule"] == json!("design-realises")).collect();
    assert_eq!(hits.len(), 2, "{hits:?}");
    for (h, id) in hits.iter().zip(["REQ-9999", "STORY-0001"]) {
        assert_eq!(h["severity"], json!("error"));
        assert_eq!(h["ids"], json!([id]));
        assert_eq!(h["file"], json!("design/login-flow.md"));
        let m = h["message"].as_str().unwrap();
        assert!(m.contains("design/login-flow.md") && m.contains(id), "{m}");
    }
    assert_eq!(rep["ok"], json!(false));
    assert!(lint::to_markdown(&rep).contains("design/login-flow.md realises REQ-9999"));
    // a changeset simulation sees the same design docs, so no spurious lint delta
    let sim = changes::simulate(&f.store, &json!({"ops": []}));
    assert!(!sim.to_string().contains("design-realises"), "{sim}");
}

// reqforge: verifies REQ-0054#AC3
#[test]
fn design_docs_served_read_only_by_slug() {
    let f = fx();
    let md = "---\ntitle: Login flow\nrealises: [REQ-0001]\n---\n# Login\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    write_design(&f, "login-flow", md);
    std::fs::write(f.dir.path().join("secret.md"), "TOP SECRET").unwrap();
    std::os::unix::fs::symlink(f.dir.path().join("secret.md"), f.dir.path().join("design/leak.md")).unwrap();
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    let ok = ureq::get(&format!("http://127.0.0.1:{port}/api/design/login-flow")).call().unwrap();
    assert!(ok.content_type().contains("markdown"));
    assert_eq!(ok.into_string().unwrap(), md);
    for bad in ["Login-Flow", "-x", "a_b", "..%2Fsecret", "..%2F..%2Fetc%2Fpasswd", "secret.md", &"a".repeat(65)] {
        let (code, body) = get_text(port, &format!("/api/design/{bad}"));
        assert_eq!(code, 400, "{bad}");
        assert!(!body.contains("TOP SECRET"));
    }
    assert_eq!(raw_http(port, "GET /api/design/..%2Fsecret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"), 400);
    assert_eq!(get_text(port, "/api/design/missing").0, 404);
    // a symlink inside design/ pointing outside it is not followed
    let (code, body) = get_text(port, "/api/design/leak");
    assert_eq!(code, 404);
    assert!(!body.contains("TOP SECRET"));
    // read-only: no write routes
    assert!(http(port, "PUT", "/api/design/login-flow", Some(json!({}))).0 >= 400);
    assert_eq!(std::fs::read_to_string(f.dir.path().join("design/login-flow.md")).unwrap(), md);
}

// reqforge: verifies REQ-0054#AC1
#[test]
fn design_docs_in_record_context() {
    let f = fx();
    let (r1, r2, _, _) = f.seed_plan(true);
    write_design(&f, "login-flow", &format!("---\ntitle: Login flow\nrealises: [{r1}]\n---\n"));
    write_design(&f, "auth", &format!("---\ntitle: Auth\nrealises:\n  - {r1}\n  - {r2}\n---\n"));
    let c1 = changes::context(&f.store, &r1).unwrap();
    assert_eq!(c1["design"], json!([{"slug": "auth", "title": "Auth"}, {"slug": "login-flow", "title": "Login flow"}]));
    assert_eq!(changes::context(&f.store, &r2).unwrap()["design"], json!([{"slug": "auth", "title": "Auth"}]));
    let (_rt, port) = start(Store::open(f.dir.path()).unwrap());
    assert_eq!(http(port, "GET", &format!("/api/context/{r2}"), None).1["design"][0]["slug"], json!("auth"));
}
