//! Decision records (DEC-NNNN): storage through changesets only, validation, availability in
//! search/CSV/context/MCP, trace tags, exercised status from evidence, and the lint.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use reqforge::codetrace::{scan, tags_in};
use reqforge::evidence::{ingest, IngestOpts};
use reqforge::model::{Kind, Rec};
use reqforge::store::{Source, Store};
use reqforge::{changes, csvio, decisions, lint, verify};
use serde_json::{json, Value};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_reqforge");

fn rec(v: Value) -> Rec {
    v.as_object().unwrap().clone()
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

struct Fx {
    dir: TempDir,
    store: Store,
}

fn fx() -> Fx {
    let dir = TempDir::new().unwrap();
    let store = Store::init(dir.path().join("reqs"), "DEMO", "Demo", None, true).unwrap();
    store
        .create(
            Kind::Requirements,
            &rec(json!({"title": "Place orders", "type": "functional", "category": "checkout", "status": "approved",
                        "statement": "The system shall place orders.", "acceptance_criteria": [{"id": "AC1", "text": "order placed"}]})),
            None,
        )
        .unwrap();
    Fx { dir, store }
}

fn dec(extra: Value) -> Value {
    let mut d = json!({"title": "Use Postgres", "context": "We need a relational store.", "decision": "Postgres 16 for all services.", "requirements": ["REQ-0001"]});
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    d
}

/// Propose and apply a changeset; returns the apply result.
fn apply(store: &Store, ops: Value) -> Value {
    let p = changes::propose(store, &json!({"title": "decisions", "ops": ops})).unwrap();
    assert_eq!(p["valid"], json!(true), "{p}");
    changes::apply(store, p["changeset_id"].as_str().unwrap(), &[]).unwrap()
}

fn sim_errors(store: &Store, ops: Value) -> Vec<String> {
    changes::simulate(store, &json!({"ops": ops}))["errors"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string()).collect()
}

// ------------------------------------------------------------------ REQ-0060

// reqforge: verifies REQ-0060#AC1
#[test]
fn required_fields_and_status_default() {
    let f = fx();
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": {"title": "x"}}]));
    assert!(errs.iter().any(|e| e.contains("DEC-0001: context: required")), "{errs:?}");
    assert!(errs.iter().any(|e| e.contains("DEC-0001: decision: required")), "{errs:?}");
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": {"context": "c", "decision": "d"}}]));
    assert!(errs.iter().any(|e| e.contains("title: required")), "{errs:?}");
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"status": "done"}))}]));
    assert!(errs.iter().any(|e| e.contains("status: 'done' not in ['proposed', 'accepted', 'superseded']")), "{errs:?}");

    apply(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({}))}]));
    let d = f.store.get(Kind::Decisions, "DEC-0001").unwrap();
    assert_eq!(d["status"], json!("proposed"));
    assert!(d.get("accepted_at").map(|v| v.is_null() || v == "").unwrap_or(true));
    assert!(f.store.root.join("decisions/DEC-0001.json").exists());

    // accepting stamps accepted_at
    apply(&f.store, json!([{"op": "update", "id": "DEC-0001", "patch": {"status": "accepted"}}]));
    let d = f.store.get(Kind::Decisions, "DEC-0001").unwrap();
    assert_eq!(d["status"], json!("accepted"));
    assert!(!d["accepted_at"].as_str().unwrap().is_empty());
}

// reqforge: verifies REQ-0060#AC2
#[test]
fn requirement_links_and_supersession_rules() {
    let f = fx();
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"requirements": ["REQ-0099"]}))}]));
    assert!(errs.iter().any(|e| e.contains("requirements: REQ-0099 does not exist")), "{errs:?}");
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"status": "superseded"}))}]));
    assert!(errs.iter().any(|e| e.contains("superseded_by: required when status is superseded")), "{errs:?}");
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"status": "superseded", "superseded_by": "DEC-0042"}))}]));
    assert!(errs.iter().any(|e| e.contains("superseded_by: DEC-0042 does not exist")), "{errs:?}");
    let errs = sim_errors(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"status": "superseded", "superseded_by": "DEC-0001"}))}]));
    assert!(errs.iter().any(|e| e.contains("cannot supersede itself")), "{errs:?}");

    apply(
        &f.store,
        json!([
            {"op": "create", "kind": "decisions", "ref": "old", "data": dec(json!({"status": "accepted"}))},
            {"op": "create", "kind": "decisions", "ref": "new", "data": dec(json!({"title": "Use Postgres 17", "status": "accepted"}))},
            {"op": "update", "id": "$old", "patch": {"status": "superseded", "superseded_by": "$new"}},
        ]),
    );
    assert_eq!(f.store.get(Kind::Decisions, "DEC-0001").unwrap()["superseded_by"], json!("DEC-0002"));
    // closing the loop is a supersession cycle
    let errs = sim_errors(&f.store, json!([{"op": "update", "id": "DEC-0002", "patch": {"status": "superseded", "superseded_by": "DEC-0001"}}]));
    assert!(errs.iter().any(|e| e.contains("supersession cycle DEC-0002 -> DEC-0001 -> DEC-0002")), "{errs:?}");
    // a linked requirement cannot be deleted from under the decision
    let errs = sim_errors(&f.store, json!([{"op": "delete", "id": "REQ-0001"}]));
    assert!(errs.iter().any(|e| e.contains("dangling reference DEC-0001.requirements -> REQ-0001")), "{errs:?}");
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

// reqforge: verifies REQ-0060#AC3
#[test]
fn decisions_in_search_csv_context_and_mcp_and_only_through_changesets() {
    let f = fx();
    apply(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({}))}]));

    // search, CSV export, record context (drawer)
    assert_eq!(f.store.search(Kind::Decisions, "postgres", &Default::default()).len(), 1);
    assert_eq!(reqforge::query::page(&f.store, Kind::Decisions, "status:proposed", &Default::default(), "id", "asc", 0, 10)["total"], json!(1));
    let csv = csvio::export(&f.store.all(Kind::Decisions), Kind::Decisions);
    assert!(csv.starts_with("id,title,context,decision,status,requirements,superseded_by"), "{csv}");
    assert!(csv.contains("DEC-0001,Use Postgres,We need a relational store.,Postgres 16 for all services.,proposed,REQ-0001"), "{csv}");
    let ctx = changes::context(&f.store, "DEC-0001").unwrap();
    assert_eq!(ctx["record"]["title"], json!("Use Postgres"));
    assert_eq!(ctx["exercised"]["exercised"], json!(false));
    assert!(changes::context(&f.store, "REQ-0001").unwrap()["referenced_by"].as_array().unwrap().contains(&json!("DEC-0001")));
    let meta = reqforge::api::meta(&f.store);
    assert_eq!(meta["kinds"]["decisions"], json!("DEC"));
    assert_eq!(meta["schemas"]["decisions"]["status"]["default"], json!("proposed"));
    assert_eq!(meta["schemas"]["decisions"]["superseded_by"]["kind"], json!("decisions"));
    let tools = reqforge::mcp::tools();
    let search = tools.iter().find(|t| t["name"] == json!("search")).unwrap();
    assert!(search["inputSchema"]["properties"]["kind"]["enum"].as_array().unwrap().contains(&json!("decisions")));

    // never written directly: create, update, bulk, upsert (CSV import) and delete are refused
    let data = rec(dec(json!({})));
    assert_eq!(f.store.create(Kind::Decisions, &data, None).unwrap_err().status, 403);
    assert_eq!(f.store.update(Kind::Decisions, "DEC-0001", &rec(json!({"title": "x"})), None, None).unwrap_err().status, 403);
    let e = f.store.bulk_update(Kind::Decisions, None, "", &Default::default(), &rec(json!({"status": "accepted"})), &Rec::new(), &Rec::new(), false, None).unwrap_err();
    assert_eq!(e.status, 403);
    assert!(e.message.contains("only through changesets"));
    assert_eq!(f.store.upsert_many(Kind::Decisions, &[data], None).unwrap_err().status, 403);
    assert_eq!(f.store.delete(Kind::Decisions, "DEC-0001", true).unwrap_err().status, 403);
    assert_eq!(f.store.get(Kind::Decisions, "DEC-0001").unwrap()["version"], json!(1));

    // MCP: the chat agent reads decisions and can only propose them
    let key = f.store.config_value()["key"].as_str().unwrap().to_string();
    let ws = TempDir::new().unwrap();
    let out = chat_mcp_session(
        &f.store.root,
        &key,
        ws.path(),
        &[
            ("search", json!({"kind": "decisions", "q": "postgres"})),
            ("get", json!({"id": "DEC-0001"})),
            ("context", json!({"id": "DEC-0001"})),
            ("verification", json!({"req": "DEC-0001"})),
            ("create", json!({"kind": "decisions", "data": dec(json!({}))})),
            ("propose_changeset", json!({"changeset": {"title": "accept", "ops": [{"op": "update", "id": "DEC-0001", "patch": {"status": "accepted"}}]}})),
        ],
    );
    assert_eq!(tool_text(&out[1])[0]["id"], json!("DEC-0001"));
    assert_eq!(tool_text(&out[2])["decision"], json!("Postgres 16 for all services."));
    assert_eq!(tool_text(&out[3])["record"]["id"], json!("DEC-0001"));
    assert_eq!(tool_text(&out[4])["exercised"], json!(false));
    assert_eq!(out[5]["result"]["isError"], json!(true));
    assert!(tool_text(&out[5])["error"].as_str().unwrap().contains("not available to the chat agent"));
    assert_eq!(tool_text(&out[6])["valid"], json!(true), "{}", out[6]);
    let s = Store::open(&f.store.root).unwrap();
    assert_eq!(s.records(Kind::Decisions).len(), 1);
    assert_eq!(s.get(Kind::Decisions, "DEC-0001").unwrap()["status"], json!("proposed"), "a proposal writes nothing");
    assert_eq!(changes::list(&s, Some("pending")).len(), 1);
}

// ------------------------------------------------------------------ REQ-0061

// reqforge:off  (fixtures: sample code that carries decision tags as data)
const STORE_PY: &str = "\
# reqforge: implements DEC-0001
def connect():
    return psycopg.connect()
";
const TEST_STORE_PY: &str = "\
# reqforge: verifies DEC-0001
def test_connect():
    assert connect()

def test_pool():  # DEC-0001
    assert pool()

# reqforge: verifies DEC-0099
def test_unknown():
    pass
";
// reqforge:on

struct CodeFx {
    f: Fx,
    code: PathBuf,
}

fn code_fx() -> CodeFx {
    let f = fx();
    let code = f.dir.path().join("app");
    for (p, c) in [("app/store.py", STORE_PY), ("tests/test_store.py", TEST_STORE_PY)] {
        let file = code.join(p);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, c).unwrap();
    }
    git(&code, &["init", "-q", "-b", "main"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    f.store.create(Kind::Components, &rec(json!({"title": "App", "key": "app", "path": code.display().to_string()})), None).unwrap();
    apply(&f.store, json!([{"op": "create", "kind": "decisions", "data": dec(json!({"status": "accepted"}))}]));
    CodeFx { f, code }
}

fn junit(connect_ok: bool, pool_ok: bool) -> String {
    let case = |name: &str, ok: bool| {
        if ok {
            format!(r#"<testcase classname="tests.test_store" name="{name}" file="tests/test_store.py"/>"#)
        } else {
            format!(r#"<testcase classname="tests.test_store" name="{name}" file="tests/test_store.py"><failure message="x"/></testcase>"#)
        }
    };
    format!("<testsuites><testsuite>{}{}</testsuite></testsuites>", case("test_connect", connect_ok), case("test_pool", pool_ok))
}

fn exercised(store: &Store) -> Value {
    decisions::report(store)["decisions"]["DEC-0001"].clone()
}

// reqforge: verifies REQ-0061#AC1
#[test]
fn scan_records_decision_tags_like_requirement_tags() {
    let t = tags_in("app/store.py", STORE_PY, "app");
    assert_eq!(t.len(), 1);
    assert_eq!((t[0].kind.as_str(), t[0].req.as_str(), t[0].symbol.as_deref(), t[0].line), ("implements", "DEC-0001", Some("connect"), 1));
    let t = tags_in("tests/test_store.py", TEST_STORE_PY, "app");
    let got: Vec<(&str, &str, Option<&str>)> = t.iter().map(|x| (x.kind.as_str(), x.req.as_str(), x.symbol.as_deref())).collect();
    assert_eq!(
        got,
        vec![("verifies", "DEC-0001", Some("test_connect")), ("verifies", "DEC-0001", Some("test_pool")), ("verifies", "DEC-0099", Some("test_unknown"))]
    );
    // explicit mode honours only the comments, as for REQ ids
    let explicit = reqforge::codetrace::tags_in_mode("tests/test_store.py", TEST_STORE_PY, "app", true);
    assert_eq!(explicit.iter().filter(|x| x.symbol.as_deref() == Some("test_pool")).count(), 0);

    let c = code_fx();
    let out = scan(&c.f.store, &[], None, true).unwrap();
    assert_eq!((out["scanned"][0]["implements"].clone(), out["scanned"][0]["verifies"].clone()), (json!(1), json!(3)));
    let idx: Value = serde_json::from_str(&fs::read_to_string(c.f.store.root.join("code/app.json")).unwrap()).unwrap();
    assert!(idx["files"].as_object().unwrap().contains_key("app/store.py"));
    // tags of unknown decisions are broken links; known ones are not
    let rep = verify::report(&c.f.store);
    let unknown = rep["checks"].as_array().unwrap().iter().find(|ch| ch["id"] == json!("tag-unknown")).unwrap();
    let fails: Vec<&str> = unknown["failures"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(fails.len(), 1, "{fails:?}");
    assert!(fails[0].contains("tags unknown DEC-0099"));
}

// reqforge: verifies REQ-0061#AC2
#[test]
fn exercised_from_implementing_code_and_passing_tagged_tests() {
    let c = code_fx();
    let s = &c.f.store;
    assert_eq!(exercised(s)["exercised"], json!(false));
    assert!(exercised(s)["reason"].as_str().unwrap().contains("no code is tagged"));

    scan(s, &[], None, true).unwrap();
    let e = exercised(s);
    assert_eq!(e["exercised"], json!(false), "tagged tests have no evidence yet");
    assert_eq!(e["implements"][0]["file"], json!("app/store.py"));
    assert_eq!(e["implements"][0]["symbol"], json!("connect"));
    let tests: Vec<(&str, &str)> = e["tests"].as_array().unwrap().iter().map(|t| (t["symbol"].as_str().unwrap(), t["status"].as_str().unwrap())).collect();
    assert_eq!(tests, vec![("test_connect", "pending"), ("test_pool", "pending")]);

    let o = IngestOpts { component: Some("app"), commit: Some("abc"), run: None };
    ingest(s, &[("j.xml".into(), junit(true, false))], &o).unwrap();
    let e = exercised(s);
    assert_eq!(e["exercised"], json!(false), "a failing tagged test makes it no");
    assert_eq!(e["tests"][0]["status"], json!("passed"));
    assert_eq!(e["tests"][1]["status"], json!("failing"));

    ingest(s, &[("j.xml".into(), junit(true, true))], &o).unwrap();
    let e = exercised(s);
    assert_eq!(e["exercised"], json!(true), "{e}");
    assert_eq!(e["reason"], json!(""));
    assert_eq!(reqforge::query::page(s, Kind::Decisions, "", &Default::default(), "id", "asc", 0, 10)["items"][0]["_exercised"], json!(true));
    assert_eq!(changes::context(s, "DEC-0001").unwrap()["exercised"]["exercised"], json!(true));

    // implementing code changed after the tests passed: suspect, so no longer exercised
    fs::write(c.code.join("app/store.py"), STORE_PY.replace("connect()\n", "connect(pool=True)\n")).unwrap();
    scan(s, &[], None, true).unwrap();
    let e = exercised(s);
    assert_eq!(e["exercised"], json!(false));
    assert_eq!(e["tests"][0]["status"], json!("suspect"));
}

fn unexercised_ids(rep: &Value) -> Vec<String> {
    rep["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["rule"] == json!("decision-unexercised"))
        .map(|f| {
            assert_eq!(f["severity"], json!("warning"));
            f["ids"][0].as_str().unwrap().to_string()
        })
        .collect()
}

// reqforge: verifies REQ-0061#AC3
#[test]
fn lint_warns_for_accepted_decisions_unexercised_after_14_days() {
    let c = code_fx(); // DEC-0001 accepted now, tagged in code
    let s = &c.f.store;
    let old = (chrono::Utc::now() - chrono::Duration::days(20)).format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    let recent = (chrono::Utc::now() - chrono::Duration::days(13)).format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    apply(
        s,
        json!([
            {"op": "update", "id": "DEC-0001", "patch": {"accepted_at": old}},
            {"op": "create", "kind": "decisions", "data": dec(json!({"title": "Old, unexercised", "status": "accepted", "accepted_at": old}))},
            {"op": "create", "kind": "decisions", "data": dec(json!({"title": "Recent", "status": "accepted", "accepted_at": recent}))},
            {"op": "create", "kind": "decisions", "data": dec(json!({"title": "Only proposed"}))},
        ]),
    );
    assert_eq!(s.get(Kind::Decisions, "DEC-0002").unwrap()["accepted_at"], json!(old), "an explicit accepted_at is kept");
    // DEC-0001 is tagged but its tests have no evidence: warned, like DEC-0002
    assert_eq!(unexercised_ids(&lint::lint(s)), vec!["DEC-0001", "DEC-0002"]);
    let f = lint::lint(s)["findings"].as_array().unwrap().iter().find(|f| f["ids"][0] == json!("DEC-0001")).unwrap().clone();
    assert!(f["message"].as_str().unwrap().contains("accepted 20 days ago"), "{f}");

    // once exercised, the warning clears
    scan(s, &[], None, true).unwrap();
    ingest(s, &[("j.xml".into(), junit(true, true))], &IngestOpts { component: Some("app"), commit: None, run: None }).unwrap();
    assert_eq!(unexercised_ids(&lint::lint(s)), vec!["DEC-0002"]);
    // the recent one is warned once its 14 days are up
    let later = chrono::Utc::now() + chrono::Duration::days(2);
    let ids: Vec<String> = decisions::lint_findings(s as &dyn Source, later).iter().map(|f| f["ids"][0].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec!["DEC-0002", "DEC-0003"]);
    // and changeset simulation reports the new warning in its lint delta
    let sim = changes::simulate(s, &json!({"ops": [{"op": "create", "kind": "decisions", "data": dec(json!({"status": "accepted", "accepted_at": old}))}]}));
    assert!(sim["lint"]["new"].as_array().unwrap().iter().any(|f| f["rule"] == json!("decision-unexercised") && f["ids"][0] == json!("DEC-0005")), "{}", sim["lint"]);
}

// reqforge: verifies REQ-0061#AC3
#[test]
fn monitor_counts_unexercised_and_overdue_decisions() {
    let c = code_fx(); // DEC-0001 accepted now, tagged in code, no evidence
    let s = &c.f.store;
    let old = (chrono::Utc::now() - chrono::Duration::days(20)).format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    apply(
        s,
        json!([
            {"op": "create", "kind": "decisions", "data": dec(json!({"title": "Old, unexercised", "status": "accepted", "accepted_at": old}))},
            {"op": "create", "kind": "decisions", "data": dec(json!({"title": "Only proposed"}))},
        ]),
    );
    let state = |s: &Store| verify::report(s)["summary"]["state"]["decisions"].clone();
    let d = state(s);
    assert_eq!((d["accepted"].clone(), d["unexercised"].clone(), d["overdue"].clone()), (json!(2), json!(2), json!(1)), "{d}");
    assert_eq!(d["overdue_ids"], json!(["DEC-0002"]));
    // overdue is exactly what lint warns about
    assert_eq!(unexercised_ids(&lint::lint(s)), vec!["DEC-0002"]);
    // exercising DEC-0001 drops it from the count
    scan(s, &[], None, true).unwrap();
    ingest(s, &[("j.xml".into(), junit(true, true))], &IngestOpts { component: Some("app"), commit: None, run: None }).unwrap();
    let d = state(s);
    assert_eq!((d["unexercised"].clone(), d["overdue"].clone()), (json!(1), json!(1)), "{d}");
    assert!(verify::to_markdown(&verify::report(s)).contains("decisions: 1 of 2 accepted unexercised, 1 past the 14-day grace period"));
}
