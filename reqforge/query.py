"""Query layer for large repositories: paginated/sorted listing, facet counts and the
requirement category tree (type -> category with coverage and lint health)."""
from __future__ import annotations

from collections import Counter

from . import lint
from .changes import links
from .model import TAXONOMY, normalize_kind
from .store import _keep, parse_query

FACETS = {
    "requirements": ["type", "category", "status", "priority", "tags"],
    "epics": ["status", "tags"],
    "stories": ["epic", "status", "deliverable", "component", "tags"],
    "tasks": ["kind", "status", "tags"],
}


def _annotate(kind: str, rec: dict, lk: dict) -> dict:
    if kind == "requirements":
        return {**rec, "_stories": len(lk["req_stories"].get(rec["id"], [])), "_children": len(lk["children"].get(rec["id"], []))}
    if kind == "stories":
        return {**rec, "_tasks": len(lk["story_tasks"].get(rec["id"], [])), "_evals": len(rec.get("evals") or [])}
    return rec


def _sort_key(field: str):
    def key(r):
        v = r.get(field)
        if isinstance(v, (int, float)):
            return (0, v, "")
        if isinstance(v, list):
            return (0, len(v), "")
        return (1, 0, str(v or "").lower())
    return key


def _covered_filter(kind: str, where: dict, lk: dict):
    """Pseudo-field `covered:yes|no` — requirements with / without a story."""
    want = where.pop("covered", None)
    if kind != "requirements" or want not in ("yes", "no"):
        return lambda r: True
    return lambda r: bool(lk["req_stories"].get(r["id"])) == (want == "yes")


def page(store, kind: str, q: str = "", where: dict | None = None, sort: str = "id", order: str = "asc",
         offset: int = 0, limit: int = 100) -> dict:
    kind = normalize_kind(kind)
    lk = links(store)
    words, w = parse_query(q, where)
    keep = _covered_filter(kind, w, lk)
    rows = [_annotate(kind, e[2], lk) for e in store._scan(kind).values() if _keep(e[2], e[3], words, w) and keep(e[2])]
    if sort and sort != "id":
        rows.sort(key=_sort_key(sort), reverse=order == "desc")
    elif order == "desc":
        rows.reverse()
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    return {"total": len(rows), "offset": offset, "limit": limit, "items": rows[offset:offset + limit]}


def facets(store, kind: str, q: str = "", where: dict | None = None) -> dict:
    """Counts per facet value. Each facet ignores its own filter (standard faceting), so
    you can see sibling values while drilling down."""
    kind = normalize_kind(kind)
    words, w = parse_query(q, where)
    keep = _covered_filter(kind, w, links(store))
    entries = list(store._scan(kind).values())
    text_rows = [(e[2], e[3]) for e in entries if _keep(e[2], e[3], words, {}) and keep(e[2])]
    out = {}
    for f in FACETS[kind]:
        others = {k: v for k, v in w.items() if k != f}
        c: Counter = Counter()
        for rec, blob in text_rows:
            if not _keep(rec, blob, [], others):
                continue
            v = rec.get(f)
            for x in (v if isinstance(v, list) else [v]):
                c[x if x not in (None, "") else "(none)"] += 1
        out[f] = dict(c.most_common(50 if f in ("tags", "category", "epic", "component") else None))
    if kind == "requirements":
        tree_where = {k: v for k, v in w.items() if k not in ("type", "category")}
        out["_tree"] = tree(store, [rec for rec, blob in text_rows if _keep(rec, blob, [], tree_where)])
    if kind == "stories":
        titles = {e["id"]: e.get("title") for e in store.all("epics")}
        out["_epic_titles"] = {k: titles.get(k, "") for k in out.get("epic", {})}
    return out


def tree(store, reqs: list[dict]) -> list[dict]:
    lk = links(store)
    lr = store.memo("lint", lambda: lint.lint(store))
    health: dict[str, Counter] = {}
    for f in lr["findings"]:
        for rid in f["ids"]:
            health.setdefault(rid, Counter())[f["severity"]] += 1
    waivers = store.config.get("coverage_waivers", {})
    nodes = []
    for t, spec in sorted(TAXONOMY.items(), key=lambda kv: kv[1]["order"]):
        cats: dict[str, dict] = {}
        for c in spec["categories"] or {}:
            cats[c] = {"category": c, "count": 0, "covered": 0, "errors": 0, "warnings": 0,
                       "waived": waivers.get(f"{t}/{c}") or waivers.get(t)}
        for r in reqs:
            if r.get("type") != t:
                continue
            c = r.get("category") or "(none)"
            node = cats.setdefault(c, {"category": c, "count": 0, "covered": 0, "errors": 0, "warnings": 0, "waived": None})
            node["count"] += 1
            node["covered"] += 1 if lk["req_stories"].get(r["id"]) else 0
            h = health.get(r["id"], {})
            node["errors"] += h.get("error", 0)
            node["warnings"] += h.get("warning", 0)
        cl = sorted(cats.values(), key=lambda n: (-n["count"], n["category"])) if spec["categories"] is None \
            else list(cats.values())
        nodes.append({"type": t, "count": sum(n["count"] for n in cl), "covered": sum(n["covered"] for n in cl),
                      "errors": sum(n["errors"] for n in cl), "warnings": sum(n["warnings"] for n in cl),
                      "categories": cl})
    return nodes


def lint_page(store, rule: str = "", severity: str = "", type_: str = "", category: str = "", q: str = "",
              offset: int = 0, limit: int = 100) -> dict:
    """Lint findings filtered by rule/severity/taxonomy cell/text, with per-rule counts — the
    full report can run to tens of thousands of findings on a large repository."""
    lr = store.memo("lint", lambda: lint.lint(store))
    cell = {r["id"]: (r.get("type"), r.get("category")) for r in store.all("requirements")}
    by_rule: dict[str, Counter] = {}
    items = []
    for f in lr["findings"]:
        if type_ or category:
            cells = [cell.get(i, (None, None)) for i in f["ids"]]
            if f["rule"] == "coverage-gap":
                gap = f["message"].split(" covers ", 1)[-1].split(";", 1)[0]
                cells = [tuple((gap.split("/") + [None])[:2])]
            if not any((not type_ or t == type_) and (not category or c == category) for t, c in cells):
                continue
        if q and q.lower() not in (f["message"] + " " + " ".join(f["ids"])).lower():
            continue
        by_rule.setdefault(f["rule"], Counter())[f["severity"]] += 1
        if (not rule or f["rule"] == rule) and (not severity or f["severity"] == severity):
            items.append(f)
    order = {"error": 0, "warning": 1, "info": 2}
    items.sort(key=lambda f: (order[f["severity"]], f["rule"], f["ids"]))
    limit = max(1, min(int(limit), 1000))
    return {"ok": lr["ok"], "requirements": lr["requirements"], "counts": lr["counts"], "coverage": lr["coverage"],
            "by_rule": {k: dict(v) for k, v in sorted(by_rule.items())}, "total": len(items),
            "offset": int(offset), "limit": limit, "items": items[int(offset):int(offset) + limit]}
