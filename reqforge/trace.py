"""Deterministic traceability evaluation of the requirement -> epic -> story -> task -> eval graph.

This is the gate CI runs. The semantic judgement ("does this story actually satisfy
that requirement?") is the traceability-evaluator agent's job and lands in
reports/; this module checks everything that can be checked mechanically."""
from __future__ import annotations

from collections import defaultdict

from .model import EVAL_KINDS, QUALITY_EVAL_MATCH

ACTIVE = {"proposed", "approved", "implemented", "verified"}


def _ac_ref(req_id: str, ac_id: str) -> str:
    return f"{req_id}#{ac_id}"


def evaluate(store) -> dict:
    reqs = {r["id"]: r for r in store.all("requirements")}
    epics = {e["id"]: e for e in store.all("epics")}
    stories = {s["id"]: s for s in store.all("stories")}
    tasks = {t["id"]: t for t in store.all("tasks")}
    gates = store.config.get("gates", {})

    active = {rid: r for rid, r in reqs.items() if r.get("status") in ACTIVE and r.get("priority") != "wont"}
    req_to_stories: dict[str, list[str]] = defaultdict(list)
    for s in stories.values():
        for rid in s.get("requirements", []):
            req_to_stories[rid].append(s["id"])
    story_tasks: dict[str, list[str]] = defaultdict(list)
    for t in tasks.values():
        story_tasks[t.get("story")].append(t["id"])

    checks = []

    def check(cid, name, failures, severity="error", measured=None):
        checks.append({"id": cid, "name": name, "passed": not failures, "severity": severity,
                       "failures": failures, **({"measured": measured} if measured is not None else {})})

    # 1. forward coverage: every active requirement realised by >=1 story
    uncovered = [rid for rid in active if not req_to_stories.get(rid)]
    req_cov = 1 - len(uncovered) / len(active) if active else 1.0
    check("req-coverage", "Every active requirement maps to at least one story",
          [f"{rid} has no story" for rid in uncovered],
          "error" if req_cov < gates.get("min_requirement_coverage", 1.0) else "warning", round(req_cov, 3))

    # 2. backward coverage: no orphan stories (gold-plating)
    check("story-trace", "Every story traces to at least one requirement",
          [f"{sid} traces to no requirement" for sid, s in stories.items() if not s.get("requirements")])

    # 3. structure: epics hold stories, stories hold tasks
    epic_ids_used = {s.get("epic") for s in stories.values()}
    check("epic-nonempty", "Every epic has at least one story",
          [f"{eid} has no stories" for eid in epics if eid not in epic_ids_used], "warning")
    check("story-tasks", "Every story has at least one task",
          [f"{sid} has no tasks" for sid in stories if not story_tasks.get(sid)])

    # 4. code stories carry evals from the start, each runnable
    need_evals = gates.get("require_evals_for_code", True)
    missing_evals, missing_cmd = [], []
    for sid, s in stories.items():
        if s.get("deliverable", "code") == "code":
            if not s.get("evals"):
                missing_evals.append(f"{sid} (code) has no evals")
            for ev in s.get("evals", []):
                if not ev.get("command"):
                    missing_cmd.append(f"{sid}/{ev.get('id')} has no command")
    check("story-evals", "Every code story defines evals", missing_evals, "error" if need_evals else "warning")
    check("eval-runnable", "Every eval has a runnable command", missing_cmd, "warning")

    # 5. acceptance-criteria coverage: each AC of a covered requirement is exercised by an eval
    all_acs, covered_acs = [], set()
    for s in stories.values():
        for ev in s.get("evals", []):
            covered_acs.update(ev.get("covers", []))
    for rid, r in active.items():
        for ac in r.get("acceptance_criteria", []):
            all_acs.append(_ac_ref(rid, ac.get("id")))
    ac_missing = [ref for ref in all_acs if ref not in covered_acs]
    ac_cov = 1 - len(ac_missing) / len(all_acs) if all_acs else 1.0
    check("criteria-coverage", "Requirement acceptance criteria are covered by evals",
          [f"{ref} not covered by any eval" for ref in ac_missing],
          "error" if ac_cov < gates.get("min_criteria_coverage", 0.8) else "warning", round(ac_cov, 3))

    # 6. quality requirements verified by the right kind of eval
    qmis = []
    for rid, r in active.items():
        want = QUALITY_EVAL_MATCH.get(r.get("category")) if r.get("type") == "quality" else None
        if not want:
            continue
        kinds = {ev.get("kind") for sid in req_to_stories.get(rid, []) for ev in stories[sid].get("evals", [])}
        if not kinds & want:
            qmis.append(f"{rid} ({r['category']}) needs an eval of kind {'/'.join(sorted(want))}")
    check("quality-evals", "Quality requirements verified by matching eval kinds", qmis)

    # 7. delivery coverage: something deploys and something monitors
    tkinds = {t.get("kind") for t in tasks.values()}
    lifecycle = [f"no {k} task anywhere in the plan" for k in ("design", "deployment", "monitoring") if stories and k not in tkinds]
    check("lifecycle", "Plan covers design, deployment and monitoring work", lifecycle, "warning")

    # 8. referential integrity of eval coverage refs
    bad_refs = []
    for sid, s in stories.items():
        for ev in s.get("evals", []):
            for ref in ev.get("covers", []):
                rid, _, ac = ref.partition("#")
                if rid not in reqs or (ac and ac not in {a.get("id") for a in reqs[rid].get("acceptance_criteria", [])}):
                    bad_refs.append(f"{sid}/{ev.get('id')} covers unknown {ref}")
                elif rid not in s.get("requirements", []):
                    bad_refs.append(f"{sid}/{ev.get('id')} covers {ref} but story does not trace to {rid}")
            if ev.get("kind") and ev["kind"] not in EVAL_KINDS:
                bad_refs.append(f"{sid}/{ev.get('id')} unknown kind {ev['kind']}")
    check("eval-refs", "Eval coverage references are valid", bad_refs)

    errors = [c for c in checks if not c["passed"] and c["severity"] == "error"]
    matrix = {rid: {"title": r.get("title"), "status": r.get("status"), "stories": req_to_stories.get(rid, []),
                    "criteria": [{"id": a.get("id"), "covered": _ac_ref(rid, a.get("id")) in covered_acs}
                                 for a in r.get("acceptance_criteria", [])]}
              for rid, r in reqs.items()}
    passed = sum(c["passed"] for c in checks)
    return {
        "ok": not errors,
        "score": round(passed / len(checks), 3),
        "metrics": {"requirements": len(reqs), "active": len(active), "epics": len(epics),
                    "stories": len(stories), "tasks": len(tasks),
                    "evals": sum(len(s.get("evals", [])) for s in stories.values()),
                    "requirement_coverage": round(req_cov, 3), "criteria_coverage": round(ac_cov, 3)},
        "checks": checks,
        "matrix": matrix,
    }


def to_markdown(rep: dict) -> str:
    m = rep["metrics"]
    out = [f"# Traceability report — {'PASS' if rep['ok'] else 'FAIL'} (score {rep['score']:.0%})", "",
           f"requirements {m['requirements']} (active {m['active']}) · epics {m['epics']} · stories {m['stories']} · "
           f"tasks {m['tasks']} · evals {m['evals']}",
           f"requirement coverage {m['requirement_coverage']:.0%} · criteria coverage {m['criteria_coverage']:.0%}", "",
           "| check | result | failures |", "|---|---|---|"]
    for c in rep["checks"]:
        res = "pass" if c["passed"] else c["severity"]
        out.append(f"| {c['name']} | {res} | {len(c['failures'])} |")
    for c in rep["checks"]:
        if c["failures"]:
            out += ["", f"## {c['name']}", *[f"- {f}" for f in c["failures"][:50]]]
    out += ["", "## Matrix", "", "| requirement | status | stories | criteria covered |", "|---|---|---|---|"]
    for rid, row in rep["matrix"].items():
        crit = row["criteria"]
        cov = f"{sum(c['covered'] for c in crit)}/{len(crit)}" if crit else "—"
        out.append(f"| {rid} {row['title']} | {row['status']} | {', '.join(row['stories']) or '—'} | {cov} |")
    return "\n".join(out) + "\n"
