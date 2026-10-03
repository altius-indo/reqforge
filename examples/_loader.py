"""Tiny helper for the example seeders: collects records in memory and loads them through
the reqforge CLI (`init`, `import`, `config --set`) so the Rust store validates every row."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("REQFORGE_CLI", str(Path(__file__).resolve().parents[1] / "bin" / "reqforge"))
KINDS = {"requirements": "REQ", "epics": "EPIC", "stories": "STORY", "tasks": "TASK"}

# reqforge taxonomy categories (mirrors `reqforge taxonomy`)
TAXONOMY = {
    "constraint": {"categories": ["regulatory", "technology", "business", "environment"]},
    "interface": {"categories": ["user-interface", "api", "integration", "hardware"]},
    "data": {"categories": ["model", "lifecycle", "quality", "migration"]},
    "quality": {"categories": ["functional-suitability", "performance-efficiency", "compatibility", "interaction-capability",
                               "reliability", "security", "maintainability", "flexibility", "safety"]},
    "functional": {"categories": None},
}


class Loader:
    def __init__(self, root, key, name):
        self.root = str(Path(root).resolve())
        self.rows = {k: [] for k in KINDS}
        self.config = {}
        subprocess.run([BIN, "init", self.root, "--key", key, "--name", name], check=True, capture_output=True)

    def create(self, kind, data):
        if "id" not in data:
            data = {"id": f"{KINDS[kind]}-{len(self.rows[kind]) + 1:04d}", **data}
        self.rows[kind].append(data)
        return data

    def upsert_many(self, kind, rows):
        return {"created": [self.create(kind, r)["id"] for r in rows]}

    def save_config(self, patch):
        self.config.update(patch)

    def flush(self):
        with tempfile.TemporaryDirectory() as d:
            for kind, rows in self.rows.items():
                if rows:
                    f = Path(d) / f"{kind}.json"
                    f.write_text(json.dumps(rows))
                    subprocess.run([BIN, "--repo", self.root, "import", kind, str(f)], check=True, capture_output=True)
        if self.config:
            subprocess.run([BIN, "--repo", self.root, "config", *[f"--set={k}={json.dumps(v)}" for k, v in self.config.items()]],
                           check=True, capture_output=True)
