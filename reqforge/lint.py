"""Requirement-set lint: mutual exclusivity (overlap), collective exhaustiveness
(taxonomy coverage), and per-requirement quality (ISO/IEC/IEEE 29148 characteristics)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from itertools import combinations

from .model import TAXONOMY, VAGUE_TERMS

STOP = set("""a an the and or of to in on for with by is are be shall must should will
system user users it its that this from as at can may each all any when then""".split())
OVERLAP_THRESHOLD = 0.6


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if w not in STOP and len(w) > 2}


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def lint(store) -> dict:
    reqs = [r for r in store.all("requirements") if r.get("status") != "deprecated"]
    waivers = store.config.get("coverage_waivers", {})
    findings = []

    def add(severity, rule, ids, message):
        findings.append({"severity": severity, "rule": rule, "ids": ids, "message": message})

    # ---- per-requirement quality (singular, unambiguous, verifiable)
    for r in reqs:
        st = r.get("statement", "")
        low = st.lower()
        if not re.search(r"\bshall\b", low):
            add("warning", "statement-form", [r["id"]], "statement should use 'shall' (ISO 29148 normative form)")
        vague = [t for t in VAGUE_TERMS if re.search(rf"(?<![a-z-]){re.escape(t)}(?![a-z-])", low)]
        if vague:
            add("warning", "ambiguity", [r["id"]], f"vague/unverifiable terms: {', '.join(vague)}")
        if len(re.findall(r"\bshall\b", low)) > 1 or re.search(r"\bshall\b[^.]*\band\b[^.]*\bshall\b", low):
            add("warning", "singular", [r["id"]], "statement bundles several requirements; split it")
        if r.get("type") == "quality" and not re.search(r"\d", st + " ".join(a.get("text", "") for a in r.get("acceptance_criteria", []))):
            add("error", "measurable", [r["id"]], "quality requirement has no measurable threshold")
        if not r.get("acceptance_criteria"):
            sev = "error" if r.get("status") in ("approved", "implemented", "verified") else "warning"
            add(sev, "acceptance-criteria", [r["id"]], "no acceptance criteria")
        if not r.get("rationale"):
            add("info", "rationale", [r["id"]], "no rationale recorded")

    # ---- mutual exclusivity: near-duplicate statements. Candidate pairs come from an
    # inverted index over informative terms, so this stays fast with thousands of requirements.
    toks = [_tokens(r.get("title", "") + " " + r.get("statement", "")) for r in reqs]
    index: dict[str, list[int]] = defaultdict(list)
    for i, ts in enumerate(toks):
        for t in ts:
            index[t].append(i)
    cap = max(50, len(reqs) // 20)  # terms in more docs than this carry no overlap signal
    shared: Counter = Counter()
    for posting in index.values():
        if len(posting) > cap:
            continue
        for a, b in combinations(posting, 2):
            shared[(a, b)] += 1
    for (i, j), n in shared.items():
        if n < 2:
            continue
        a, b = reqs[i], reqs[j]
        if a.get("parent") == b["id"] or b.get("parent") == a["id"]:
            continue
        s = jaccard(toks[i], toks[j])
        if s >= OVERLAP_THRESHOLD:
            add("error" if s >= 0.85 else "warning", "overlap", [a["id"], b["id"]],
                f"statements overlap ({s:.0%} shared terms); merge, split the shared part into a parent, or sharpen the boundary")

    # ---- collective exhaustiveness: every taxonomy cell populated or waived
    present = {(r.get("type"), r.get("category")) for r in reqs}
    present_types = {t for t, _ in present}
    gaps = []
    for t, spec in TAXONOMY.items():
        if spec["categories"] is None:
            if t not in present_types and t not in waivers:
                gaps.append(t)
            continue
        for c in spec["categories"]:
            key = f"{t}/{c}"
            if (t, c) not in present and key not in waivers and t not in waivers:
                gaps.append(key)
    for g in gaps:
        add("warning", "coverage-gap", [], f"no requirement covers {g}; add one or waive it in reqforge.json coverage_waivers with a reason")

    # ---- structure
    ids = {r["id"] for r in reqs}
    for r in reqs:
        if r.get("parent") and r["parent"] not in ids:
            add("error", "dangling-parent", [r["id"]], f"parent {r['parent']} missing or deprecated")

    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in ("error", "warning", "info")}
    total_cells = sum(len(s["categories"] or [None]) for s in TAXONOMY.values())
    return {
        "requirements": len(reqs),
        "counts": counts,
        "coverage": {"cells": total_cells, "gaps": gaps, "waived": waivers},
        "findings": findings,
        "ok": counts["error"] == 0,
    }


def to_markdown(rep: dict) -> str:
    lines = [f"# Requirement lint — {rep['requirements']} requirements",
             f"errors {rep['counts']['error']} · warnings {rep['counts']['warning']} · info {rep['counts']['info']}", ""]
    for f in rep["findings"]:
        ids = " ".join(f["ids"])
        lines.append(f"- **{f['severity']}** `{f['rule']}` {ids} — {f['message']}")
    return "\n".join(lines) + "\n"
