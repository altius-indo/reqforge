"""Change sets: reviewable, atomic batches of create/update/delete ops across any kind.

This is how the chat agent changes the repository. It can only SIMULATE and PROPOSE;
a human applies. Simulation runs the ops on an in-memory overlay and reports
validation errors, dangling references, the lint (MECE) delta, the traceability delta
and the blast radius (stories, tasks, evals, components). Apply re-checks that nothing
it touches changed since the proposal, then writes everything as one git commit.

Changeset shape:
  {"title": str, "summary": str, "rationale": str,
   "ops": [
     {"op": "create", "kind": "requirements", "ref": "r1", "data": {...}, "reason": str},
     {"op": "update", "id": "REQ-0007", "patch": {...}, "add": {"tags": [..]}, "remove": {...}, "reason": str},
     {"op": "delete", "id": "REQ-0009", "reason": str}],
   "impact": {"stories": str, "code": str, "evals": str, "risks": [str]}}   # agent's narrative
Later ops may reference ids created earlier as "$r1" (also inside strings, e.g. "$r1#AC1").
"""
from __future__ import annotations

import copy
import datetime as _dt
import json
import re

from . import lint, trace
from .model import KINDS, SCHEMAS, SYSTEM_FIELDS, coerce, defaults, kind_of_id, normalize_kind, validate
from .store import StoreError, _dump

REF_RE = re.compile(r"\$([A-Za-z][A-Za-z0-9_-]*)")
STATUSES = ("pending", "applied", "rejected", "stale")


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


class View:
    """Read-only, store-shaped view over in-memory records (what lint/trace need)."""

    def __init__(self, config: dict, recs: dict[str, dict[str, dict]]):
        self.config = config
        self.recs = recs

    def all(self, kind: str) -> list[dict]:
        return [self.recs[normalize_kind(kind)][k] for k in sorted(self.recs[normalize_kind(kind)])]

    def exists(self, kind: str, rid: str) -> bool:
        return rid in self.recs[normalize_kind(kind)]


def base_view(store) -> View:
    return View(store.config, {k: {r["id"]: r for r in store.all(k)} for k in KINDS})


def _resolve(obj, refmap: dict):
    if isinstance(obj, str):
        return REF_RE.sub(lambda m: refmap.get(m.group(1), m.group(0)), obj)
    if isinstance(obj, list):
        return [_resolve(x, refmap) for x in obj]
    if isinstance(obj, dict):
        return {k: _resolve(v, refmap) for k, v in obj.items()}
    return obj


def _dangling(view: View) -> set[str]:
    out = set()
    for kind in KINDS:
        for rec in view.recs[kind].values():
            for field, (ftype, opts) in SCHEMAS[kind].items():
                v = rec.get(field)
                refs = [v] if ftype == "ref" and v else (v or []) if ftype == "reflist" else []
                for ref in refs:
                    if not view.exists(opts["kind"], ref):
                        out.add(f"{rec['id']}.{field} -> {ref}")
    return out


def materialize(store, ops: list[dict]) -> dict:
    base = base_view(store)
    recs = {k: dict(v) for k, v in base.recs.items()}
    nexts = {}
    for k in KINDS:
        nums = [int(m.group(1)) for rid in recs[k] if (m := re.match(r"[A-Z]+-(\d+)$", rid))]
        nexts[k] = max(nums, default=0) + 1
    refmap, errors, resolved = {}, [], []
    now = _now()
    for i, op in enumerate(ops):
        kind_op = op.get("op")
        try:
            if kind_op == "create":
                kind = normalize_kind(op["kind"])
                rid = f"{KINDS[kind]['prefix']}-{nexts[kind]:04d}"
                nexts[kind] += 1
                if op.get("ref"):
                    refmap[op["ref"]] = rid
                data = _resolve(op.get("data") or {}, refmap)
                rec = {"id": rid, **defaults(kind),
                       **{k: coerce(kind, k, v) for k, v in data.items() if k not in SYSTEM_FIELDS},
                       "version": 1, "created": now, "updated": now}
                recs[kind][rid] = rec
                resolved.append({"i": i, "op": "create", "kind": kind, "id": rid, "ref": op.get("ref"),
                                 "title": rec.get("title"), "reason": op.get("reason"), "data": rec})
            elif kind_op in ("update", "delete"):
                rid = _resolve(op["id"], refmap)
                kind = kind_of_id(rid)
                cur = recs[kind].get(rid)
                if cur is None:
                    raise ValueError(f"{rid} does not exist")
                if kind_op == "delete":
                    del recs[kind][rid]
                    resolved.append({"i": i, "op": "delete", "kind": kind, "id": rid, "title": cur.get("title"),
                                     "reason": op.get("reason"), "base_version": base.recs[kind].get(rid, {}).get("version")})
                    continue
                rec, changes = dict(cur), {}
                for k, v in _resolve(op.get("patch") or {}, refmap).items():
                    if k in SYSTEM_FIELDS:
                        continue
                    rec[k] = coerce(kind, k, v)
                for k, vals in _resolve(op.get("add") or {}, refmap).items():
                    rec[k] = list(dict.fromkeys([*(rec.get(k) or []), *(vals if isinstance(vals, list) else [vals])]))
                for k, vals in _resolve(op.get("remove") or {}, refmap).items():
                    drop = set(vals if isinstance(vals, list) else [vals])
                    rec[k] = [x for x in rec.get(k) or [] if x not in drop]
                for k in rec:
                    if k not in SYSTEM_FIELDS and rec.get(k) != cur.get(k):
                        changes[k] = [cur.get(k), rec.get(k)]
                rec["version"] = cur.get("version", 0) + 1
                rec["updated"] = now
                recs[kind][rid] = rec
                resolved.append({"i": i, "op": "update", "kind": kind, "id": rid, "title": rec.get("title"),
                                 "reason": op.get("reason"), "changes": changes,
                                 "base_version": base.recs[kind].get(rid, {}).get("version")})
            else:
                raise ValueError(f"unknown op '{kind_op}' (expected create, update or delete)")
        except (KeyError, ValueError) as e:
            errors.append(f"op {i} ({kind_op}): {e}")
    view = View(store.config, recs)
    for r in resolved:
        if r["op"] != "delete" and r["id"] in recs[r["kind"]]:
            for e in validate(r["kind"], recs[r["kind"]][r["id"]], exists=view.exists):
                errors.append(f"{r['id']}: {e}")
    for d in sorted(_dangling(view) - _dangling(base)):
        errors.append(f"dangling reference {d} (remap or delete the referencing record in this changeset)")
    return {"view": view, "base": base, "ops": resolved, "errors": errors, "refmap": refmap}


def blast_radius(views: list[View], ids: set[str]) -> dict:
    reqs = {i for i in ids if i.startswith("REQ-")}
    stories_touched = {i for i in ids if i.startswith("STORY-")}
    out = {"requirements": set(), "children": set(), "stories": {}, "tasks": {}, "evals": {}, "components": set()}
    for v in views:
        for r in v.all("requirements"):
            if r.get("parent") in reqs:
                out["children"].add(r["id"])
        for s in v.all("stories"):
            linked = set(s.get("requirements") or []) & reqs
            if linked or s["id"] in stories_touched:
                out["stories"][s["id"]] = {"id": s["id"], "title": s.get("title"), "status": s.get("status"),
                                           "component": s.get("component"), "via": sorted(linked)}
                if s.get("component"):
                    out["components"].add(s["component"])
                for ev in s.get("evals") or []:
                    if s["id"] in stories_touched or any(c.split("#")[0] in reqs for c in ev.get("covers") or []):
                        out["evals"][f"{s['id']}/{ev.get('id')}"] = {"story": s["id"], "id": ev.get("id"),
                                                                     "name": ev.get("name"), "kind": ev.get("kind"),
                                                                     "command": ev.get("command"), "covers": ev.get("covers") or []}
        for t in v.all("tasks"):
            if t.get("story") in out["stories"]:
                out["tasks"][t["id"]] = {"id": t["id"], "title": t.get("title"), "kind": t.get("kind"),
                                         "status": t.get("status"), "story": t.get("story")}
    out["requirements"] = reqs
    return {"requirements": sorted(out["requirements"]), "children": sorted(out["children"]),
            "stories": list(out["stories"].values()), "tasks": list(out["tasks"].values()),
            "evals": list(out["evals"].values()), "components": sorted(out["components"]),
            "in_progress_work": [t["id"] for t in out["tasks"].values() if t["status"] in ("in-progress", "done")]
                                + [s["id"] for s in out["stories"].values() if s["status"] in ("in-progress", "done")]}


def _lint_key(f):
    return (f["rule"], tuple(f["ids"]), f["message"])


def simulate(store, cs: dict) -> dict:
    m = materialize(store, cs.get("ops") or [])
    before_l = store.memo("lint", lambda: lint.lint(store))
    before_t = store.memo("trace", lambda: trace.evaluate(store))
    after_l, after_t = lint.lint(m["view"]), trace.evaluate(m["view"])
    bl = {_lint_key(f): f for f in before_l["findings"] if f["severity"] != "info"}
    al = {_lint_key(f): f for f in after_l["findings"] if f["severity"] != "info"}
    bchk = {c["id"]: c for c in before_t["checks"]}
    tdelta = []
    for c in after_t["checks"]:
        old = set(bchk.get(c["id"], {}).get("failures", []))
        new = set(c["failures"])
        if old != new:
            tdelta.append({"check": c["id"], "name": c["name"], "severity": c["severity"],
                           "new_failures": sorted(new - old), "fixed": sorted(old - new)})
    touched = {r["id"] for r in m["ops"]}
    new_lint = [al[k] for k in al if k not in bl]
    return {
        "valid": not m["errors"],
        "errors": m["errors"],
        "ops": [{k: v for k, v in r.items() if k != "data"} | ({"data": _brief(r["data"])} if r["op"] == "create" else {})
                for r in m["ops"]],
        "refmap": m["refmap"],
        "lint": {"before": before_l["counts"], "after": after_l["counts"],
                 "new": new_lint, "resolved": [bl[k] for k in bl if k not in al],
                 "gaps_before": len(before_l["coverage"]["gaps"]), "gaps_after": len(after_l["coverage"]["gaps"]),
                 # any new overlap breaks mutual exclusivity; a new gap breaks exhaustiveness
                 "mece_ok": not any(f["severity"] == "error" or f["rule"] in ("overlap", "coverage-gap") for f in new_lint)},
        "trace": {"ok_before": before_t["ok"], "ok_after": after_t["ok"],
                  "metrics_before": before_t["metrics"], "metrics_after": after_t["metrics"], "delta": tdelta},
        "impact": blast_radius([m["base"], m["view"]], touched),
    }


def _brief(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k not in ("created", "updated", "version") and v not in (None, "", [])}


# ------------------------------------------------------------------- persistence

def _dir(store):
    d = store.root / "changesets"
    d.mkdir(exist_ok=True)
    return d


def get(store, cs_id: str) -> dict:
    p = _dir(store) / f"{cs_id}.json"
    if not p.exists():
        raise StoreError(f"{cs_id} not found", 404)
    return json.loads(p.read_text())


def list_(store, status: str | None = None) -> list[dict]:
    out = []
    for p in sorted(_dir(store).glob("CS-*.json"), reverse=True):
        cs = json.loads(p.read_text())
        if status and cs.get("status") != status:
            continue
        out.append({k: cs.get(k) for k in ("id", "title", "status", "created", "applied_at", "valid")}
                   | {"ops": len(cs.get("ops", []))})
    return out


def _save(store, cs: dict) -> None:
    (_dir(store) / f"{cs['id']}.json").write_text(_dump(cs))


def propose(store, cs: dict) -> dict:
    if not cs.get("ops"):
        raise StoreError("changeset has no ops", 422)
    sim = simulate(store, cs)
    with store._locked():
        nums = [int(m.group(1)) for p in _dir(store).glob("CS-*.json") if (m := re.match(r"CS-(\d+)", p.stem))]
        cs_id = f"CS-{(max(nums, default=0) + 1):04d}"
        rec = {"id": cs_id, "title": cs.get("title") or "untitled change", "summary": cs.get("summary", ""),
               "rationale": cs.get("rationale", ""), "status": "pending", "created": _now(), "valid": sim["valid"],
               "ops": cs["ops"], "impact_notes": cs.get("impact") or {},
               "base_versions": {r["id"]: r["base_version"] for r in sim["ops"] if r.get("base_version")},
               "analysis": sim}
        _save(store, rec)
        store._commit(f"{cs_id}: proposed — {rec['title']}")
    return {"changeset_id": cs_id, "valid": sim["valid"], "errors": sim["errors"],
            "mece_ok": sim["lint"]["mece_ok"], "new_lint_findings": len(sim["lint"]["new"]),
            "trace_ok_after": sim["trace"]["ok_after"],
            "impact": {k: len(v) for k, v in sim["impact"].items()},
            "note": "Shown to the user as a card with Apply/Reject. Nothing is written until they apply."}


def apply(store, cs_id: str, exclude: list[int] | None = None) -> dict:
    exclude = set(exclude or [])
    with store._locked():
        cs = get(store, cs_id)
        if cs["status"] != "pending":
            raise StoreError(f"{cs_id} is {cs['status']}, not pending", 409)
        stale = []
        for rid, ver in cs.get("base_versions", {}).items():
            try:
                cur = store.get(kind_of_id(rid), rid)
            except StoreError:
                stale.append(f"{rid} was deleted")
                continue
            if cur.get("version") != ver:
                stale.append(f"{rid} changed (v{ver} -> v{cur.get('version')})")
        if stale:
            cs["status"] = "stale"
            cs["stale_reasons"] = stale
            _save(store, cs)
            store._commit(f"{cs_id}: stale")
            raise StoreError(f"{cs_id} is stale; ask the agent to re-propose", 409, stale)
        ops = [op for i, op in enumerate(cs["ops"]) if i not in exclude]
        m = materialize(store, ops)
        if m["errors"]:
            raise StoreError(f"{cs_id} no longer applies cleanly", 422, m["errors"])
        autocommit = store.config.get("autocommit", True)
        store.config["autocommit"] = False
        try:
            for kind, rid in {(r["kind"], r["id"]) for r in m["ops"]}:
                path = store._path(kind, rid)
                if rid in m["view"].recs[kind]:
                    store._write(kind, copy.deepcopy(m["view"].recs[kind][rid]))
                elif path.exists():
                    path.unlink()
        finally:
            store.config["autocommit"] = autocommit
        cs.update({"status": "applied", "applied_at": _now(), "excluded_ops": sorted(exclude), "assigned_ids": m["refmap"]})
        _save(store, cs)
        store._commit(f"{cs_id}: apply — {cs['title']}")
    t = trace.evaluate(store)
    lr = lint.lint(store)
    return {"changeset_id": cs_id, "status": "applied", "assigned_ids": m["refmap"],
            "written": sorted({r["id"] for r in m["ops"]}),
            "lint": lr["counts"], "trace_ok": t["ok"], "trace_metrics": t["metrics"],
            "failing_checks": [{"check": c["id"], "failures": c["failures"][:20]} for c in t["checks"] if not c["passed"]]}


def reject(store, cs_id: str, reason: str = "") -> dict:
    with store._locked():
        cs = get(store, cs_id)
        if cs["status"] != "pending":
            raise StoreError(f"{cs_id} is {cs['status']}, not pending", 409)
        cs.update({"status": "rejected", "rejected_reason": reason, "rejected_at": _now()})
        _save(store, cs)
        store._commit(f"{cs_id}: rejected")
    return {"changeset_id": cs_id, "status": "rejected"}


# ------------------------------------------------------------------- context

def links(store) -> dict:
    """Memoised link maps used by list annotations, facets and record context."""
    def build():
        req_stories, children, story_tasks = {}, {}, {}
        for s in store.all("stories"):
            for rid in s.get("requirements") or []:
                req_stories.setdefault(rid, []).append(s["id"])
        for r in store.all("requirements"):
            if r.get("parent"):
                children.setdefault(r["parent"], []).append(r["id"])
        for t in store.all("tasks"):
            story_tasks.setdefault(t.get("story"), []).append(t["id"])
        return {"req_stories": req_stories, "children": children, "story_tasks": story_tasks}
    return store.memo("links", build)


def context(store, rid: str) -> dict:
    kind = kind_of_id(rid)
    rec = store.get(kind, rid)
    out = {"record": rec, "referenced_by": store.references_to(rid)}
    if kind == "requirements":
        lk = links(store)
        out["parent"] = rec.get("parent")
        out["children"] = [{"id": c, "title": store.get("requirements", c).get("title")} for c in lk["children"].get(rid, [])]
        out["impact"] = blast_radius([base_view(store)], {rid})
        lr = store.memo("lint", lambda: lint.lint(store))
        out["lint"] = [f for f in lr["findings"] if rid in f["ids"]]
    return out
