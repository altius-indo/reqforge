"""Bridge from the web UI chat panel to the local Claude Code CLI.

Each user message runs `claude -p` (headless) with the reqforge plugin loaded, a
system prompt that defines the review -> simulate -> propose loop, and a tool
allowlist that excludes every direct write: the agent can only propose changesets,
and the user applies them in the UI. Conversation continuity uses `--resume`.
The stream-json output is translated into small UI events (text, tool, changeset,
choices, done, error)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

PKG = Path(__file__).resolve().parent
PLUGIN_ROOT = PKG.parent
SYSTEM_PROMPT = (PKG / "chat_prompt.md").read_text()
MCP = "mcp__plugin_reqforge_reqforge__"
READ_TOOLS = ["taxonomy", "search", "get", "context", "lint", "trace", "eval_registry",
              "simulate_changeset", "propose_changeset", "get_changeset", "list_changesets", "save_session"]
WRITE_TOOLS = ["create", "update", "delete", "bulk_update", "upsert_many", "apply_changeset",
               "reject_changeset", "config", "sync", "init_repo"]
ALLOWED = [MCP + t for t in READ_TOOLS] + ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Agent", "Task", "TodoWrite"]
DENIED = [MCP + t for t in WRITE_TOOLS] + ["Bash", "Write", "Edit", "NotebookEdit"]


def _context_preamble(ctx: dict | None) -> str:
    if not ctx:
        return ""
    lines = ["[UI context]"]
    view = ctx.get("view") or {}
    if view:
        lines.append("Viewing: " + ", ".join(f"{k}={v}" for k, v in view.items() if v))
    sel = ctx.get("selected") or []
    if sel:
        more = f" (+{ctx.get('selected_total', len(sel)) - len(sel)} more)" if ctx.get("selected_total", 0) > len(sel) else ""
        lines.append(f"Selected records: {', '.join(sel)}{more}")
    return "\n".join(lines) + "\n\n"


def _tool_brief(name: str, inp: dict) -> str:
    short = name.replace(MCP, "")
    if short in ("search",):
        return f"search {inp.get('kind', '')} “{inp.get('q', '')}”"
    if short in ("get", "context"):
        return f"{short} {inp.get('id', '')}"
    if short in ("simulate_changeset", "propose_changeset"):
        cs = inp.get("changeset") or inp
        return f"{short.replace('_', ' ')}: {len(cs.get('ops') or [])} ops — {cs.get('title', '')}"
    if short == "Agent" or short == "Task":
        return f"agent {inp.get('subagent_type', '')}: {inp.get('description', '')}"
    if short in ("Grep", "Glob"):
        return f"{short} {inp.get('pattern', '')}"
    if short == "Read":
        return f"read {inp.get('file_path', '')}"
    if short in ("WebSearch", "WebFetch"):
        return f"{short} {inp.get('query') or inp.get('url', '')}"
    return short


class ChatRunner:
    def __init__(self, store):
        self.store = store
        self.procs: dict[str, subprocess.Popen] = {}
        self.lock = threading.Lock()

    def available(self) -> dict:
        claude = os.environ.get("REQFORGE_CLAUDE_BIN") or shutil.which("claude")
        return {"available": bool(claude), "claude": claude}

    def command(self, session_id: str | None) -> list[str]:
        claude = os.environ.get("REQFORGE_CLAUDE_BIN") or shutil.which("claude")
        cmd = [claude, "-p", "--output-format", "stream-json", "--verbose",
               "--append-system-prompt", SYSTEM_PROMPT,
               "--allowedTools", ",".join(ALLOWED), "--disallowedTools", ",".join(DENIED)]
        plugin_dir = os.environ.get("REQFORGE_PLUGIN_DIR", str(PLUGIN_ROOT))
        if (Path(plugin_dir) / ".claude-plugin").exists():
            cmd += ["--plugin-dir", plugin_dir]
        for path in (self.store.config.get("components") or {}).values():
            p = (self.store.root / path).resolve()
            if p.exists():
                cmd += ["--add-dir", str(p)]
        if os.environ.get("REQFORGE_CHAT_MODEL"):
            cmd += ["--model", os.environ["REQFORGE_CHAT_MODEL"]]
        if session_id:
            cmd += ["--resume", session_id]
        return cmd

    def cancel(self, chat_id: str) -> bool:
        with self.lock:
            p = self.procs.get(chat_id)
        if p and p.poll() is None:
            p.terminate()
            return True
        return False

    def stream(self, chat_id: str, message: str, session_id: str | None = None, context: dict | None = None):
        if not self.available()["available"]:
            yield {"type": "error", "text": "The `claude` CLI was not found on PATH. Install Claude Code or set REQFORGE_CLAUDE_BIN."}
            return
        prompt = _context_preamble(context) + message
        errf = tempfile.TemporaryFile(mode="w+")
        env = {**os.environ, "REQFORGE_REPO": str(self.store.root)}
        try:
            p = subprocess.Popen(self.command(session_id), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=errf, text=True, cwd=str(self.store.root), env=env, bufsize=1)
        except OSError as e:
            yield {"type": "error", "text": f"could not start claude: {e}"}
            return
        with self.lock:
            self.procs[chat_id] = p
        got_result = False
        tool_names: dict[str, str] = {}
        try:
            p.stdin.write(prompt)
            p.stdin.close()
            for line in p.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for ev in self._translate(msg, tool_names):
                    if ev["type"] == "done":
                        got_result = True
                    yield ev
            p.wait()
            if p.returncode not in (0, None) and not got_result:
                errf.seek(0)
                tail = errf.read()[-1500:]
                yield {"type": "error", "text": "cancelled" if p.returncode < 0 else f"claude exited {p.returncode}: {tail}"}
        finally:
            if p.poll() is None:
                p.terminate()
            with self.lock:
                self.procs.pop(chat_id, None)
            errf.close()

    def _translate(self, msg: dict, tool_names: dict):
        t = msg.get("type")
        sub = bool(msg.get("parent_tool_use_id"))
        if t == "system" and msg.get("subtype") == "init":
            yield {"type": "session", "session_id": msg.get("session_id")}
            servers = {s.get("name"): s.get("status") for s in msg.get("mcp_servers") or []}
            st = next((v for k, v in servers.items() if "reqforge" in (k or "")), None)
            if st != "connected":
                yield {"type": "warning", "text": f"reqforge MCP server status: {st or 'not loaded'}"}
        elif t == "assistant":
            for c in (msg.get("message") or {}).get("content") or []:
                if c.get("type") == "text" and not sub and c.get("text", "").strip():
                    yield {"type": "text", "text": c["text"]}
                elif c.get("type") == "tool_use":
                    tool_names[c.get("id")] = c.get("name", "")
                    yield {"type": "tool", "name": c.get("name", "").replace(MCP, ""), "sub": sub,
                           "text": _tool_brief(c.get("name", ""), c.get("input") or {})}
        elif t == "user":
            for c in (msg.get("message") or {}).get("content") or []:
                if not isinstance(c, dict) or c.get("type") != "tool_result":
                    continue
                if not tool_names.get(c.get("tool_use_id"), "").endswith("propose_changeset"):
                    continue
                body = c.get("content")
                text = body if isinstance(body, str) else "".join(x.get("text", "") for x in body or [] if isinstance(x, dict))
                try:
                    data = json.loads(text)
                    if data.get("changeset_id"):
                        yield {"type": "changeset", "id": data["changeset_id"]}
                except (json.JSONDecodeError, AttributeError):
                    pass
        elif t == "result":
            yield {"type": "done", "session_id": msg.get("session_id"), "cost": msg.get("total_cost_usd"),
                   "turns": msg.get("num_turns"), "is_error": msg.get("is_error", False),
                   "result": msg.get("result") if msg.get("is_error") else None}
