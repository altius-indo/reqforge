"""Seed a large synthetic repository to exercise the UI at scale:
`python3 examples/seed_large.py /tmp/reqforge-large 3000`.

Requirements are spread over every taxonomy cell, with parent/child hierarchies,
~70% story coverage, evals on stories, and a few deliberate near-duplicates so the
lint and category health indicators have something to show."""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reqforge.model import TAXONOMY  # noqa: E402
from reqforge.store import Store  # noqa: E402

root = sys.argv[1] if len(sys.argv) > 1 else "reqforge-large"
n = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
rnd = random.Random(7)

AREAS = ["checkout", "catalog", "accounts", "search", "orders", "notifications", "admin", "reporting",
         "billing", "shipping", "returns", "loyalty", "reviews", "inventory", "pricing"]
ACTORS = ["shopper", "guest", "admin", "support agent", "merchant", "finance analyst", "warehouse operator"]
VERBS = ["create", "view", "edit", "cancel", "export", "filter", "approve", "schedule", "archive", "share", "restore", "compare"]
OBJECTS = ["order", "invoice", "return request", "product listing", "coupon", "shipment", "refund", "wishlist",
           "review", "price rule", "stock alert", "loyalty reward", "saved search", "address", "payment method"]
QUALITY_TPL = {
    "functional-suitability": "The system shall compute {o} totals with zero rounding error across {k} currencies.",
    "performance-efficiency": "The system shall return the {o} {a} page within {ms} ms at p95 under {rps} rps.",
    "compatibility": "The system shall exchange {o} data with the {a} partner API using schema version {k}.",
    "interaction-capability": "The system shall meet WCAG 2.2 AA on the {a} {o} screens.",
    "reliability": "The system shall keep the {a} {o} service available {av}% per calendar month.",
    "security": "The system shall authorise every {a} {o} mutation against the caller's role (ASVS V4.{k}).",
    "maintainability": "The system shall keep {a} {o} module test coverage at or above {cov}%.",
    "flexibility": "The system shall scale the {a} {o} workers horizontally to {k}0 instances without code change.",
    "safety": "The system shall block {a} {o} actions that would ship hazardous goods to restricted regions.",
}
OTHER_TPL = {
    "constraint": "The system shall comply with {std} for all {a} {o} processing.",
    "interface": "The system shall expose {a} {o} operations through a versioned {proto} interface.",
    "data": "The system shall retain {a} {o} records for {k} years with lineage to their source.",
}
STDS = ["GDPR Art. 17", "PCI DSS v4.0 SAQ A", "SOC 2 CC6.1", "DPDP Act 2023 s.8", "CCPA 1798.105", "EN 301 549"]
PROTOS = ["REST/OpenAPI 3.1", "gRPC", "AsyncAPI event", "GraphQL", "webhook"]

s = Store.init(root, "BIG", f"Large synthetic shop ({n} requirements)")
s.config["autocommit"] = False
cells = [(t, c) for t, spec in TAXONOMY.items() for c in (spec["categories"] or AREAS)]
weights = [8 if t == "functional" else 3 if t == "quality" else 1 for t, _ in cells]
reqs = []
for i in range(1, n + 1):
    t, c = rnd.choices(cells, weights)[0]
    a, o = rnd.choice(AREAS), rnd.choice(OBJECTS)
    fill = dict(a=a, o=o, k=rnd.randint(2, 9), ms=rnd.choice([150, 200, 300, 500, 800]), rps=rnd.choice([50, 100, 200, 500]),
                av=rnd.choice(["99.5", "99.9", "99.95"]), cov=rnd.choice([70, 80, 90]), std=rnd.choice(STDS), proto=rnd.choice(PROTOS))
    if t == "functional":
        actor, verb = rnd.choice(ACTORS), rnd.choice(VERBS)
        stmt = f"The system shall let a {actor} {verb} a {o} from the {c} area."
        title = f"{actor.title()} can {verb} {o}"
    elif t == "quality":
        stmt, title = QUALITY_TPL[c].format(**fill), f"{c.replace('-', ' ').title()}: {a} {o}"
    else:
        stmt, title = OTHER_TPL[t].format(**fill), f"{c.title()} {a} {o}"
    rid = f"REQ-{i:04d}"
    rec = {"id": rid, "title": title, "statement": stmt, "type": t, "category": c,
           "priority": rnd.choices(["must", "should", "could", "wont"], [4, 4, 2, 1])[0],
           "status": rnd.choices(["draft", "proposed", "approved", "implemented"], [2, 3, 4, 1])[0],
           "tags": rnd.sample(["mvp", "v2", "pci", "gdpr", "mobile", "b2b", "perf", "a11y", "audit"], rnd.randint(0, 3)),
           "acceptance_criteria": [{"id": f"AC{j}", "text": f"Check {j} for {title.lower()}"} for j in range(1, rnd.randint(2, 4))],
           "rationale": "synthetic"}
    if reqs and rnd.random() < 0.25:
        parent = rnd.choice(reqs[-50:])
        if parent["type"] == t:
            rec["parent"] = parent["id"]
    s.create("requirements", rec)
    reqs.append(rec)
for i in range(min(40, n // 50)):  # deliberate near-duplicates for lint
    src = rnd.choice(reqs)
    dup = {**src, "id": f"REQ-{n + i + 1:04d}", "title": src["title"] + " (dup)", "parent": None}
    s.create("requirements", dup)

by_area: dict[str, list] = {}
for r in reqs:
    if r["status"] in ("proposed", "approved", "implemented") and rnd.random() < 0.75:
        area = r["category"] if r["type"] == "functional" else rnd.choice(AREAS)
        by_area.setdefault(area, []).append(r)
eid = sid = tid = 0
for area, rs in by_area.items():
    eid += 1
    epic = f"EPIC-{eid:04d}"
    s.create("epics", {"id": epic, "title": f"{area.title()} capability", "requirements": [r["id"] for r in rs[:50]]})
    for chunk in range(0, len(rs), 4):
        sid += 1
        story = f"STORY-{sid:04d}"
        group = rs[chunk:chunk + 4]
        evals = [{"id": f"E{k + 1}", "name": f"verify {r['id']}",
                  "kind": {"performance-efficiency": "performance", "security": "security",
                           "interaction-capability": "accessibility"}.get(r["category"], "unit"),
                  "command": f"pytest tests/{area}/test_{r['id'].lower().replace('-', '_')}.py -q",
                  "covers": [f"{r['id']}#{ac['id']}" for ac in r["acceptance_criteria"]]}
                 for k, r in enumerate(group) if rnd.random() < 0.8]
        s.create("stories", {"id": story, "epic": epic, "title": f"{area.title()} increment {chunk // 4 + 1}",
                             "requirements": [r["id"] for r in group], "component": f"{area}-service",
                             "status": rnd.choice(["todo", "todo", "in-progress", "done"]), "evals": evals})
        for kind in rnd.sample(["design", "code", "deployment", "monitoring"], rnd.randint(1, 4)):
            tid += 1
            s.create("tasks", {"id": f"TASK-{tid:04d}", "story": story, "kind": kind, "title": f"{kind} for {story}"})
s.config["autocommit"] = True
s.save_config({"autocommit": True, "components": {}})
print(f"seeded {root}: {len(reqs)} requirements, {eid} epics, {sid} stories, {tid} tasks")
