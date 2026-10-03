import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from reqforge import cicd, csvio, evals, lint, mcp_server, trace  # noqa: E402
from reqforge.api import serve  # noqa: E402
from reqforge.store import Store, StoreError  # noqa: E402

REQ_LOGIN = {
    "title": "Password login", "type": "functional", "category": "authentication", "priority": "must",
    "status": "approved", "statement": "The system shall authenticate users with email and password.",
    "rationale": "Baseline access control.",
    "acceptance_criteria": [{"id": "AC1", "text": "Valid credentials yield a session"},
                            {"id": "AC2", "text": "Invalid credentials are rejected with a generic error"}],
}
REQ_LATENCY = {
    "title": "Login latency", "type": "quality", "category": "performance-efficiency", "priority": "should",
    "status": "approved", "statement": "The system shall complete login within 300 ms at p95 under 200 rps.",
    "acceptance_criteria": [{"id": "AC1", "text": "p95 < 300 ms at 200 rps"}],
}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.pop("REQFORGE_REPO", None)
        self.store = Store.init(self.tmp.name, "demo", "Demo")

    def tearDown(self):
        self.tmp.cleanup()

    def seed_plan(self, with_evals=True):
        r1 = self.store.create("requirements", REQ_LOGIN)
        r2 = self.store.create("requirements", REQ_LATENCY)
        ep = self.store.create("epics", {"title": "Access", "requirements": [r1["id"], r2["id"]]})
        ev = [
            {"id": "E1", "name": "login unit", "kind": "unit", "command": "true", "covers": [f"{r1['id']}#AC1", f"{r1['id']}#AC2"]},
            {"id": "E2", "name": "login load", "kind": "performance", "command": "true", "covers": [f"{r2['id']}#AC1"]},
        ] if with_evals else []
        st = self.store.create("stories", {"title": "Log in", "epic": ep["id"], "requirements": [r1["id"], r2["id"]],
                                           "evals": ev})
        for k in ("design", "code", "deployment", "monitoring"):
            self.store.create("tasks", {"title": f"{k} login", "story": st["id"], "kind": k})
        return r1, r2, ep, st


class StoreTests(Base):
    def test_create_assigns_ids_and_commits(self):
        r = self.store.create("req", REQ_LOGIN)
        self.assertEqual(r["id"], "REQ-0001")
        self.assertEqual(r["version"], 1)
        log = subprocess.run(["git", "-C", self.tmp.name, "log", "--oneline"], capture_output=True, text=True).stdout
        self.assertIn("REQ-0001: create", log)

    def test_validation_rejects_bad_category_and_refs(self):
        with self.assertRaises(StoreError) as cm:
            self.store.create("req", {**REQ_LATENCY, "category": "speed"})
        self.assertIn("category", cm.exception.details[0])
        with self.assertRaises(StoreError):
            self.store.create("stories", {"title": "x", "epic": "EPIC-0099"})

    def test_optimistic_concurrency(self):
        r = self.store.create("req", REQ_LOGIN)
        self.store.update("req", r["id"], {"priority": "should"}, expected_version=1)
        with self.assertRaises(StoreError) as cm:
            self.store.update("req", r["id"], {"priority": "could"}, expected_version=1)
        self.assertEqual(cm.exception.status, 409)

    def test_search_and_bulk(self):
        self.store.create("req", REQ_LOGIN)
        self.store.create("req", REQ_LATENCY)
        self.assertEqual(len(self.store.search("req", "type:quality")), 1)
        self.assertEqual(len(self.store.search("req", "password")), 1)
        res = self.store.bulk_update("req", q="status:approved", set_={"status": "implemented"}, add={"tags": "v1"})
        self.assertEqual(len(res["changed"]), 2)
        self.assertTrue(all("v1" in r["tags"] for r in self.store.all("req")))

    def test_bulk_is_all_or_nothing(self):
        self.store.create("req", REQ_LOGIN)
        self.store.create("req", REQ_LATENCY)
        with self.assertRaises(StoreError):  # invalid for the quality requirement only
            self.store.bulk_update("req", q="", where={"status": "approved"}, set_={"category": "regulatory"})
        self.assertEqual(self.store.get("req", "REQ-0001")["category"], "authentication")

    def test_delete_refuses_when_referenced(self):
        _, _, ep, _ = self.seed_plan()
        with self.assertRaises(StoreError):
            self.store.delete("epics", ep["id"])

    def test_csv_roundtrip(self):
        self.store.create("req", REQ_LOGIN)
        text = csvio.export_csv(self.store.all("req"), "requirements").replace("must", "could")
        self.store.upsert_many("requirements", csvio.parse_csv(text, "requirements"))
        r = self.store.get("req", "REQ-0001")
        self.assertEqual(r["priority"], "could")
        self.assertEqual(len(r["acceptance_criteria"]), 2)


class AnalysisTests(Base):
    def test_lint_flags_overlap_vagueness_and_gaps(self):
        self.store.create("req", REQ_LOGIN)
        self.store.create("req", {**REQ_LOGIN, "title": "Password login again"})
        self.store.create("req", {**REQ_LATENCY, "statement": "Login shall be fast.", "acceptance_criteria": []})
        rep = lint.lint(self.store)
        rules = {f["rule"] for f in rep["findings"]}
        self.assertTrue({"overlap", "ambiguity", "measurable", "coverage-gap"} <= rules)
        self.assertFalse(rep["ok"])

    def test_waivers_close_coverage_gaps(self):
        self.store.save_config({"coverage_waivers": {"constraint": "n/a", "interface": "n/a", "data": "n/a", "quality": "n/a"}})
        self.store.create("req", REQ_LOGIN)
        self.assertEqual(lint.lint(self.store)["coverage"]["gaps"], [])

    def test_trace_passes_for_complete_plan(self):
        self.seed_plan()
        rep = trace.evaluate(self.store)
        self.assertTrue(rep["ok"], [c for c in rep["checks"] if not c["passed"]])
        self.assertEqual(rep["metrics"]["criteria_coverage"], 1.0)

    def test_trace_fails_without_evals(self):
        self.seed_plan(with_evals=False)
        rep = trace.evaluate(self.store)
        failed = {c["id"] for c in rep["checks"] if not c["passed"]}
        self.assertFalse(rep["ok"])
        self.assertTrue({"story-evals", "criteria-coverage", "quality-evals"} <= failed)

    def test_eval_runner_maps_failures_to_requirements(self):
        r1, *_ , st = self.seed_plan()
        self.store.update("stories", st["id"], {"evals": [{"id": "E1", "name": "x", "kind": "unit", "command": "exit 3",
                                                            "covers": [f"{r1['id']}#AC1"]}]})
        with tempfile.TemporaryDirectory() as wd:
            rep = evals.run(self.store, "commit", wd)
            self.assertFalse(rep["ok"])
            self.assertIn(r1["id"], rep["requirements_at_risk"])
            self.assertTrue((Path(wd) / "reqforge-reports" / "evals-commit.json").exists())

    def test_cicd_generation(self):
        self.seed_plan()
        with tempfile.TemporaryDirectory() as code:
            self.store.save_config({"cicd": {**self.store.config["cicd"], "requirements_repo": "acme/reqs"}})
            written = cicd.generate(self.store, code)
            wf = Path(written[0]).read_text()
            for job in ("traceability:", "commit:", "acceptance:", "security:", "performance:", "deploy:", "post-deploy:", "monitor:"):
                self.assertIn(job, wf)
            self.assertIn("repository: acme/reqs", wf)
            self.assertTrue((Path(code) / ".reqforge" / "reqforge" / "cli.py").exists())


class InterfaceTests(Base):
    def test_rest_api(self):
        srv = serve(self.store, "127.0.0.1", 0)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def req(method, path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                       headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r) as resp:
                    return resp.status, json.loads(resp.read() or b"null")
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        try:
            self.assertEqual(req("POST", "/api/requirements", REQ_LOGIN)[0], 201)
            self.assertEqual(req("GET", "/api/requirements?q=password")[1][0]["id"], "REQ-0001")
            self.assertEqual(req("PATCH", "/api/requirements/REQ-0001", {"priority": "could", "_version": 1})[0], 200)
            self.assertEqual(req("PATCH", "/api/requirements/REQ-0001", {"priority": "must", "_version": 1})[0], 409)
            code, res = req("POST", "/api/requirements/bulk", {"q": "status:approved", "add": {"tags": ["x"]}})
            self.assertEqual((code, res["changed"]), (200, ["REQ-0001"]))
            self.assertIn("checks", req("GET", "/api/trace")[1])
            self.assertIn("quality", req("GET", "/api/meta")[1]["taxonomy"])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as resp:
                self.assertIn(b"reqforge", resp.read())
        finally:
            srv.shutdown()

    def test_mcp_protocol(self):
        env = {**os.environ, "REQFORGE_REPO": self.tmp.name, "PYTHONPATH": str(ROOT)}
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "upsert_many", "arguments": {"kind": "requirements", "rows": [REQ_LOGIN, REQ_LATENCY]}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "search", "arguments": {"kind": "requirements", "q": "type:quality"}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "create", "arguments": {"kind": "requirements", "data": {"title": "bad"}}}},
        ]
        p = subprocess.run([sys.executable, "-m", "reqforge", "mcp"], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                           capture_output=True, text=True, env=env, timeout=30)
        out = [json.loads(l) for l in p.stdout.splitlines()]
        self.assertEqual([o["id"] for o in out], [1, 2, 3, 4, 5])
        self.assertEqual(out[0]["result"]["protocolVersion"], "2025-06-18")
        self.assertGreater(len(out[1]["result"]["tools"]), 10)
        self.assertEqual(json.loads(out[2]["result"]["content"][0]["text"])["created"], ["REQ-0001", "REQ-0002"])
        self.assertEqual(json.loads(out[3]["result"]["content"][0]["text"])[0]["id"], "REQ-0002")
        self.assertTrue(out[4]["result"]["isError"])

    def test_cli(self):
        env = {**os.environ, "REQFORGE_REPO": self.tmp.name, "PYTHONPATH": str(ROOT)}
        cli = [str(ROOT / "bin" / "reqforge")]
        run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
        r = run("add", "req", "--data", json.dumps(REQ_LOGIN))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("REQ-0001", run("list", "req", "-q", "status:approved").stdout)
        self.assertEqual(run("bulk", "req", "-q", "type:functional", "--add", "tags=auth").returncode, 0)
        self.assertEqual(run("bulk", "req", "-s", "status=draft").returncode, 2)  # refuses unselective bulk
        self.assertEqual(run("trace", "--gate").returncode, 1)  # approved requirement has no story

    def test_console(self):
        from reqforge.console import Console
        self.store.create("req", REQ_LOGIN)
        out = io.StringIO()
        c = Console(self.store)
        c.stdout = out
        sys_stdout, sys.stdout = sys.stdout, out
        try:
            c.onecmd("ls req status:approved")
            c.onecmd("bulk req _ -- priority=could +tags=ui")
            c.onecmd("set REQ-0001 status=implemented")
        finally:
            sys.stdout = sys_stdout
        r = self.store.get("req", "REQ-0001")
        self.assertEqual((r["priority"], r["status"], r["tags"]), ("could", "implemented", ["ui"]))


if __name__ == "__main__":
    unittest.main()
