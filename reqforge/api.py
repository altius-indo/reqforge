"""REST API + web UI host (stdlib http.server).

GET    /api/meta                         taxonomy, schemas, enums, config
GET    /api/{kind}?q=..&field=value      search (q accepts field:value tokens); add limit/offset/sort/order
                                         for a page: {total, offset, limit, items} with link counts
GET    /api/{kind}/facets?q=..           facet counts (+ requirement category tree with coverage/lint health)
GET    /api/context/{id}                 record + links, impact (stories/tasks/evals/components), lint findings
GET    /api/changesets?status=           list; GET /api/changesets/{id}; POST /api/changesets/simulate {ops..}
POST   /api/changesets                   propose; POST /api/changesets/{id}/apply {exclude}; /reject {reason}
GET    /api/chat/status                  is the local `claude` CLI available
POST   /api/chat {chat_id, message, session_id, context}   SSE stream of agent events
POST   /api/chat/cancel {chat_id}
POST   /api/{kind}                       create
GET    /api/{kind}/{id}                  read
PATCH  /api/{kind}/{id}                  update; send "_version" for optimistic concurrency
DELETE /api/{kind}/{id}?force=1          delete
POST   /api/{kind}/bulk                  {ids|q|where, set, add, remove, dry_run}
POST   /api/{kind}/import                {rows:[...]} or text/csv body — upsert by id
GET    /api/{kind}/export.csv            CSV export
GET    /api/lint | /api/trace | /api/evals?stage=
GET    /api/sessions | GET /api/sessions/{id} | POST /api/sessions {title, markdown}
POST   /api/sync                         commit + pull --rebase + push
PATCH  /api/config                       patch reqforge.json
Auth: if REQFORGE_TOKEN is set, /api/* requires `Authorization: Bearer <token>`.
"""
from __future__ import annotations

import hmac
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import changes, csvio, evals, lint, query, trace
from .chat import ChatRunner
from .model import EVAL_KINDS, KINDS, PRIORITIES, REQ_STATUSES, SCHEMAS, STAGES, STORY_DELIVERABLES, TASK_KINDS, TAXONOMY, WORK_STATUSES, normalize_kind
from .store import Store, StoreError

UI = Path(__file__).resolve().parent / "ui" / "index.html"


def meta(store: Store) -> dict:
    return {
        "config": store.config,
        "kinds": {k: v["prefix"] for k, v in KINDS.items()},
        "taxonomy": TAXONOMY,
        "schemas": {k: {f: {"type": t, **o} for f, (t, o) in s.items()} for k, s in SCHEMAS.items()},
        "enums": {"priority": PRIORITIES, "req_status": REQ_STATUSES, "work_status": WORK_STATUSES,
                  "deliverable": STORY_DELIVERABLES, "task_kind": TASK_KINDS, "eval_kind": list(EVAL_KINDS),
                  "stage": STAGES},
    }


def make_handler(store: Store):
    token = os.environ.get("REQFORGE_TOKEN", "")
    runner = ChatRunner(store)

    class Handler(BaseHTTPRequestHandler):
        server_version = "reqforge"

        def log_message(self, fmt, *args):  # quieter default logging
            if os.environ.get("REQFORGE_LOG"):
                super().log_message(fmt, *args)

        # ------------------------------------------------------------ plumbing
        def _send(self, status: int, body, ctype="application/json"):
            data = body if isinstance(body, (bytes, bytearray)) else (
                body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode())
            self.send_response(status)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if "json" in ctype or "text" in ctype else ""))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode() if n else ""
            if "text/csv" in (self.headers.get("Content-Type") or ""):
                return raw
            return json.loads(raw) if raw else {}

        def _same_origin(self, method: str) -> bool:
            """CSRF / DNS-rebinding guard for a localhost server that can start Claude runs and write
            records: the Host must be a loopback name (unless a token is set), a browser Origin must
            match the Host, and writes must use a non-"simple" content type so cross-site pages
            trigger a CORS preflight that this server never approves."""
            host = (self.headers.get("Host") or "").lower()
            hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
            if not token and hostname not in ("localhost", "127.0.0.1", "[::1]") and not hostname.endswith(".localhost"):
                return False
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc.lower() != host:
                return False
            if method in ("POST", "PATCH", "DELETE") and int(self.headers.get("Content-Length") or 0):
                ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if ctype not in ("application/json", "text/csv"):
                    return False
            return True

        def _authorized(self) -> bool:
            if not token:
                return True
            got = self.headers.get("Authorization", "")
            return hmac.compare_digest(got, f"Bearer {token}")

        def _dispatch(self, method: str):
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            qs = {k: v[-1] for k, v in parse_qs(url.query).items()}
            if not parts or parts == ["index.html"]:
                return self._send(200, UI.read_bytes(), "text/html")
            if parts[0] != "api":
                return self._send(404, {"error": "not found"})
            if not self._same_origin(method):
                return self._send(403, {"error": "cross-origin or non-JSON request refused"})
            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            if parts[1:] == ["chat"] and method == "POST":
                return self._chat()
            try:
                status, body, *ctype = self._route(method, parts[1:], qs)
                self._send(status, body, *(ctype or []))
            except StoreError as e:
                self._send(e.status, {"error": str(e), "details": e.details})
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                self._send(400, {"error": str(e)})

        def _chat(self):
            b = self._body()
            chat_id = str(b.get("chat_id") or "default")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                for ev in runner.stream(chat_id, b.get("message", ""), b.get("session_id"), b.get("context")):
                    self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                runner.cancel(chat_id)

        def do_GET(self): self._dispatch("GET")
        def do_POST(self): self._dispatch("POST")
        def do_PATCH(self): self._dispatch("PATCH")
        def do_PUT(self): self._dispatch("PATCH")
        def do_DELETE(self): self._dispatch("DELETE")

        # ------------------------------------------------------------ routes
        def _route(self, method, p, qs):
            if p == ["meta"] and method == "GET":
                return 200, meta(store)
            if p == ["config"] and method == "PATCH":
                return 200, store.save_config(self._body())
            if p == ["lint"]:
                if any(k in qs for k in ("limit", "offset", "rule", "severity", "type", "category", "q")):
                    return 200, query.lint_page(store, qs.get("rule", ""), qs.get("severity", ""), qs.get("type", ""),
                                                qs.get("category", ""), qs.get("q", ""), int(qs.get("offset", 0)),
                                                int(qs.get("limit", 100)))
                return 200, store.memo("lint", lambda: lint.lint(store))
            if p == ["trace"]:
                rep = store.memo("trace", lambda: trace.evaluate(store))
                if qs.get("matrix") == "0":
                    rep = {k: v for k, v in rep.items() if k != "matrix"}
                return 200, rep
            if p == ["evals"]:
                return 200, evals.registry(store, qs.get("stage"), qs.get("component"))
            if p == ["sync"] and method == "POST":
                return 200, store.sync(self._body().get("message", "reqforge: sync from API"))
            if p == ["chat", "status"]:
                return 200, runner.available()
            if p == ["chat", "cancel"] and method == "POST":
                return 200, {"cancelled": runner.cancel(str(self._body().get("chat_id") or "default"))}
            if len(p) == 2 and p[0] == "context":
                return 200, changes.context(store, p[1])
            if p and p[0] == "changesets":
                if len(p) == 1 and method == "GET":
                    return 200, changes.list_(store, qs.get("status"))
                if len(p) == 1 and method == "POST":
                    return 201, changes.propose(store, self._body())
                if p[1:] == ["simulate"] and method == "POST":
                    return 200, changes.simulate(store, self._body())
                if len(p) == 2 and method == "GET":
                    return 200, changes.get(store, p[1])
                if len(p) == 3 and p[2] == "apply" and method == "POST":
                    return 200, changes.apply(store, p[1], self._body().get("exclude"))
                if len(p) == 3 and p[2] == "reject" and method == "POST":
                    return 200, changes.reject(store, p[1], self._body().get("reason", ""))
            if p and p[0] == "sessions":
                if len(p) == 1 and method == "GET":
                    return 200, store.sessions()
                if len(p) == 1 and method == "POST":
                    b = self._body()
                    return 201, {"id": store.save_session(b["title"], b["markdown"], b.get("id"))}
                if len(p) == 2 and re.fullmatch(r"ELI-\d+", p[1]):
                    f = store.root / "sessions" / f"{p[1]}.md"
                    if not f.exists():
                        raise StoreError(f"{p[1]} not found", 404)
                    return 200, f.read_text(), "text/markdown"
            kind = normalize_kind(p[0])
            if len(p) == 1:
                if method == "GET":
                    q = qs.pop("q", "")
                    paging = {k: qs.pop(k) for k in ("limit", "offset", "sort", "order") if k in qs}
                    if paging:
                        return 200, query.page(store, kind, q, qs, paging.get("sort", "id"), paging.get("order", "asc"),
                                               int(paging.get("offset", 0)), int(paging.get("limit", 100)))
                    return 200, store.search(kind, q, qs)
                if method == "POST":
                    return 201, store.create(kind, self._body())
            if len(p) == 2 and p[1] == "bulk" and method == "POST":
                b = self._body()
                return 200, store.bulk_update(kind, b.get("ids"), b.get("q", ""), b.get("where"), b.get("set"),
                                              b.get("add"), b.get("remove"), bool(b.get("dry_run")))
            if len(p) == 2 and p[1] == "import" and method == "POST":
                b = self._body()
                rows = csvio.parse_csv(b, kind) if isinstance(b, str) else b["rows"]
                return 200, store.upsert_many(kind, rows)
            if len(p) == 2 and p[1] == "facets" and method == "GET":
                q = qs.pop("q", "")
                return 200, query.facets(store, kind, q, qs)
            if len(p) == 2 and p[1] == "export.csv" and method == "GET":
                q = qs.pop("q", "")
                return 200, csvio.export_csv(store.search(kind, q, qs), kind), "text/csv"
            if len(p) == 2:
                rid = p[1]
                if method == "GET":
                    return 200, store.get(kind, rid)
                if method == "PATCH":
                    b = self._body()
                    ver = b.pop("_version", None) or self.headers.get("If-Match")
                    return 200, store.update(kind, rid, b, int(ver) if ver else None)
                if method == "DELETE":
                    return 200, store.delete(kind, rid, force=qs.get("force") in ("1", "true"))
            raise StoreError("no such route", 404)

    return Handler


def serve(store: Store, host: str = "127.0.0.1", port: int = 8787) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(store))
