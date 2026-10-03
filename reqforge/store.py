"""File-backed record store. One JSON file per record, laid out for clean git diffs.

<repo>/
  reqforge.json            project config (key, gates, coverage waivers, cicd)
  requirements/REQ-0001.json
  epics/EPIC-0001.json
  stories/STORY-0001.json
  tasks/TASK-0001.json
  sessions/ELI-0001.md     elicitation transcripts (research, Q&A, decisions)
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import fcntl
import json
import os
import re
import threading
from pathlib import Path

from . import gitsync
from .model import KINDS, SCHEMAS, SYSTEM_FIELDS, coerce, defaults, normalize_kind, validate

CONFIG_FILE = "reqforge.json"

DEFAULT_CONFIG = {
    "key": "PROJ",
    "name": "Untitled project",
    "autocommit": True,
    "gates": {
        "min_requirement_coverage": 1.0,   # share of active requirements mapped to >=1 story
        "min_criteria_coverage": 0.8,      # share of acceptance criteria covered by an eval
        "require_evals_for_code": True,
    },
    # Taxonomy cells deliberately left empty, with the reason. Keeps "collectively
    # exhaustive" honest: an empty cell must be populated or waived, never ignored.
    "coverage_waivers": {},
    "cicd": {
        "requirements_repo": "",          # owner/name if requirements live outside the code repo
        "python": "3.12",
        "setup_steps": [],
        "deploy_command": "",
        "monitor_cron": "*/30 * * * *",
    },
}


class StoreError(Exception):
    def __init__(self, message: str, status: int = 400, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or []


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _dump(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


class Store:
    _thread_lock = threading.RLock()

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root).resolve()
        cfg = self.root / CONFIG_FILE
        if not cfg.exists():
            raise StoreError(f"{self.root} is not a reqforge repository (no {CONFIG_FILE}); run `reqforge init`", 404)
        self.config = {**DEFAULT_CONFIG, **json.loads(cfg.read_text())}

    # ---------------------------------------------------------------- lifecycle
    @classmethod
    def discover(cls, start: str | None = None) -> "Store":
        env = os.environ.get("REQFORGE_REPO")
        if env:
            return cls(env)
        here = Path(start or os.getcwd()).resolve()
        for d in [here, *here.parents]:
            if (d / CONFIG_FILE).exists():
                return cls(d)
            if (d / ".reqforge-repo").exists():  # pointer file: path to the requirements repo
                return cls((d / (d / ".reqforge-repo").read_text().strip()).resolve())
        raise StoreError("no reqforge repository found (set REQFORGE_REPO or run `reqforge init`)", 404)

    @classmethod
    def init(cls, root, key: str, name: str, github: str | None = None, private: bool = True) -> "Store":
        root = Path(root).resolve()
        root.mkdir(parents=True, exist_ok=True)
        if not (root / CONFIG_FILE).exists():
            cfg = json.loads(json.dumps(DEFAULT_CONFIG))
            cfg.update({"key": key.upper(), "name": name})
            (root / CONFIG_FILE).write_text(_dump(cfg))
        for meta in KINDS.values():
            (root / meta["dir"]).mkdir(exist_ok=True)
            (root / meta["dir"] / ".gitkeep").touch()
        (root / "sessions").mkdir(exist_ok=True)
        (root / "sessions" / ".gitkeep").touch()
        readme = root / "README.md"
        if not readme.exists():
            readme.write_text(
                f"# {name} — requirements\n\nManaged by reqforge. Edit with `reqforge serve` (UI), "
                "`reqforge console`, the CLI, or the REST API. Records are JSON; one file per record.\n"
            )
        gitsync.ensure_repo(root)
        gitsync.commit_all(root, "reqforge: initialise requirements repository")
        if github:
            gitsync.create_remote(root, github, private=private)
        return cls(root)

    def save_config(self, patch: dict) -> dict:
        with self._locked():
            cfg = {**self.config, **patch}
            (self.root / CONFIG_FILE).write_text(_dump(cfg))
            self.config = cfg
            self._commit(f"reqforge: update config ({', '.join(patch)})")
        return cfg

    # ---------------------------------------------------------------- internals
    @contextlib.contextmanager
    def _locked(self):
        """Reentrant: thread lock + one cross-process flock held at the outermost level."""
        with self._thread_lock:
            depth = getattr(self, "_lock_depth", 0)
            self._lock_depth = depth + 1
            try:
                if depth:
                    yield
                    return
                with open(self.root / ".reqforge.lock", "w") as fh:
                    fcntl.flock(fh, fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(fh, fcntl.LOCK_UN)
            finally:
                self._lock_depth = depth

    def _path(self, kind: str, rid: str) -> Path:
        return self.root / KINDS[kind]["dir"] / f"{rid}.json"

    def _next_id(self, kind: str) -> str:
        prefix = KINDS[kind]["prefix"]
        nums = [int(m.group(1)) for p in (self.root / KINDS[kind]["dir"]).glob(f"{prefix}-*.json")
                if (m := re.match(rf"{prefix}-(\d+)$", p.stem))]
        return f"{prefix}-{(max(nums) + 1 if nums else 1):04d}"

    def _write(self, kind: str, rec: dict) -> None:
        ordered = {k: rec[k] for k in ("id", *SCHEMAS[kind]) if k in rec}
        ordered.update({k: v for k, v in rec.items() if k not in ordered})
        path = self._path(kind, rec["id"])
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(_dump(ordered))
        tmp.replace(path)

    def _commit(self, message: str) -> None:
        if self.config.get("autocommit", True):
            gitsync.commit_all(self.root, message)

    def exists(self, kind: str, rid: str) -> bool:
        return self._path(normalize_kind(kind), rid).exists()

    def _check(self, kind: str, rec: dict) -> None:
        errors = validate(kind, rec, exists=self.exists)
        if errors:
            raise StoreError(f"invalid {kind[:-1]} {rec.get('id', '')}".strip(), 422, errors)

    # ---------------------------------------------------------------- reads
    def all(self, kind: str) -> list[dict]:
        kind = normalize_kind(kind)
        out = []
        for p in sorted((self.root / KINDS[kind]["dir"]).glob("*.json")):
            out.append(json.loads(p.read_text()))
        return out

    def get(self, kind: str, rid: str) -> dict:
        kind = normalize_kind(kind)
        p = self._path(kind, rid)
        if not p.exists():
            raise StoreError(f"{rid} not found", 404)
        return json.loads(p.read_text())

    def search(self, kind: str, q: str = "", where: dict | None = None) -> list[dict]:
        """Free-text search. Tokens of the form field:value (or field:a|b) filter exactly;
        other tokens must each appear (case-insensitive) somewhere in the record."""
        kind = normalize_kind(kind)
        where = dict(where or {})
        words = []
        for tok in (q or "").split():
            if ":" in tok and not tok.startswith("http"):
                f, v = tok.split(":", 1)
                where[f] = v
            else:
                words.append(tok.lower())
        out = []
        for rec in self.all(kind):
            if not all(_match(rec.get(f), v) for f, v in where.items()):
                continue
            blob = json.dumps(rec, ensure_ascii=False).lower()
            if all(w in blob for w in words):
                out.append(rec)
        return out

    # ---------------------------------------------------------------- writes
    def create(self, kind: str, data: dict, message: str | None = None) -> dict:
        kind = normalize_kind(kind)
        with self._locked():
            rec = {**defaults(kind), **{k: coerce(kind, k, v) for k, v in data.items() if k not in SYSTEM_FIELDS}}
            rid = data.get("id") or self._next_id(kind)
            if self._path(kind, rid).exists():
                raise StoreError(f"{rid} already exists", 409)
            now = _now()
            rec = {"id": rid, **rec, "version": 1, "created": now, "updated": now}
            self._check(kind, rec)
            self._write(kind, rec)
            self._commit(message or f"{rid}: create — {rec.get('title', '')}")
            return rec

    def update(self, kind: str, rid: str, patch: dict, expected_version: int | None = None,
               message: str | None = None) -> dict:
        kind = normalize_kind(kind)
        with self._locked():
            rec = self._apply(kind, rid, patch, expected_version)
            self._write(kind, rec)
            self._commit(message or f"{rid}: update {', '.join(k for k in patch if k not in SYSTEM_FIELDS)}")
            return rec

    def _apply(self, kind, rid, patch, expected_version=None, add=None, remove=None) -> dict:
        cur = self.get(kind, rid)
        if expected_version is not None and int(expected_version) != cur.get("version"):
            raise StoreError(f"{rid} was modified (version {cur.get('version')}, you had {expected_version}); reload and retry", 409)
        rec = dict(cur)
        for k, v in (patch or {}).items():
            if k in SYSTEM_FIELDS:
                continue
            rec[k] = coerce(kind, k, v)
        for k, vals in (add or {}).items():
            rec[k] = list(dict.fromkeys([*(rec.get(k) or []), *_as_list(vals)]))
        for k, vals in (remove or {}).items():
            drop = set(_as_list(vals))
            rec[k] = [v for v in rec.get(k) or [] if v not in drop]
        rec["version"] = cur.get("version", 0) + 1
        rec["updated"] = _now()
        self._check(kind, rec)
        return rec

    def bulk_update(self, kind: str, ids: list[str] | None = None, q: str = "", where: dict | None = None,
                    set_: dict | None = None, add: dict | None = None, remove: dict | None = None,
                    dry_run: bool = False, message: str | None = None) -> dict:
        """Mass update. Validates every record first; writes all or nothing."""
        kind = normalize_kind(kind)
        with self._locked():
            targets = ids if ids else [r["id"] for r in self.search(kind, q, where)]
            if not targets:
                return {"matched": 0, "changed": [], "dry_run": dry_run}
            new, errors = [], []
            for rid in targets:
                try:
                    new.append(self._apply(kind, rid, set_ or {}, add=add, remove=remove))
                except StoreError as e:
                    errors.append({"id": rid, "error": str(e), "details": e.details})
            if errors:
                raise StoreError(f"bulk update rejected: {len(errors)} of {len(targets)} records invalid", 422, errors)
            if not dry_run:
                for rec in new:
                    self._write(kind, rec)
                what = ", ".join([*(set_ or {}), *(f"+{k}" for k in add or {}), *(f"-{k}" for k in remove or {})])
                self._commit(message or f"bulk: {what} on {len(new)} {kind}")
            return {"matched": len(targets), "changed": [r["id"] for r in new], "dry_run": dry_run}

    def upsert_many(self, kind: str, rows: list[dict], message: str | None = None) -> dict:
        """Create rows without an id / unknown id; patch rows whose id exists. All-or-nothing validation."""
        kind = normalize_kind(kind)
        created, updated = [], []
        with self._locked():
            autocommit = self.config.get("autocommit", True)
            self.config["autocommit"] = False
            try:
                for row in rows:
                    rid = row.get("id")
                    if rid and self._path(kind, rid).exists():
                        rec = self._apply(kind, rid, row)
                        self._write(kind, rec)
                        updated.append(rid)
                    else:
                        created.append(self.create(kind, row)["id"])
            finally:
                self.config["autocommit"] = autocommit
            self._commit(message or f"import: {len(created)} created, {len(updated)} updated {kind}")
        return {"created": created, "updated": updated}

    def delete(self, kind: str, rid: str, force: bool = False) -> dict:
        kind = normalize_kind(kind)
        with self._locked():
            self.get(kind, rid)
            refs = self.references_to(rid)
            if refs and not force:
                raise StoreError(f"{rid} is referenced by {', '.join(refs)}; pass force to delete anyway", 409, refs)
            self._path(kind, rid).unlink()
            self._commit(f"{rid}: delete")
            return {"deleted": rid, "dangling": refs}

    def references_to(self, rid: str) -> list[str]:
        refs = []
        for kind in KINDS:
            for rec in self.all(kind):
                for field, (ftype, _) in SCHEMAS[kind].items():
                    v = rec.get(field)
                    if (ftype == "ref" and v == rid) or (ftype == "reflist" and rid in (v or [])):
                        refs.append(rec["id"])
        return refs

    # ---------------------------------------------------------------- sessions
    def save_session(self, title: str, markdown: str, session_id: str | None = None) -> str:
        with self._locked():
            d = self.root / "sessions"
            if not session_id:
                nums = [int(m.group(1)) for p in d.glob("ELI-*.md") if (m := re.match(r"ELI-(\d+)", p.stem))]
                session_id = f"ELI-{(max(nums) + 1 if nums else 1):04d}"
            (d / f"{session_id}.md").write_text(f"# {session_id} — {title}\n\n{markdown.strip()}\n")
            self._commit(f"{session_id}: elicitation session — {title}")
            return session_id

    def sessions(self) -> list[dict]:
        out = []
        for p in sorted((self.root / "sessions").glob("ELI-*.md")):
            first = p.read_text().splitlines()[0] if p.stat().st_size else p.stem
            out.append({"id": p.stem, "title": first.lstrip("# ").split(" — ", 1)[-1]})
        return out

    def sync(self, message: str = "reqforge: sync") -> dict:
        with self._locked():
            return gitsync.sync(self.root, message)


def _as_list(v):
    if isinstance(v, list):
        return v
    return [s.strip() for s in str(v).split(",") if s.strip()]


def _match(value, wanted: str) -> bool:
    options = [w.lower() for w in str(wanted).split("|")]
    if isinstance(value, list):
        return any(str(v).lower() in options for v in value)
    if wanted in ("", "none", "null"):
        return value in (None, "", [])
    return str(value).lower() in options
