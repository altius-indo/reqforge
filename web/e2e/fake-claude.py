#!/usr/bin/env python3
# reqforge:ignore-file (test fixture: the requirement ids below are seeded data, not trace tags)
"""Stand-in for `claude -p` in the e2e suites (the server runs it via REQFORGE_CLAUDE_BIN).

Emits stream-json like the real CLI. Turn 1 searches and asks a ```choices question; turn 2 (the answer,
which contains "→") proposes a real changeset through `reqforge mcp`; turn 3 (the "I applied …" follow-up)
replies "Verified". The reqforge binary comes from $REQFORGE_BIN (set by web/e2e/run.mjs)."""
import json
import os
import subprocess
import sys

BIN = os.environ.get("REQFORGE_BIN") or "reqforge"
prompt = sys.stdin.read()


def out(o):
    print(json.dumps(o), flush=True)


def mcp(name, args):
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": args}}]
    p = subprocess.run([BIN, "mcp"], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, env=os.environ)
    if p.returncode != 0 or len(p.stdout.splitlines()) < 2:
        sys.stderr.write(f"fake-claude: `{BIN} mcp` failed ({p.returncode}): {p.stderr[-500:]}\n")
        sys.exit(1)
    return json.loads(json.loads(p.stdout.splitlines()[1])["result"]["content"][0]["text"])


out({"type": "system", "subtype": "init", "session_id": "s1", "mcp_servers": [{"name": "plugin:reqforge:reqforge", "status": "connected"}]})
if "→" not in prompt and "applied" not in prompt:
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a", "name": "mcp__plugin_reqforge_reqforge__search",
                                                        "input": {"kind": "requirements", "q": "type:data audit"}}]}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "I found **REQ-0042** nearby. One decision first:\n```choices\n"
                                                        "{\"question\": \"How long must audit logs be retained?\", \"options\": [\"1 year (Recommended)\", \"7 years\"], \"multi\": false}\n```"}]}})
elif "applied" in prompt:
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "Verified: trace delta clean."}]}})
else:
    res = mcp("propose_changeset", {"changeset": {
        "title": "Audit log retention", "summary": "Add retention requirement and link it",
        "ops": [
            {"op": "create", "kind": "requirements", "ref": "r1", "reason": "user chose 1 year",
             "data": {"title": "Audit log retention", "type": "data", "category": "lifecycle", "status": "proposed",
                      "statement": "The system shall retain audit log entries for 1 year and purge them within 30 days after expiry.",
                      "acceptance_criteria": [{"id": "AC1", "text": "entries older than 395 days are absent"}]}},
            {"op": "update", "id": "REQ-0042", "patch": {"priority": "must"}, "reason": "aligns with retention"}],
        "impact": {"stories": "none yet", "code": "audit-service purge job", "evals": "add retention eval", "risks": ["purge job must be idempotent"]}}})
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "p", "name": "mcp__plugin_reqforge_reqforge__propose_changeset",
                                                        "input": {"changeset": {"title": "Audit log retention", "ops": [1, 2]}}}]}})
    out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "p", "content": [{"type": "text", "text": json.dumps(res)}]}]}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "Proposed the changeset below; review and apply."}]}})
out({"type": "result", "subtype": "success", "session_id": "s1", "total_cost_usd": 0.0, "num_turns": 1, "is_error": False})
