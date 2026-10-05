#!/usr/bin/env python3
# reqforge:ignore-file (test fixture: the requirement ids below are seeded data, not trace tags)
"""Stand-in for `claude -p` in the e2e suites (the server runs it via REQFORGE_CLAUDE_BIN).

Emits stream-json like the real CLI. Turn 1 searches and asks a ```choices question; turn 2 (the answer,
which contains "→") proposes a real changeset through `reqforge mcp`; turn 3 (the "I applied …" follow-up)
replies "Verified". A message with "NEXT-DEMO" proposes an estimate for TASK-0002 (SHOP demo); the wrap-up
message ("Before we stop: …") proposes TASK-0002's next action and a snapshot. A turn asking to "Draft a project
snapshot" proposes a changeset with one snapshot op (a new state/HOT.md dated today). The reqforge binary comes from
$REQFORGE_BIN (set by web/e2e/run.mjs).

Coding-agent mode (the server's agent launcher passes `--permission-mode acceptEdits`, cwd = the task worktree,
stdin = the brief): writes a file in cwd, commits it as "TASK-…: …", and emits stream-json (system init,
assistant tool_use + text, result); with "PROPOSE-NEXT" in the brief the final message ends with a NEXT: line.
A brief containing "SLOW" keeps running for up to 120 s (for cancel tests);
one containing "QWAIT" takes 6 s (for queue tests)."""
import json
import os
import re
import subprocess
import sys
import time
from datetime import date

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
    for cmd in (["git", "add", name], ["git", "-c", "user.email=e2e@x", "-c", "user.name=e2e", "commit", "-q", "-m", f"{task}: add {name}"]):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"{' '.join(cmd[:2])} … failed ({r.returncode}): {r.stderr.strip()}")
    done = f"Done: committed {name} on this branch. Tests: n/a (fake agent)."
    if "PROPOSE-NEXT" in prompt:
        done += f"\nNEXT: Run `pytest tests/test_checkout.py` and review {name}"
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": done}]}})
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


def propose(changeset, say):
    res = mcp("propose_changeset", {"changeset": changeset})
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "p", "name": "mcp__plugin_reqforge_reqforge__propose_changeset",
                                                        "input": {"changeset": {"title": changeset["title"]}}}]}})
    out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "p", "content": [{"type": "text", "text": json.dumps(res)}]}]}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": say}]}})


out({"type": "system", "subtype": "init", "session_id": "s1", "mcp_servers": [{"name": "plugin:reqforge:reqforge", "status": "connected"}]})
if "Before we stop:" in prompt:
    # the wrap-up turn (REQ-0059#AC4): next actions for the tasks touched, and the snapshot Next
    today = time.strftime("%Y-%m-%d")
    hot = ("# Project state\n\n## Now\nCheckout tasks under way.\n\n## Next\n- Run `pytest tests/test_checkout.py` for TASK-0002\n\n"
           f"## Watch\n- PSP sandbox limits\n\nLast reconciled: {today}\n")
    propose({"title": "Wrap-up: next actions", "ops": [
        {"op": "update", "id": "TASK-0002", "patch": {"next_action": "Run `pytest tests/test_checkout.py`", "next_action_set": today},
         "reason": "estimate changed in this session"},
        {"op": "snapshot", "content": hot, "reason": "Next moved on"}]}, "Proposed next actions and the snapshot Next below.")
elif "NEXT-DEMO" in prompt:
    propose({"title": "Estimate TASK-0002", "ops": [{"op": "update", "id": "TASK-0002", "patch": {"estimate": "2d"}, "reason": "user asked"}]},
            "Proposed the estimate below; review and apply.")
elif "Draft a project snapshot" in prompt and "applied" not in prompt:
    snap = (f"# Project snapshot\n\n## Now\n\n- Checkout flow in progress (STORY-0001)\n\n## Next\n\n- Ship guest checkout\n\n"
            f"## Watch\n\n- PSP latency budget\n\nLast reconciled: {date.today().isoformat()}\n")
    res = mcp("propose_changeset", {"changeset": {"title": "Draft project snapshot", "summary": "First state/HOT.md",
                                                  "ops": [{"op": "snapshot", "content": snap, "reason": "no snapshot yet"}]}})
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "p", "name": "mcp__plugin_reqforge_reqforge__propose_changeset",
                                                        "input": {"changeset": {"title": "Draft project snapshot", "ops": [1]}}}]}})
    out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "p", "content": [{"type": "text", "text": json.dumps(res)}]}]}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "Drafted the snapshot below; review the diff and apply."}]}})
elif "→" not in prompt and "applied" not in prompt:
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
