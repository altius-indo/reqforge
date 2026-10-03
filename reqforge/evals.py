"""Eval registry + runner. Evals live on stories; the runner executes the ones for a
pipeline stage inside the code repo and reports results keyed back to story and
requirement acceptance criteria, so a red build names the requirement at risk."""
from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import time
from pathlib import Path

from .model import EVAL_KINDS, STAGES


def registry(store, stage: str | None = None, component: str | None = None) -> list[dict]:
    out = []
    for s in store.all("stories"):
        if component and s.get("component") not in (component, None, ""):
            continue
        for ev in s.get("evals", []):
            st = EVAL_KINDS.get(ev.get("kind"), "acceptance")
            if stage and st != stage:
                continue
            out.append({"story": s["id"], "story_title": s.get("title"), "requirements": s.get("requirements", []),
                        "stage": st, **ev})
    out.sort(key=lambda e: (STAGES.index(e["stage"]), e["story"], e.get("id", "")))
    return out


def run(store, stage: str, workdir: str = ".", component: str | None = None, timeout: int = 1800,
        report_dir: str | None = None) -> dict:
    if stage not in STAGES:
        raise ValueError(f"unknown stage '{stage}' (expected one of {STAGES})")
    evs = registry(store, stage, component)
    results = []
    for ev in evs:
        if not ev.get("command"):
            results.append({**_brief(ev), "status": "skipped", "reason": "no command"})
            continue
        t0 = time.monotonic()
        try:
            p = subprocess.run(ev["command"], shell=True, cwd=workdir, capture_output=True, text=True,
                               timeout=ev.get("timeout", timeout),
                               env={**os.environ, "REQFORGE_STORY": ev["story"], "REQFORGE_EVAL": ev.get("id", "")})
            status = "passed" if p.returncode == 0 else "failed"
            tail = (p.stdout + p.stderr)[-4000:]
        except subprocess.TimeoutExpired:
            status, tail = "failed", "timeout"
        dur = round(time.monotonic() - t0, 2)
        results.append({**_brief(ev), "status": status, "seconds": dur, **({"output": tail} if status == "failed" else {})})
    failed = [r for r in results if r["status"] == "failed" and r.get("required", True)]
    rep = {
        "stage": stage, "at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "ok": not failed, "total": len(results),
        "passed": sum(r["status"] == "passed" for r in results),
        "failed": len([r for r in results if r["status"] == "failed"]),
        "skipped": sum(r["status"] == "skipped" for r in results),
        "requirements_at_risk": sorted({c.split("#")[0] for r in failed for c in r.get("covers", [])}
                                       | {q for r in failed for q in r.get("requirements", [])}),
        "results": results,
    }
    out = Path(report_dir or Path(workdir) / "reqforge-reports")
    out.mkdir(parents=True, exist_ok=True)
    (out / f"evals-{stage}.json").write_text(json.dumps(rep, indent=2) + "\n")
    return rep


def _brief(ev: dict) -> dict:
    return {k: ev.get(k) for k in ("story", "id", "name", "kind", "stage", "covers", "requirements", "command")
            } | {"required": ev.get("required", True)}


def to_markdown(rep: dict) -> str:
    lines = [f"## Evals — {rep['stage']}: {'PASS' if rep['ok'] else 'FAIL'} "
             f"({rep['passed']} passed, {rep['failed']} failed, {rep['skipped']} skipped)"]
    if rep["requirements_at_risk"]:
        lines.append(f"Requirements at risk: {', '.join(rep['requirements_at_risk'])}")
    lines += ["", "| story | eval | kind | status | covers |", "|---|---|---|---|---|"]
    for r in rep["results"]:
        lines.append(f"| {r['story']} | {r['id']} {r.get('name') or ''} | {r['kind']} | {r['status']} | {', '.join(r.get('covers') or [])} |")
    return "\n".join(lines) + "\n"
