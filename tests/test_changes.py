import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from reqforge import changes, query  # noqa: E402
from reqforge.api import serve  # noqa: E402
from reqforge.store import Store, StoreError  # noqa: E402
from tests.test_reqforge import REQ_LATENCY, REQ_LOGIN, Base  # noqa: E402


class QueryTests(Base):
    def test_page_sort_and_annotations(self):
        r1, r2, ep, st = self.seed_plan()
        for i in range(25):
            self.store.create("req", {**REQ_LOGIN, "title": f"Extra {i:02d}", "statement": f"The system shall do thing {i}.",
                                      "status": "draft"})
        pg = query.page(self.store, "requirements", "status:draft", None, "title", "desc", 5, 10)
        self.assertEqual((pg["total"], len(pg["items"])), (25, 10))
        self.assertEqual(pg["items"][0]["title"], "Extra 19")
        first = query.page(self.store, "requirements", "", None, "id", "asc", 0, 1)["items"][0]
        self.assertEqual((first["id"], first["_stories"]), (r1["id"], 1))

    def test_facets_and_tree(self):
        self.seed_plan()
        f = query.facets(self.store, "requirements", "", {"type": "quality"})
        self.assertEqual(f["type"], {"functional": 1, "quality": 1})  # own filter ignored
        self.assertEqual(f["status"], {"approved": 1})                 # other filters applied
        tree = {n["type"]: n for n in f["_tree"]}
        perf = next(c for c in tree["quality"]["categories"] if c["category"] == "performance-efficiency")
        self.assertEqual((perf["count"], perf["covered"]), (1, 1))
        self.assertEqual(len(tree["quality"]["categories"]), 9)


class ChangesetTests(Base):
    def test_simulate_create_with_refs_and_remap(self):
        r1, r2, ep, st = self.seed_plan()
        cs = {"title": "Add MFA", "ops": [
            {"op": "create", "kind": "requirements", "ref": "mfa", "data": {
                "title": "MFA", "type": "functional", "category": "authentication", "status": "proposed",
                "statement": "The system shall require a second factor for administrators.",
                "acceptance_criteria": [{"id": "AC1", "text": "admin login without OTP is refused"}]}},
            {"op": "update", "id": st["id"], "add": {"requirements": ["$mfa"]},
             "patch": {"evals": [*st["evals"], {"id": "E9", "name": "mfa", "kind": "unit", "command": "true", "covers": ["$mfa#AC1"]}]}},
        ]}
        sim = changes.simulate(self.store, cs)
        self.assertTrue(sim["valid"], sim["errors"])
        self.assertEqual(sim["refmap"], {"mfa": "REQ-0003"})
        self.assertTrue(sim["trace"]["ok_after"])
        self.assertIn(st["id"], [s["id"] for s in sim["impact"]["stories"]])
        self.assertFalse(self.store.exists("requirements", "REQ-0003"))  # nothing written

    def test_delete_without_remap_is_rejected(self):
        r1, r2, ep, st = self.seed_plan()
        sim = changes.simulate(self.store, {"ops": [{"op": "delete", "id": r2["id"]}]})
        self.assertFalse(sim["valid"])
        self.assertTrue(any("dangling" in e for e in sim["errors"]))
        ok = changes.simulate(self.store, {"ops": [
            {"op": "update", "id": ep["id"], "remove": {"requirements": [r2["id"]]}},
            {"op": "update", "id": st["id"], "remove": {"requirements": [r2["id"]]},
             "patch": {"evals": [e for e in st["evals"] if e["kind"] != "performance"]}},
            {"op": "delete", "id": r2["id"]}]})
        self.assertTrue(ok["valid"], ok["errors"])

    def test_mece_delta_flags_new_overlap(self):
        self.seed_plan()
        sim = changes.simulate(self.store, {"ops": [{"op": "create", "kind": "requirements", "data": {
            **REQ_LOGIN, "title": "Password login duplicate"}}]})
        self.assertTrue(sim["valid"])
        self.assertFalse(sim["lint"]["mece_ok"])
        self.assertIn("overlap", {f["rule"] for f in sim["lint"]["new"]})

    def test_propose_apply_and_stale(self):
        r1, r2, ep, st = self.seed_plan()
        res = changes.propose(self.store, {"title": "Tighten latency", "ops": [
            {"op": "update", "id": r2["id"], "patch": {"statement": "The system shall complete login within 200 ms at p95 under 200 rps."}}]})
        self.assertEqual(res["changeset_id"], "CS-0001")
        self.assertEqual(self.store.get("req", r2["id"])["version"], 1)
        out = changes.apply(self.store, "CS-0001")
        self.assertEqual(out["status"], "applied")
        self.assertIn("200 ms", self.store.get("req", r2["id"])["statement"])
        self.assertEqual(changes.get(self.store, "CS-0001")["status"], "applied")
        log = subprocess.run(["git", "-C", self.tmp.name, "log", "--format=%s", "-1"], capture_output=True, text=True).stdout
        self.assertIn("CS-0001: apply", log)
        # stale: record edited after the proposal
        changes.propose(self.store, {"title": "x", "ops": [{"op": "update", "id": r1["id"], "patch": {"priority": "could"}}]})
        self.store.update("req", r1["id"], {"priority": "should"})
        with self.assertRaises(StoreError) as cm:
            changes.apply(self.store, "CS-0002")
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(changes.get(self.store, "CS-0002")["status"], "stale")


FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, sys
prompt = sys.stdin.read()
def out(o): print(json.dumps(o), flush=True)
out({"type": "system", "subtype": "init", "session_id": "sess-1", "mcp_servers": [{"name": "plugin:reqforge:reqforge", "status": "connected"}]})
out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "mcp__plugin_reqforge_reqforge__propose_changeset", "input": {"changeset": {"title": "demo", "ops": [1]}}}]}})
out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": json.dumps({"changeset_id": "CS-0007"})}]}]}})
out({"type": "assistant", "message": {"content": [{"type": "text", "text": "echo:" + prompt.splitlines()[-1] + " resume=" + str("--resume" in sys.argv)}]}})
out({"type": "result", "subtype": "success", "session_id": "sess-1", "total_cost_usd": 0.01, "num_turns": 2, "is_error": False})
'''


class ChatTests(Base):
    def test_sse_chat_bridge(self):
        fake = Path(self.tmp.name) / "fake-claude"
        fake.write_text(FAKE_CLAUDE)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        os.environ["REQFORGE_CLAUDE_BIN"] = str(fake)
        srv = serve(self.store, "127.0.0.1", 0)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            body = json.dumps({"chat_id": "c1", "message": "add MFA", "session_id": "sess-1",
                               "context": {"view": {"type": "quality"}, "selected": ["REQ-0001"]}}).encode()
            r = urllib.request.Request(f"http://127.0.0.1:{port}/api/chat", data=body, method="POST",
                                       headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(r) as resp:
                self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
                events = [json.loads(l[6:]) for l in resp.read().decode().splitlines() if l.startswith("data: ")]
            types = [e["type"] for e in events]
            self.assertEqual(types, ["session", "tool", "changeset", "text", "done"])
            self.assertEqual(events[2]["id"], "CS-0007")
            self.assertEqual(events[3]["text"], "echo:add MFA resume=True")
            self.assertIn("propose changeset", events[1]["text"])
        finally:
            srv.shutdown()
            os.environ.pop("REQFORGE_CLAUDE_BIN", None)

    def test_chat_tool_policy_excludes_writes(self):
        from reqforge.chat import ALLOWED, DENIED
        self.assertFalse(any(t.endswith(("__create", "__update", "__delete", "__bulk_update", "__upsert_many", "__apply_changeset")) for t in ALLOWED))
        self.assertIn("Bash", DENIED)
        self.assertIn("mcp__plugin_reqforge_reqforge__apply_changeset", DENIED)


class ScaleTests(unittest.TestCase):
    def test_thousands_of_requirements(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([sys.executable, str(ROOT / "examples" / "seed_large.py"), d, "3000"], check=True,
                           capture_output=True)
            s = Store(d)
            t0 = time.monotonic()
            s.all("requirements")
            cold = time.monotonic() - t0
            t0 = time.monotonic()
            pg = query.page(s, "requirements", "type:quality", None, "title", "asc", 0, 100)
            fc = query.facets(s, "requirements", "", {"type": "quality"})
            warm = time.monotonic() - t0
            self.assertEqual(len(pg["items"]), 100)
            self.assertGreater(sum(n["count"] for n in fc["_tree"]), 2900)
            self.assertLess(warm, 5.0, f"page+facets took {warm:.2f}s (cold load {cold:.2f}s)")


if __name__ == "__main__":
    unittest.main()


class SecurityTests(Base):
    def test_cross_origin_and_simple_requests_refused(self):
        import http.client
        srv = serve(self.store, "127.0.0.1", 0)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        def call(method, path, body=b"", headers=None):
            c = http.client.HTTPConnection("127.0.0.1", port)
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            r.read()
            return r.status
        try:
            req = json.dumps(REQ_LOGIN).encode()
            self.assertEqual(call("POST", "/api/requirements", req, {"Content-Type": "text/plain"}), 403)  # CSRF-able simple request
            self.assertEqual(call("POST", "/api/chat", b'{"message":"x"}', {"Content-Type": "text/plain"}), 403)
            self.assertEqual(call("POST", "/api/requirements", req, {"Content-Type": "application/json", "Origin": "https://evil.example"}), 403)
            self.assertEqual(call("GET", "/api/requirements", headers={"Host": "attacker.example:80"}), 403)  # DNS rebinding
            self.assertEqual(call("POST", "/api/requirements", req, {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}"}), 201)
        finally:
            srv.shutdown()
