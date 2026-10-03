"""CSV round-trip for spreadsheet-style mass edits: export, edit columns, import (upsert by id)."""
from __future__ import annotations

import csv
import io
import json

from .model import SCHEMAS, SYSTEM_FIELDS


def export_csv(records: list[dict], kind: str) -> str:
    cols = ["id", *SCHEMAS[kind], "version"]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in records:
        row = {}
        for c in cols:
            v = r.get(c)
            ftype = SCHEMAS[kind].get(c, ("str",))[0]
            if ftype == "objlist":
                row[c] = json.dumps(v or [], ensure_ascii=False)
            elif isinstance(v, list):
                row[c] = ", ".join(v)
            else:
                row[c] = "" if v is None else v
        w.writerow(row)
    return buf.getvalue()


def parse_csv(text: str, kind: str) -> list[dict]:
    rows = []
    for raw in csv.DictReader(io.StringIO(text)):
        row = {}
        for c, v in raw.items():
            if c is None or c in SYSTEM_FIELDS and c != "id":
                continue
            v = (v or "").strip()
            spec = SCHEMAS[kind].get(c)
            if c == "id":
                if v:
                    row["id"] = v
                continue
            if spec is None:
                continue
            if v == "" and spec[0] not in ("list", "reflist", "objlist"):
                continue  # blank cell = leave unchanged
            row[c] = json.loads(v or "[]") if spec[0] == "objlist" else v
        rows.append(row)
    return rows
