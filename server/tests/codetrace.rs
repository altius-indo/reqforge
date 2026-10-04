use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use reqforge::codetrace::{ids_in, is_test_file, scan, tags_in};
use reqforge::evidence::{ingest, IngestOpts};
use reqforge::model::{Kind, Rec};
use reqforge::store::Store;
use reqforge::{cicd, impact, query, verify};
use serde_json::{json, Map, Value};
use tempfile::TempDir;

fn rec(v: Value) -> Rec {
    v.as_object().unwrap().clone()
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

// reqforge:off  (fixtures: sample code that carries tags as data)
const CHECKOUT_PY: &str = "\
import stripe

# reqforge: implements REQ-0001
def place_order(cart, card):
    return stripe.charge(cart.total, card)
";
const TEST_CHECKOUT_PY: &str = "\
import pytest
from shop.checkout import place_order

@pytest.mark.req(\"REQ-0001#AC1\")
def test_place_order():
    assert place_order(cart(), card())

def test_declined():  # REQ-0001#AC2
    with pytest.raises(Declined):
        place_order(cart(), bad_card())
";
const CART_TEST_TS: &str = "\
import { cart } from './cart';

describe('cart', () => {
  test('[REQ-0002#AC1] shows the total', () => {
    expect(cart().total).toBe(10);
  });
});
";
const LIB_RS: &str = "\
// reqforge: verifies REQ-0099
fn helper() {}
";
const NOTES_MD: &str = "We discussed REQ-0001 in planning; this mention is not a tag.\n";
// reqforge:on

struct Fx {
    _d: TempDir,
    code: std::path::PathBuf,
    store: Store,
}

fn fx() -> Fx {
    let d = TempDir::new().unwrap();
    let code = d.path().join("shop-code");
    for (p, c) in [
        ("shop/checkout.py", CHECKOUT_PY),
        ("tests/test_checkout.py", TEST_CHECKOUT_PY),
        ("web/cart.test.ts", CART_TEST_TS),
        ("src/lib.rs", LIB_RS),
        ("docs/notes.md", NOTES_MD),
        ("node_modules/x/test_x.py", "# REQ-0001 should be ignored\n"),
    ] {
        let f = code.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    }
    git(&code, &["init", "-q", "-b", "main"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(&code, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
    let store = Store::init(d.path().join("reqs"), "SHOP", "Shop", None, true).unwrap();
    let r = |t: &str, acs: &[&str]| {
        rec(json!({"title": t, "type": "functional", "category": "checkout", "status": "approved", "statement": format!("The system shall {t}."),
                   "acceptance_criteria": acs.iter().map(|a| json!({"id": a, "text": format!("{t} {a}")})).collect::<Vec<_>>()}))
    };
    store.create(Kind::Requirements, &r("place orders", &["AC1", "AC2"]), None).unwrap();
    store.create(Kind::Requirements, &r("show cart totals", &["AC1"]), None).unwrap();
    store.create(Kind::Requirements, &r("export receipts", &["AC1"]), None).unwrap();
    store
        .create(Kind::Components, &rec(json!({"title": "Shop", "key": "shop", "path": code.display().to_string(), "language": "python"})), None)
        .unwrap();
    Fx { _d: d, code, store }
}

fn status(store: &Store, target: &str) -> String {
    let (req, ac) = target.split_once('#').unwrap();
    verify::report(store)["requirements"][req]["acs"][ac]["status"].as_str().unwrap().to_string()
}

// ------------------------------------------------------------------ tags

// reqforge: verifies REQ-0021#AC1
#[test]
fn tag_grammar_and_symbols() {
    assert!(is_test_file("tests/test_checkout.py") && is_test_file("web/cart.test.ts") && is_test_file("src/FooTest.java"));
    assert!(!is_test_file("shop/checkout.py") && !is_test_file("docs/notes.md"));
    let t = tags_in("shop/checkout.py", CHECKOUT_PY, "shop");
    assert_eq!(t.len(), 1);
    assert_eq!((t[0].kind.as_str(), t[0].req.as_str(), t[0].symbol.as_deref(), t[0].line), ("implements", "REQ-0001", Some("place_order"), 3));
    let t = tags_in("tests/test_checkout.py", TEST_CHECKOUT_PY, "shop");
    let got: Vec<(String, Option<String>, Option<String>)> = t.iter().map(|x| (x.req.clone(), x.ac.clone(), x.symbol.clone())).collect();
    assert_eq!(
        got,
        vec![
            ("REQ-0001".into(), Some("AC1".into()), Some("test_place_order".into())),
            ("REQ-0001".into(), Some("AC2".into()), Some("test_declined".into()))
        ]
    );
    let t = tags_in("web/cart.test.ts", CART_TEST_TS, "web");
    assert_eq!(t[0].symbol.as_deref(), Some("[REQ-0002#AC1] shows the total"));
    assert!(tags_in("docs/notes.md", NOTES_MD, "x").is_empty(), "plain mentions in non-test files are not tags");
    assert_eq!(ids_in("[REQ-0002#AC1] and REQ-0003"), vec![("REQ-0002".into(), Some("AC1".into())), ("REQ-0003".into(), None)]);
}

// reqforge: verifies REQ-0021#AC2
#[test]
fn scan_writes_index_and_skips_vendor_dirs() {
    let f = fx();
    let out = scan(&f.store, &[], None, true).unwrap();
    assert_eq!(out["scanned"][0]["tags"], json!(5));
    assert_eq!(out["scanned"][0]["implements"], json!(1));
    let idx: Value = serde_json::from_str(&fs::read_to_string(f.store.root.join("code/shop.json")).unwrap()).unwrap();
    assert!(idx["commit"].as_str().unwrap().len() == 40);
    assert_eq!(idx["files"].as_object().unwrap().len(), 4);
    assert!(!idx.to_string().contains("node_modules"));
}

// reqforge: verifies REQ-0021#AC3
#[test]
fn requirements_repo_inside_component_is_not_scanned() {
    let d = TempDir::new().unwrap();
    let store = Store::init(d.path().join("reqs"), "X", "X", None, true).unwrap();
    store.create(Kind::Requirements, &rec(json!({"title": "a", "type": "functional", "category": "c", "statement": "The system shall a.", "acceptance_criteria": [{"id": "AC1", "text": "x"}]})), None).unwrap();
    // reqforge:off
    fs::write(d.path().join("app.py"), "# reqforge: implements REQ-0001\ndef a(): pass\n").unwrap();
    // reqforge:on
    store.create(Kind::Components, &rec(json!({"title": "Mono", "key": "mono", "path": ".."})), None).unwrap();
    scan(&store, &[], None, true).unwrap();
    let again = scan(&store, &[], None, true).unwrap(); // the stored index mentions tags; it must not be rescanned
    assert_eq!(again["scanned"][0]["tags"], json!(1));
}

// ------------------------------------------------------------------ verification lifecycle

const PYTEST_XML: &str = r#"<?xml version="1.0"?><testsuites><testsuite name="pytest">
<testcase classname="tests.test_checkout" name="test_place_order" time="0.01"/>
<testcase classname="tests.test_checkout" name="test_declined" time="0.01"><failure message="boom">trace</failure></testcase>
<testcase classname="tests.test_other" name="test_unrelated"/>
<testcase classname="tests.test_checkout" name="test_skipped"><skipped/></testcase>
</testsuite></testsuites>"#;
const JEST_XML: &str = r#"<testsuites><testsuite name="cart"><testcase classname="cart" name="cart [REQ-0002#AC1] shows the total" file="web/cart.test.ts"></testcase></testsuite></testsuites>"#;

// reqforge: verifies REQ-0022#AC1
// reqforge: verifies REQ-0038#AC1
#[test]
fn statuses_from_tags_evidence_and_changes() {
    let f = fx();
    scan(&f.store, &[], None, true).unwrap();
    let rep = verify::report(&f.store);
    assert_eq!(status(&f.store, "REQ-0001#AC1"), "pending");
    assert_eq!(status(&f.store, "REQ-0003#AC1"), "untested");
    assert_eq!(rep["requirements"]["REQ-0001"]["implemented"], json!(true));
    assert_eq!(rep["requirements"]["REQ-0001"]["implements"][0]["symbol"], json!("place_order"));
    let unknown = rep["checks"].as_array().unwrap().iter().find(|c| c["id"] == json!("tag-unknown")).unwrap();
    assert!(unknown["failures"][0].as_str().unwrap().contains("REQ-0099"));
    assert_eq!(rep["ok"], json!(false));

    let o = IngestOpts { component: Some("shop"), commit: Some("abc123"), run: Some("https://ci/run/1") };
    let r = ingest(&f.store, &[("pytest.xml".into(), PYTEST_XML.into()), ("jest.xml".into(), JEST_XML.into())], &o).unwrap();
    assert_eq!((r["cases"].clone(), r["matched"].clone(), r["skipped"].clone()), (json!(5), json!(3), json!(1)));
    assert_eq!(r["unmatched"], json!(["tests.test_other::test_unrelated"]));
    assert_eq!(status(&f.store, "REQ-0001#AC1"), "verified");
    assert_eq!(status(&f.store, "REQ-0001#AC2"), "failing");
    assert_eq!(status(&f.store, "REQ-0002#AC1"), "verified");
    let rep = verify::report(&f.store);
    assert_eq!(rep["requirements"]["REQ-0001"]["status"], json!("failing"));
    assert_eq!(rep["requirements"]["REQ-0001"]["acs"]["AC1"]["evidence"][0]["commit"], json!("abc123"));

    // fixing the failure turns it green
    let fixed = PYTEST_XML.replace(r#"<failure message="boom">trace</failure>"#, "");
    ingest(&f.store, &[("pytest.xml".into(), fixed)], &o).unwrap();
    assert_eq!(status(&f.store, "REQ-0001#AC2"), "verified");

    // changing implementing code after verification makes it suspect
    fs::write(f.code.join("shop/checkout.py"), CHECKOUT_PY.replace("cart.total", "cart.total * 2")).unwrap();
    scan(&f.store, &[], None, true).unwrap();
    assert_eq!(status(&f.store, "REQ-0001#AC1"), "suspect");
    let rep = verify::report(&f.store);
    let susp = rep["checks"].as_array().unwrap().iter().find(|c| c["id"] == json!("evidence-suspect")).unwrap();
    assert!(susp["failures"][0].as_str().unwrap().contains("shop:shop/checkout.py"));
    assert_eq!(status(&f.store, "REQ-0002#AC1"), "verified", "unrelated criteria stay verified");

    // eval reports count as evidence too (for criteria the eval's story still covers)
    f.store.create(Kind::Epics, &rec(json!({"title": "E"})), None).unwrap();
    f.store.create(Kind::Stories, &rec(json!({"title": "S", "epic": "EPIC-0001", "requirements": ["REQ-0003"],
        "evals": [{"id": "E1", "name": "receipts", "kind": "unit", "command": "true", "covers": ["REQ-0003#AC1"]}]})), None).unwrap();
    let eval_rep = json!({"stage": "commit", "results": [{"story": "STORY-0001", "id": "E1", "status": "passed", "covers": ["REQ-0003#AC1"]}]});
    ingest(&f.store, &[("evals-commit.json".into(), eval_rep.to_string())], &o).unwrap();
    assert_eq!(status(&f.store, "REQ-0003#AC1"), "verified");
    assert!(f.store.root.join("evidence/history.jsonl").exists());
}

// reqforge: verifies REQ-0023#AC1
#[test]
fn impact_of_a_change() {
    let f = fx();
    scan(&f.store, &[], None, true).unwrap();
    ingest(&f.store, &[("pytest.xml".into(), PYTEST_XML.replace(r#"<failure message="boom">trace</failure>"#, ""))], &IngestOpts { component: Some("shop"), commit: None, run: None }).unwrap();
    fs::write(f.code.join("shop/checkout.py"), CHECKOUT_PY.replace("card)", "card, idempotency_key)")).unwrap();
    fs::write(f.code.join("shop/new_module.py"), "def untraced(): pass\n").unwrap();
    let rep = impact::impact(&f.store, Some("shop"), None, Some("main")).unwrap();
    assert_eq!(rep["changed_files"], json!(["shop/checkout.py", "shop/new_module.py"]));
    assert_eq!(rep["requirements"][0]["id"], json!("REQ-0001"));
    assert_eq!(rep["tests"][0]["file"], json!("tests/test_checkout.py"));
    assert_eq!(rep["tests"][0]["symbols"], json!(["test_declined", "test_place_order"]));
    assert_eq!(rep["criteria_at_risk"], json!(["REQ-0001#AC1", "REQ-0001#AC2"]));
    assert_eq!(rep["untraced_changes"], json!(["shop/new_module.py"]));
    let md = impact::to_markdown(&rep);
    assert!(md.contains("1 requirements touched") && md.contains("Must re-verify"));
}

// ------------------------------------------------------------------ components, queries, API, CI

// reqforge: verifies REQ-0024#AC1
#[test]
fn component_keys_validated_and_unique() {
    let f = fx();
    let bad = f.store.create(Kind::Components, &rec(json!({"title": "Bad", "key": "Bad Key"})), None).unwrap_err();
    assert!(bad.details[0].as_str().unwrap().starts_with("key:"));
    let dup = f.store.create(Kind::Components, &rec(json!({"title": "Dup", "key": "shop"})), None).unwrap_err();
    assert!(dup.details[0].as_str().unwrap().contains("already used"));
    f.store.create(Kind::Epics, &rec(json!({"title": "E"})), None).unwrap();
    f.store.create(Kind::Stories, &rec(json!({"title": "S", "epic": "EPIC-0001", "requirements": ["REQ-0001"], "component": "nope"})), None).unwrap();
    let rep = verify::report(&f.store);
    let c = rep["checks"].as_array().unwrap().iter().find(|c| c["id"] == json!("story-components")).unwrap();
    assert_eq!(c["failures"], json!(["STORY-0001 references unknown component 'nope'"]));
}

// reqforge: verifies REQ-0025#AC1
#[test]
fn list_annotations_filters_and_facets() {
    let f = fx();
    scan(&f.store, &[], None, true).unwrap();
    ingest(&f.store, &[("jest.xml".into(), JEST_XML.into())], &IngestOpts { component: Some("shop"), commit: None, run: None }).unwrap();
    let pg = query::page(&f.store, Kind::Requirements, "", &Map::new(), "id", "asc", 0, 10);
    let v: Vec<&str> = pg["items"].as_array().unwrap().iter().map(|r| r["_verification"].as_str().unwrap()).collect();
    assert_eq!(v, vec!["pending", "verified", "untested"]);
    let only = query::page(&f.store, Kind::Requirements, "verification:untested|pending", &Map::new(), "id", "asc", 0, 10);
    assert_eq!(only["total"], json!(2));
    let fc = query::facets(&f.store, Kind::Requirements, "", &rec(json!({"verification": "verified"})));
    assert_eq!(fc["_verification"]["pending"], json!(1)); // own filter ignored
    let ctx = reqforge::changes::context(&f.store, "REQ-0002").unwrap();
    assert_eq!(ctx["code"]["acs"]["AC1"]["tests"][0]["file"], json!("web/cart.test.ts"));
}

// reqforge: verifies REQ-0026#AC2
#[test]
fn http_routes() {
    let f = fx();
    let root = f.store.root.clone();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let port = rt.block_on(async { reqforge::api::serve(Arc::new(Store::open(&root).unwrap()), "127.0.0.1", 0).await.unwrap().0.port() });
    let base = format!("http://127.0.0.1:{port}/api");
    let post = |p: &str, b: Value| ureq::post(&format!("{base}{p}")).send_json(b).unwrap().into_json::<Value>().unwrap();
    let get = |p: &str| ureq::get(&format!("{base}{p}")).call().unwrap().into_json::<Value>().unwrap();
    assert_eq!(post("/code/scan", json!({}))["scanned"][0]["tags"], json!(5));
    assert_eq!(get("/code")["indexes"][0]["component"], json!("shop"));
    assert_eq!(get("/code/shop")["tags"].as_array().unwrap().len(), 5);
    let ing = post("/evidence", json!({"files": [{"name": "j.xml", "content": JEST_XML}], "component": "shop", "commit": "c1"}));
    assert_eq!(ing["passed"], json!(1));
    assert_eq!(get("/verification")["statuses"]["REQ-0002"], json!("verified"));
    assert_eq!(get("/verification?req=REQ-0002")["acs"]["AC1"]["evidence"][0]["commit"], json!("c1"));
    assert_eq!(get("/evidence?target=REQ-0002").as_array().unwrap().len(), 1);
    fs::write(f.code.join("web/cart.test.ts"), CART_TEST_TS.replace("10", "11")).unwrap();
    assert_eq!(get("/impact?component=shop&base=main")["requirements"][0]["id"], json!("REQ-0002"));
}

// reqforge: verifies REQ-0028#AC3
#[test]
fn cli_scan_verify_impact() {
    let f = fx();
    let bin = env!("CARGO_BIN_EXE_reqforge");
    let run = |args: &[&str]| Command::new(bin).arg("--repo").arg(&f.store.root).args(args).output().unwrap();
    assert!(run(&["scan"]).status.success());
    let xml = f.code.join("junit.xml");
    fs::write(&xml, PYTEST_XML).unwrap();
    let ing = run(&["evidence", "ingest", xml.to_str().unwrap(), "-c", "shop", "--commit", "deadbeef"]);
    assert!(ing.status.success(), "{}", String::from_utf8_lossy(&ing.stderr));
    let v = run(&["verify", "--md", "--gate"]);
    assert_eq!(v.status.code(), Some(1)); // failing evidence + unknown tag
    let md = String::from_utf8_lossy(&v.stdout);
    assert!(md.contains("No criterion has failing evidence") && md.contains("REQ-0001#AC2 failing"));
    assert_eq!(run(&["verify", "--static", "--gate"]).status.code(), Some(1)); // REQ-0099 tag is still unknown
    fs::write(f.code.join("shop/checkout.py"), CHECKOUT_PY.replace("charge", "charge_v2")).unwrap();
    let sel = run(&["impact", "-c", "shop", "--base", "main", "--select-tests"]);
    assert_eq!(String::from_utf8_lossy(&sel.stdout).trim(), "tests/test_checkout.py");
}

// reqforge: verifies REQ-0012#AC2
#[test]
fn cicd_includes_impact_and_verification() {
    let f = fx();
    let code = TempDir::new().unwrap();
    let mut c = f.store.config_value()["cicd"].clone();
    c["requirements_repo"] = json!("acme/reqs");
    c["junit"] = json!(["reports/junit/*.xml"]);
    c["publish_evidence"] = json!(true);
    f.store.save_config(&rec(json!({"cicd": c}))).unwrap();
    let wf = fs::read_to_string(&cicd::generate_for(&f.store, code.path(), "", false, Some("shop")).unwrap()[0]).unwrap();
    for needle in [
        "impact:", "reqforge impact --component shop --root . --base origin/${{ github.base_ref }} --md", "gh pr comment",
        "verification:", "reqforge scan --component shop --root .", "reqforge evidence ingest", "reqforge verify --md --gate",
        "reqforge verify --static --md --gate", "needs: [acceptance, security, performance, verification]", "reports/junit/*.xml",
        "reqforge sync -m", "fetch-depth: 0",
    ] {
        assert!(wf.contains(needle), "missing {needle}");
    }
    assert!(cicd::generate_for(&f.store, code.path(), "", false, Some("nope")).is_err());
}

// reqforge: verifies REQ-0041#AC1
#[test]
fn chat_can_read_verification_but_not_write_evidence() {
    let allowed = reqforge::chat::allowed();
    assert!(allowed.iter().any(|t| t.ends_with("__verification")) && allowed.iter().any(|t| t.ends_with("__impact")));
    assert!(!allowed.iter().any(|t| t.ends_with("__scan_code") || t.ends_with("__ingest_evidence")));
    let names: Vec<String> = reqforge::mcp::tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    for t in ["verification", "impact", "scan_code", "ingest_evidence"] {
        assert!(names.contains(&t.to_string()), "{t}");
    }
}

// reqforge: verifies REQ-0021#AC4
#[test]
fn explicit_mode_regions_and_ignore_file() {
    use reqforge::codetrace::tags_in_mode;
    // reqforge:off
    let test_src = "fn fixture() { let id = \"REQ-0001\"; }\n// reqforge: verifies REQ-0002#AC1\nfn real_test() {}\n";
    // reqforge:on
    assert_eq!(tags_in_mode("tests/a.rs", test_src, "c", false).len(), 2); // auto: bare id counts in test files
    let explicit = tags_in_mode("tests/a.rs", test_src, "c", true);
    assert_eq!(explicit.len(), 1);
    assert_eq!((explicit[0].req.as_str(), explicit[0].symbol.as_deref()), ("REQ-0002", Some("real_test")));
    // reqforge:off
    let region = "// reqforge:off\nconst X: &str = \"# reqforge: implements REQ-0009\";\n// reqforge:on\n// reqforge: implements REQ-0003\nfn f() {}\n";
    // reqforge:on
    let t = tags_in_mode("src/x.rs", region, "c", true);
    assert_eq!(t.iter().map(|t| t.req.as_str()).collect::<Vec<_>>(), vec!["REQ-0003"]);
    // reqforge:off
    assert!(tags_in_mode("src/y.rs", "// reqforge:ignore-file\n// reqforge: implements REQ-0004\n", "c", false).is_empty());
    // reqforge:on
}

// reqforge: verifies REQ-0022#AC2
#[test]
fn cargo_test_output_is_evidence() {
    let f = fx();
    // reqforge:off
    fs::write(f.code.join("tests/it.rs"), "// reqforge: verifies REQ-0003#AC1\n#[test]\nfn exports_receipts() {}\n").unwrap();
    // reqforge:on
    scan(&f.store, &[], None, true).unwrap();
    let log = "running 2 tests\ntest exports_receipts ... ok\ntest unrelated::thing ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed\n";
    let r = ingest(&f.store, &[("cargo-test.log".into(), log.into())], &IngestOpts { component: Some("shop"), commit: None, run: None }).unwrap();
    assert_eq!((r["cases"].clone(), r["matched"].clone()), (json!(2), json!(1)));
    assert_eq!(status(&f.store, "REQ-0003#AC1"), "verified");
}

// reqforge: verifies REQ-0035#AC1
#[test]
fn commits_are_scoped_to_the_requirements_folder() {
    let d = TempDir::new().unwrap();
    let code = d.path();
    git(code, &["init", "-q", "-b", "main"]);
    fs::write(code.join("app.rs"), "fn main() {}\n").unwrap();
    git(code, &["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
    git(code, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "app"]);
    fs::write(code.join("app.rs"), "fn main() { work_in_progress(); }\n").unwrap(); // unrelated WIP
    fs::write(code.join("staged.rs"), "// staged but not ours\n").unwrap();
    git(code, &["add", "staged.rs"]);
    let store = Store::init(code.join("requirements"), "SELF", "Self", None, true).unwrap();
    store.create(Kind::Requirements, &rec(json!({"title": "x", "type": "functional", "category": "c", "statement": "The system shall x."})), None).unwrap();
    let show = Command::new("git").arg("-C").arg(code).args(["show", "--name-only", "--format=%s", "HEAD"]).output().unwrap();
    let out = String::from_utf8_lossy(&show.stdout);
    assert!(out.contains("REQ-0001: create") && out.contains("requirements/requirements/REQ-0001.json"), "{out}");
    assert!(!out.contains("app.rs") && !out.contains("staged.rs"), "unrelated files were committed: {out}");
    let status = Command::new("git").arg("-C").arg(code).args(["status", "--porcelain"]).output().unwrap();
    let st = String::from_utf8_lossy(&status.stdout);
    assert!(st.contains(" M app.rs") && st.contains("A  staged.rs"), "{st}");
}

// reqforge: verifies REQ-0022#AC1
#[test]
fn evidence_from_sources_that_stop_claiming_is_ignored() {
    let f = fx();
    scan(&f.store, &[], None, true).unwrap();
    let o = IngestOpts { component: Some("shop"), commit: None, run: None };
    // an eval claims REQ-0003#AC1 and passes
    f.store.create(Kind::Epics, &rec(json!({"title": "E"})), None).unwrap();
    f.store.create(Kind::Stories, &rec(json!({"title": "S", "epic": "EPIC-0001", "requirements": ["REQ-0003"],
        "evals": [{"id": "E1", "name": "receipts", "kind": "unit", "command": "true", "covers": ["REQ-0003#AC1"]}]})), None).unwrap();
    let rep = json!({"stage": "commit", "results": [{"story": "STORY-0001", "id": "E1", "status": "passed", "covers": ["REQ-0003#AC1"]}]});
    ingest(&f.store, &[("evals.json".into(), rep.to_string())], &o).unwrap();
    assert_eq!(status(&f.store, "REQ-0003#AC1"), "verified");
    // the eval no longer covers it: its old evidence stops counting
    f.store.update(Kind::Stories, "STORY-0001", &rec(json!({"evals": [{"id": "E1", "name": "receipts", "kind": "unit", "command": "true", "covers": []}]})), None, None).unwrap();
    assert_eq!(status(&f.store, "REQ-0003#AC1"), "untested");
    // same for a test whose tag is removed
    ingest(&f.store, &[("pytest.xml".into(), PYTEST_XML.into())], &o).unwrap();
    assert_eq!(status(&f.store, "REQ-0001#AC1"), "verified");
    fs::write(f.code.join("tests/test_checkout.py"), TEST_CHECKOUT_PY.replace("@pytest.mark.req(\"REQ-0001#AC1\")\n", "")).unwrap();
    scan(&f.store, &[], None, true).unwrap();
    assert_ne!(status(&f.store, "REQ-0001#AC1"), "verified");
}

// reqforge: verifies REQ-0022#AC1
#[test]
fn a_fresh_pass_supersedes_stale_evidence() {
    let f = fx();
    scan(&f.store, &[], None, true).unwrap();
    let o = IngestOpts { component: Some("shop"), commit: None, run: None };
    let jest = |sfx: &str| JEST_XML.replace("cart [REQ-0002#AC1] shows the total", &format!("cart [REQ-0002#AC1] shows the total{sfx}"));
    ingest(&f.store, &[("a.xml".into(), jest(""))], &o).unwrap();
    fs::write(f.code.join("web/cart.test.ts"), CART_TEST_TS.replace("10", "12")).unwrap();
    scan(&f.store, &[], None, true).unwrap();
    assert_eq!(status(&f.store, "REQ-0002#AC1"), "suspect");
    // a re-run from a differently named source passes against the current file
    ingest(&f.store, &[("b.xml".into(), jest(" (rerun)"))], &o).unwrap();
    assert_eq!(status(&f.store, "REQ-0002#AC1"), "verified");
}

// reqforge: verifies REQ-0021#AC2
#[test]
fn hidden_directories_are_scanned_but_vendored_copies_are_not() {
    let f = fx();
    for (rel, text) in [(".github/workflows/ci.yml", "# reqforge: implements REQ-0003\n"), (".reqforge/server/src/x.rs", "// reqforge: implements REQ-0003\n")] {
        let p = f.code.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        // reqforge:off
        fs::write(p, text).unwrap();
        // reqforge:on
    }
    scan(&f.store, &[], None, true).unwrap();
    let idx: Value = serde_json::from_str(&fs::read_to_string(f.store.root.join("code/shop.json")).unwrap()).unwrap();
    let files: Vec<&str> = idx["files"].as_object().unwrap().keys().map(String::as_str).collect();
    assert!(files.contains(&".github/workflows/ci.yml"), "{files:?}");
    assert!(!files.iter().any(|f| f.starts_with(".reqforge/")), "{files:?}");
}
