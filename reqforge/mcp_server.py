"""Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited) — stdlib only.

Gives the plugin's agents typed access to the requirements repository: they never
hand-edit JSON files, so every write is validated, versioned and committed."""
from __future__ import annotations

import json
import sys
import traceback

from . import __version__, evals, lint, trace
from .api import meta
from .model import KINDS, kind_of_id
from .store import Store, StoreError

PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
KIND_ENUM = {"type": "string", "enum": list(KINDS)}
OBJ = {"type": "object"}
STR_LIST = {"type": "array", "items": {"type": "string"}}


def _tool(name, description, props=None, required=None):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": required or []}}


TOOLS = [
    _tool("taxonomy", "Requirement taxonomy (decision-ordered types and categories), field schemas, enums and project config. Call before classifying or creating records."),
    _tool("search", "Search records. q is free text; tokens like status:approved or type:quality|data filter exactly.",
          {"kind": KIND_ENUM, "q": {"type": "string"}, "where": OBJ}, ["kind"]),
    _tool("get", "Get one record by id (REQ-0001, EPIC-0001, STORY-0001, TASK-0001).", {"id": {"type": "string"}}, ["id"]),
    _tool("create", "Create one record; id is assigned. Returns the record.",
          {"kind": KIND_ENUM, "data": OBJ}, ["kind", "data"]),
    _tool("upsert_many", "Create or update many records of one kind atomically-validated (rows with an existing id are patched). Use for writing a whole elicited requirement set or a whole plan.",
          {"kind": KIND_ENUM, "rows": {"type": "array", "items": OBJ}, "message": {"type": "string"}}, ["kind", "rows"]),
    _tool("update", "Patch a record. Pass version for optimistic concurrency.",
          {"id": {"type": "string"}, "patch": OBJ, "version": {"type": "integer"}}, ["id", "patch"]),
    _tool("bulk_update", "Mass update records selected by ids or by q/where. set replaces fields; add/remove edit list fields (e.g. tags). All-or-nothing; use dry_run first.",
          {"kind": KIND_ENUM, "ids": STR_LIST, "q": {"type": "string"}, "where": OBJ, "set": OBJ,
           "add": OBJ, "remove": OBJ, "dry_run": {"type": "boolean"}}, ["kind"]),
    _tool("delete", "Delete a record (refuses if referenced unless force).",
          {"id": {"type": "string"}, "force": {"type": "boolean"}}, ["id"]),
    _tool("lint", "MECE + quality lint of the requirement set: overlaps, taxonomy coverage gaps, vague/unmeasurable statements."),
    _tool("trace", "Deterministic traceability evaluation: requirement->story coverage, orphans, evals per code story, acceptance-criteria coverage, quality-eval matching, lifecycle coverage."),
    _tool("eval_registry", "List evals defined on stories, optionally for one pipeline stage.",
          {"stage": {"type": "string"}, "component": {"type": "string"}}),
    _tool("save_session", "Persist an elicitation session transcript (markdown: request, research findings with sources, questions and answers, decisions). Returns session id ELI-NNNN.",
          {"title": {"type": "string"}, "markdown": {"type": "string"}, "id": {"type": "string"}}, ["title", "markdown"]),
    _tool("config", "Read, or patch with `patch`, the project config (gates, coverage_waivers, cicd).", {"patch": OBJ}),
    _tool("sync", "Commit pending changes, pull --rebase and push the requirements repo to GitHub.", {"message": {"type": "string"}}),
    _tool("init_repo", "Initialise a requirements repository (optionally creating the GitHub repo owner/name).",
          {"path": {"type": "string"}, "key": {"type": "string"}, "name": {"type": "string"},
           "github": {"type": "string"}, "private": {"type": "boolean"}}, ["path", "key", "name"]),
]


def call(name: str, a: dict):
    if name == "init_repo":
        s = Store.init(a["path"], a["key"], a["name"], a.get("github"), a.get("private", True))
        return {"root": str(s.root), "config": s.config}
    s = Store.discover()
    if name == "taxonomy":
        return meta(s)
    if name == "search":
        return s.search(a["kind"], a.get("q", ""), a.get("where"))
    if name == "get":
        return s.get(kind_of_id(a["id"]), a["id"])
    if name == "create":
        return s.create(a["kind"], a["data"])
    if name == "upsert_many":
        return s.upsert_many(a["kind"], a["rows"], a.get("message"))
    if name == "update":
        return s.update(kind_of_id(a["id"]), a["id"], a["patch"], a.get("version"))
    if name == "bulk_update":
        return s.bulk_update(a["kind"], a.get("ids"), a.get("q", ""), a.get("where"), a.get("set"),
                             a.get("add"), a.get("remove"), a.get("dry_run", False))
    if name == "delete":
        return s.delete(kind_of_id(a["id"]), a["id"], a.get("force", False))
    if name == "lint":
        return lint.lint(s)
    if name == "trace":
        return trace.evaluate(s)
    if name == "eval_registry":
        return evals.registry(s, a.get("stage"), a.get("component"))
    if name == "save_session":
        return {"id": s.save_session(a["title"], a["markdown"], a.get("id"))}
    if name == "config":
        return s.save_config(a["patch"]) if a.get("patch") else s.config
    if name == "sync":
        return s.sync(a.get("message", "reqforge: sync"))
    raise ValueError(f"unknown tool {name}")


def handle(msg: dict):
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        want = (msg.get("params") or {}).get("protocolVersion")
        return {"protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "reqforge", "version": __version__}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        p = msg.get("params") or {}
        try:
            result = call(p.get("name"), p.get("arguments") or {})
            return {"content": [{"type": "text", "text": json.dumps(result, indent=1, ensure_ascii=False)}]}
        except StoreError as e:
            return {"isError": True, "content": [{"type": "text", "text": json.dumps({"error": str(e), "details": e.details})}]}
        except Exception as e:  # report tool failures to the model rather than killing the server
            return {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}
    if mid is None:
        return None  # notification
    raise LookupError(method)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            result = handle(msg)
            if msg.get("id") is None:
                continue
            resp = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
        except LookupError as e:
            resp = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": f"method not found: {e}"}}
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            resp = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": str(e)}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
