"""Domain model: record kinds, the MECE requirement taxonomy, field schemas, validation.

Everything here is pure data + pure functions so the CLI, REST API, MCP server and
UI all share one definition of what a valid record is.
"""
from __future__ import annotations

import re

# --------------------------------------------------------------------------- kinds

KINDS = {
    "requirements": {"prefix": "REQ", "dir": "requirements"},
    "epics": {"prefix": "EPIC", "dir": "epics"},
    "stories": {"prefix": "STORY", "dir": "stories"},
    "tasks": {"prefix": "TASK", "dir": "tasks"},
}

ALIASES = {
    "req": "requirements", "reqs": "requirements", "requirement": "requirements",
    "epic": "epics", "story": "stories", "task": "tasks",
}


def normalize_kind(kind: str) -> str:
    k = kind.strip().lower()
    k = ALIASES.get(k, k)
    if k not in KINDS:
        raise ValueError(f"unknown kind '{kind}' (expected one of {', '.join(KINDS)})")
    return k


def kind_of_id(rid: str) -> str:
    prefix = rid.split("-", 1)[0].upper()
    for kind, meta in KINDS.items():
        if meta["prefix"] == prefix:
            return kind
    raise ValueError(f"cannot infer kind from id '{rid}'")


# ------------------------------------------------------------------------ taxonomy
# Mutual exclusivity comes from a decision ORDER: a requirement takes the FIRST type
# whose test it passes. Collective exhaustiveness comes from functional being the
# catch-all plus the coverage check in lint.py (every category is either populated
# or explicitly waived in reqforge.json).

TAXONOMY = {
    "constraint": {
        "order": 1,
        "test": "Is it imposed from outside the solution space and non-negotiable (law, contract, mandated technology, budget, physical environment)?",
        "categories": {
            "regulatory": "Laws, regulations, certifications (GDPR, HIPAA, PCI DSS, SOC 2, accessibility law).",
            "technology": "Mandated platforms, languages, vendors, licences.",
            "business": "Budget, schedule, organisational policy, contractual terms.",
            "environment": "Physical/operational environment the system must run in.",
        },
    },
    "interface": {
        "order": 2,
        "test": "Does it specify a boundary the system exposes or consumes (UI, API, protocol, external system, device)?",
        "categories": {
            "user-interface": "Screens, interaction flows, channels, localisation.",
            "api": "Programmatic interfaces the system exposes.",
            "integration": "External systems / third-party services consumed.",
            "hardware": "Devices, sensors, physical I/O.",
        },
    },
    "data": {
        "order": 3,
        "test": "Is it about information the system stores: its structure, lifecycle, quality or migration?",
        "categories": {
            "model": "Entities, attributes, relationships, identifiers.",
            "lifecycle": "Creation, retention, archival, deletion of data.",
            "quality": "Accuracy, completeness, consistency, lineage.",
            "migration": "Moving/transforming existing data.",
        },
    },
    "quality": {
        "order": 4,
        "test": "Does it say HOW WELL the system must do something (measurable characteristic)? Categories = ISO/IEC 25010:2023.",
        "categories": {
            "functional-suitability": "Completeness, correctness, appropriateness of functions.",
            "performance-efficiency": "Time behaviour, resource utilisation, capacity.",
            "compatibility": "Co-existence, interoperability.",
            "interaction-capability": "Usability: learnability, operability, accessibility, error protection.",
            "reliability": "Availability, fault tolerance, recoverability.",
            "security": "Confidentiality, integrity, non-repudiation, accountability, authenticity.",
            "maintainability": "Modularity, analysability, modifiability, testability.",
            "flexibility": "Adaptability, scalability, installability, replaceability.",
            "safety": "Operational constraint, risk identification, fail-safe, hazard warning.",
        },
    },
    "functional": {
        "order": 5,
        "test": "Otherwise: it states WHAT the system does (a behaviour or capability). Category = capability area.",
        "categories": None,  # free-form capability area, e.g. "billing", "onboarding"
    },
}

PRIORITIES = ["must", "should", "could", "wont"]  # MoSCoW
REQ_STATUSES = ["draft", "proposed", "approved", "implemented", "verified", "deprecated"]
WORK_STATUSES = ["todo", "in-progress", "blocked", "done"]
STORY_DELIVERABLES = ["code", "design", "infrastructure", "documentation"]
TASK_KINDS = ["design", "code", "deployment", "monitoring"]

# Eval kind -> pipeline stage. Stage order is the CI/CD order.
EVAL_KINDS = {
    "static": "commit",
    "unit": "commit",
    "contract": "commit",
    "integration": "acceptance",
    "e2e": "acceptance",
    "accessibility": "acceptance",
    "llm-judge": "acceptance",
    "security": "security",
    "performance": "performance",
    "smoke": "post-deploy",
    "synthetic-monitor": "monitor",
}
STAGES = ["commit", "acceptance", "security", "performance", "post-deploy", "monitor"]

# Quality categories whose requirements must be verified by an eval of a matching kind.
QUALITY_EVAL_MATCH = {
    "performance-efficiency": {"performance"},
    "security": {"security"},
    "interaction-capability": {"accessibility", "e2e"},
    "reliability": {"integration", "e2e", "synthetic-monitor", "smoke"},
}

# Vague terms ISO/IEC/IEEE 29148 calls out as unverifiable.
VAGUE_TERMS = [
    "user-friendly", "user friendly", "easy", "simple", "fast", "quick", "efficient",
    "robust", "flexible", "seamless", "intuitive", "adequate", "as appropriate",
    "as needed", "etc", "and/or", "minimal", "maximize", "minimize", "state-of-the-art",
    "scalable", "best", "support",
]

# --------------------------------------------------------------------------- schema
# field -> (type, options). type in: str, text, enum, list, ref, reflist, objlist, int, bool

SCHEMAS: dict[str, dict[str, tuple]] = {
    "requirements": {
        "title": ("str", {"required": True}),
        "statement": ("text", {"required": True}),
        "type": ("enum", {"required": True, "values": list(TAXONOMY)}),
        "category": ("str", {"required": True}),
        "priority": ("enum", {"values": PRIORITIES, "default": "should"}),
        "status": ("enum", {"values": REQ_STATUSES, "default": "draft"}),
        "rationale": ("text", {}),
        "acceptance_criteria": ("objlist", {"keys": ["id", "text"]}),
        "parent": ("ref", {"kind": "requirements"}),
        "tags": ("list", {}),
        "standards": ("list", {}),
        "stakeholders": ("list", {}),
        "source": ("str", {}),
        "notes": ("text", {}),
    },
    "epics": {
        "title": ("str", {"required": True}),
        "description": ("text", {}),
        "requirements": ("reflist", {"kind": "requirements"}),
        "status": ("enum", {"values": WORK_STATUSES, "default": "todo"}),
        "tags": ("list", {}),
    },
    "stories": {
        "title": ("str", {"required": True}),
        "epic": ("ref", {"kind": "epics", "required": True}),
        "narrative": ("text", {}),
        "requirements": ("reflist", {"kind": "requirements"}),
        "deliverable": ("enum", {"values": STORY_DELIVERABLES, "default": "code"}),
        "component": ("str", {}),
        "acceptance_criteria": ("objlist", {"keys": ["id", "text"]}),
        "evals": ("objlist", {"keys": ["id", "name", "kind", "command"]}),
        "status": ("enum", {"values": WORK_STATUSES, "default": "todo"}),
        "points": ("int", {}),
        "tags": ("list", {}),
    },
    "tasks": {
        "title": ("str", {"required": True}),
        "story": ("ref", {"kind": "stories", "required": True}),
        "kind": ("enum", {"values": TASK_KINDS, "required": True}),
        "description": ("text", {}),
        "done_when": ("text", {}),
        "status": ("enum", {"values": WORK_STATUSES, "default": "todo"}),
        "estimate": ("str", {}),
        "tags": ("list", {}),
    },
}

SYSTEM_FIELDS = ("id", "version", "created", "updated")
ID_RE = re.compile(r"^(REQ|EPIC|STORY|TASK)-\d{4,}$")


def defaults(kind: str) -> dict:
    out = {}
    for field, (ftype, opts) in SCHEMAS[kind].items():
        if "default" in opts:
            out[field] = opts["default"]
        elif ftype in ("list", "reflist", "objlist"):
            out[field] = []
    return out


def coerce(kind: str, field: str, value):
    """Coerce a CLI/form string value into the field's type. Unknown fields pass through."""
    spec = SCHEMAS[kind].get(field)
    if spec is None or not isinstance(value, str):
        return value
    ftype = spec[0]
    if ftype in ("list", "reflist"):
        return [v.strip() for v in value.split(",") if v.strip()]
    if ftype == "int":
        return int(value) if value.strip() else None
    if ftype == "bool":
        return value.strip().lower() in ("1", "true", "yes", "y")
    if ftype == "ref":
        return value.strip() or None
    return value


def validate(kind: str, rec: dict, exists=None) -> list[str]:
    """Return a list of hard errors. `exists(kind, id)` checks referential integrity."""
    errors: list[str] = []
    schema = SCHEMAS[kind]
    for field, (ftype, opts) in schema.items():
        val = rec.get(field)
        empty = val is None or val == "" or val == []
        if opts.get("required") and empty:
            errors.append(f"{field}: required")
            continue
        if empty:
            continue
        if ftype in ("str", "text") and not isinstance(val, str):
            errors.append(f"{field}: must be a string")
        elif ftype == "enum" and val not in opts["values"]:
            errors.append(f"{field}: '{val}' not in {opts['values']}")
        elif ftype == "int" and not isinstance(val, int):
            errors.append(f"{field}: must be an integer")
        elif ftype in ("list", "reflist") and not (isinstance(val, list) and all(isinstance(v, str) for v in val)):
            errors.append(f"{field}: must be a list of strings")
        elif ftype == "objlist":
            if not isinstance(val, list) or not all(isinstance(v, dict) for v in val):
                errors.append(f"{field}: must be a list of objects")
            else:
                for i, item in enumerate(val):
                    for key in opts["keys"]:
                        if key == "command":
                            continue  # commands may be filled in later; trace reports it
                        if not item.get(key):
                            errors.append(f"{field}[{i}].{key}: required")
        if exists and ftype == "ref" and not exists(opts["kind"], val):
            errors.append(f"{field}: {val} does not exist")
        if exists and ftype == "reflist":
            for ref in val if isinstance(val, list) else []:
                if not exists(opts["kind"], ref):
                    errors.append(f"{field}: {ref} does not exist")

    if kind == "requirements" and rec.get("type") in TAXONOMY:
        cats = TAXONOMY[rec["type"]]["categories"]
        if cats is not None and rec.get("category") and rec["category"] not in cats:
            errors.append(f"category: '{rec['category']}' not valid for type '{rec['type']}' (expected one of {list(cats)})")
    if kind == "stories":
        for i, ev in enumerate(rec.get("evals") or []):
            if isinstance(ev, dict) and ev.get("kind") and ev["kind"] not in EVAL_KINDS:
                errors.append(f"evals[{i}].kind: '{ev['kind']}' not in {list(EVAL_KINDS)}")
    return errors
