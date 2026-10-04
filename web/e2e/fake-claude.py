#!/usr/bin/env python3
# reqforge:ignore-file (test fixture: the requirement ids below are seeded data, not trace tags)
"""Stand-in for `claude -p` in the e2e suites (the server runs it via REQFORGE_CLAUDE_BIN).

Emits stream-json like the real CLI. Turn 1 searches and asks a ```choices question; turn 2 (the answer,
which contains "→") proposes a real changeset through `reqforge mcp`; turn 3 (the "I applied …" follow-up)
replies "Verified". The reqforge binary comes from $REQFORGE_BIN (set by web/e2e/run.mjs).

Coding-agent mode (the server's agent launcher passes `--permission-mode acceptEdits`, cwd = the task worktree,
stdin = the brief): writes a file in cwd, commits it as "TASK-…: …", and emits stream-json (system init,
assistant tool_use + text, result). A brief containing "SLOW" keeps running for up to 120 s (for cancel tests);
one containing "QWAIT" takes 6 s (for queue tests)."""
import json
import os
import re
import subprocess
import sys
import time

BIN = os.environ.get("REQFORGE_BIN") or "reqforge"
prompt = sys.stdin.read()


def out(o):
    print(json.dumps(o), flush=True)


def coding_agent():
    task = os.environ.get("REQFORGE_TASK") or (re.search(r"TASK-\d+", prompt) or [None])[0] or "TASK"
    out({"type": "system", "subtype": "init", "session_id": "agent-" + task,
         "mcp_servers": [{"name": "plugin:reqforge:reqforge", "status": "connected"}]})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": f"Working on {task}: reading the brief."}]}})
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "README.md"}}]}})
    if "SLOW" in prompt:
        for i in range(240):
            if i % 4 == 0:
                out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"b{i}", "name": "Bash",
                                                                    "input": {"command": f"sleep 2  # step {i // 4}"}}]}})
            time.sleep(0.5)
    elif "QWAIT" in prompt:
        time.sleep(6)
    name = f"agent-{task.lower()}.txt"
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "w1", "name": "Write",
                                                        "input": {"file_path": name, "content": "..."}}]}})
    with open(name, "w") as f:
        f.write(f"work for {task}\n")
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "g1", "name": "Bash",
                                                        "input": {"command": f"git add {name} && git commit -m '{task}: …'"}}]}})
    subprocess.run(["git", "add", name], check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-q", "-m", f"{task}: add {name}"],
                   check=True, capture_output=True)
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": f"Done: committed {name} on this branch. Tests: n/a (fake agent)."}]}})
    out({"type": "result", "subtype": "success", "session_id": "agent-" + task, "total_cost_usd": 0.0, "num_turns": 3, "is_error": False})


if "--permission-mode" in sys.argv and "acceptEdits" in sys.argv:
    coding_agent()
    sys.exit(0)


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
