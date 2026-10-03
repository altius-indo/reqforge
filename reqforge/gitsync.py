"""GitHub persistence via git + gh. The requirements repo is an ordinary git repo;
every mutation is a commit (when autocommit is on) and `sync` rebases and pushes."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def _git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=check)


def is_repo(root: Path) -> bool:
    return shutil.which("git") is not None and _git(root, "rev-parse", "--is-inside-work-tree", check=False).returncode == 0


def ensure_repo(root: Path) -> None:
    if shutil.which("git") and not is_repo(root):
        _git(root, "init", "-q", "-b", "main")
    ignore = root / ".gitignore"
    lines = ignore.read_text().splitlines() if ignore.exists() else []
    missing = [p for p in (".reqforge.lock", "*.json.tmp") if p not in lines]
    if missing:
        ignore.write_text("\n".join([*lines, *missing]) + "\n")


def commit_all(root: Path, message: str) -> bool:
    if not is_repo(root):
        return False
    _git(root, "add", "-A")
    if _git(root, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    r = _git(root, "commit", "-q", "-m", message, check=False)
    return r.returncode == 0


def has_remote(root: Path) -> bool:
    return bool(_git(root, "remote", check=False).stdout.strip())


def sync(root: Path, message: str) -> dict:
    if not is_repo(root):
        return {"ok": False, "error": "not a git repository"}
    committed = commit_all(root, message)
    if not has_remote(root):
        return {"ok": True, "committed": committed, "pushed": False, "note": "no remote configured"}
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    pull = _git(root, "pull", "--rebase", "origin", branch, check=False)
    if pull.returncode != 0 and "couldn't find remote ref" not in pull.stderr:
        _git(root, "rebase", "--abort", check=False)
        return {"ok": False, "committed": committed, "error": f"pull --rebase failed: {pull.stderr.strip()}"}
    push = _git(root, "push", "-u", "origin", branch, check=False)
    if push.returncode != 0:
        return {"ok": False, "committed": committed, "error": f"push failed: {push.stderr.strip()}"}
    return {"ok": True, "committed": committed, "pushed": True}


def create_remote(root: Path, slug: str, private: bool = True) -> None:
    """Create (or attach to) a GitHub repo `owner/name` and push."""
    if has_remote(root):
        return
    if shutil.which("gh") is None:
        _git(root, "remote", "add", "origin", f"git@github.com:{slug}.git")
        return
    view = subprocess.run(["gh", "repo", "view", slug], capture_output=True, text=True)
    if view.returncode == 0:
        _git(root, "remote", "add", "origin", f"https://github.com/{slug}.git")
        _git(root, "push", "-u", "origin", "main", check=False)
    else:
        subprocess.run(["gh", "repo", "create", slug, "--private" if private else "--public",
                        "--source", str(root), "--push"], check=True, capture_output=True, text=True)
