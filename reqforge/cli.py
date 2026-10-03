"""reqforge command-line interface."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__, cicd, csvio, evals, lint, trace
from .model import SCHEMAS, TAXONOMY, kind_of_id, normalize_kind
from .store import Store, StoreError


def parse_assignments(pairs: list[str] | None) -> dict:
    """field=value pairs; values that parse as JSON (lists/objects/numbers) are decoded."""
    out = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise ValueError(f"expected field=value, got '{pair}'")
        k, v = pair.split("=", 1)
        if v[:1] in "[{" or v in ("true", "false", "null"):
            try:
                v = json.loads(v)
            except json.JSONDecodeError:
                pass
        out[k.strip()] = v
    return out


def emit(obj, as_json: bool) -> None:
    if as_json or not isinstance(obj, list):
        print(json.dumps(obj, indent=2, ensure_ascii=False))
        return
    for r in obj:
        extra = " ".join(str(r.get(f)) for f in ("type", "category", "priority", "status", "kind", "epic", "story")
                         if r.get(f))
        print(f"{r['id']:<11} {extra:<38} {r.get('title', '')}")
    print(f"({len(obj)} records)", file=sys.stderr)


def _store(args) -> Store:
    return Store(args.repo) if args.repo else Store.discover()


def _data(args) -> dict:
    data = {}
    if getattr(args, "file", None):
        data.update(json.loads(Path(args.file).read_text()))
    if getattr(args, "data", None):
        data.update(json.loads(args.data))
    data.update(parse_assignments(getattr(args, "set", None)))
    return data


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reqforge", description="Requirements -> plan -> evals -> CI/CD, stored in git/GitHub.")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--repo", help="requirements repo path (default: $REQFORGE_REPO or discover upward)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="initialise a requirements repository")
    s.add_argument("path", nargs="?", default=".")
    s.add_argument("--key", required=True, help="short project key, e.g. PAY")
    s.add_argument("--name", required=True)
    s.add_argument("--github", help="owner/name to create or attach on GitHub")
    s.add_argument("--public", action="store_true")

    s = sub.add_parser("list", help="search/list records")
    s.add_argument("kind")
    s.add_argument("-q", "--query", default="", help="free text; field:value tokens filter")
    s.add_argument("-w", "--where", action="append", help="field=value (value may be a|b)")
    s.add_argument("--json", action="store_true")

    s = sub.add_parser("show", help="show one record")
    s.add_argument("id")

    for name, helptext in (("add", "create a record"), ("edit", "patch a record")):
        s = sub.add_parser(name, help=helptext)
        if name == "add":
            s.add_argument("kind")
        else:
            s.add_argument("id")
            s.add_argument("--if-version", type=int)
        s.add_argument("-s", "--set", action="append", help="field=value (lists: comma-separated or JSON)")
        s.add_argument("--data", help="JSON object")
        s.add_argument("--file", help="JSON file")

    s = sub.add_parser("rm", help="delete a record")
    s.add_argument("id")
    s.add_argument("--force", action="store_true")

    s = sub.add_parser("bulk", help="mass update")
    s.add_argument("kind")
    s.add_argument("--ids", help="comma-separated ids")
    s.add_argument("-q", "--query", default="")
    s.add_argument("-w", "--where", action="append")
    s.add_argument("-s", "--set", action="append")
    s.add_argument("--add", action="append", help="listfield=v1,v2 (e.g. tags=pci)")
    s.add_argument("--remove", action="append", help="listfield=v1,v2")
    s.add_argument("--dry-run", action="store_true")

    s = sub.add_parser("import", help="upsert records from CSV or JSON (array) file")
    s.add_argument("kind")
    s.add_argument("file")

    s = sub.add_parser("export", help="export records as CSV")
    s.add_argument("kind")
    s.add_argument("-q", "--query", default="")

    for name in ("lint", "trace"):
        s = sub.add_parser(name, help="MECE/quality lint" if name == "lint" else "traceability evaluation")
        s.add_argument("--md", action="store_true", help="markdown output")
        s.add_argument("--gate", action="store_true", help="exit 1 on failure (CI)")

    s = sub.add_parser("evals", help="eval registry and runner")
    es = s.add_subparsers(dest="evals_cmd", required=True)
    e = es.add_parser("list")
    e.add_argument("--stage")
    e.add_argument("--component")
    e = es.add_parser("run")
    e.add_argument("--stage", required=True)
    e.add_argument("--workdir", default=".")
    e.add_argument("--component")
    e.add_argument("--md", action="store_true")

    s = sub.add_parser("cicd", help="generate the GitHub Actions pipeline into a code repo")
    s.add_argument("out", nargs="?", default=".")
    s.add_argument("--requirements-path", default="", help="path of the requirements repo inside the code repo")
    s.add_argument("--no-vendor", action="store_true", help="do not copy the reqforge package into .reqforge/")

    s = sub.add_parser("sync", help="commit, pull --rebase, push")
    s.add_argument("-m", "--message", default="reqforge: sync")

    sub.add_parser("taxonomy", help="print the requirement taxonomy")

    s = sub.add_parser("serve", help="REST API + web UI")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8787)

    sub.add_parser("console", help="interactive console")
    sub.add_parser("mcp", help="run the MCP server on stdio")
    return p


def _where(items) -> dict:
    return parse_assignments(items) if items else {}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except StoreError as e:
        print(f"error: {e}", file=sys.stderr)
        for d in e.details:
            print(f"  - {d}", file=sys.stderr)
        return 2
    except (ValueError, KeyError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


def run(args) -> int:
    c = args.cmd
    if c == "mcp":
        from . import mcp_server
        mcp_server.main()
        return 0
    if c == "init":
        s = Store.init(args.path, args.key, args.name, args.github, private=not args.public)
        print(f"initialised {s.root}" + (f" -> github.com/{args.github}" if args.github else ""))
        return 0
    if c == "taxonomy":
        for t, spec in sorted(TAXONOMY.items(), key=lambda kv: kv[1]["order"]):
            print(f"{spec['order']}. {t}: {spec['test']}")
            for cat, d in (spec["categories"] or {"<capability area>": "free-form"}).items():
                print(f"     - {cat}: {d}")
        return 0

    s = _store(args)
    if c == "list":
        emit(s.search(args.kind, args.query, _where(args.where)), args.json)
    elif c == "show":
        emit(s.get(kind_of_id(args.id), args.id), True)
    elif c == "add":
        emit(s.create(args.kind, _data(args)), True)
    elif c == "edit":
        emit(s.update(kind_of_id(args.id), args.id, _data(args), args.if_version), True)
    elif c == "rm":
        emit(s.delete(kind_of_id(args.id), args.id, args.force), True)
    elif c == "bulk":
        if not (args.ids or args.query or args.where):
            raise ValueError("bulk needs a selection: --ids, -q or -w (refusing to touch every record)")
        res = s.bulk_update(args.kind, args.ids.split(",") if args.ids else None, args.query, _where(args.where),
                            parse_assignments(args.set), parse_assignments(args.add), parse_assignments(args.remove),
                            args.dry_run)
        emit(res, True)
    elif c == "import":
        kind = normalize_kind(args.kind)
        text = Path(args.file).read_text()
        rows = json.loads(text) if args.file.endswith(".json") else csvio.parse_csv(text, kind)
        emit(s.upsert_many(kind, rows, f"import {Path(args.file).name}"), True)
    elif c == "export":
        kind = normalize_kind(args.kind)
        sys.stdout.write(csvio.export_csv(s.search(kind, args.query), kind))
    elif c in ("lint", "trace"):
        mod = lint if c == "lint" else trace
        rep = mod.lint(s) if c == "lint" else mod.evaluate(s)
        print(mod.to_markdown(rep) if args.md else json.dumps(rep, indent=2))
        return 1 if args.gate and not rep["ok"] else 0
    elif c == "evals":
        if args.evals_cmd == "list":
            emit(evals.registry(s, args.stage, args.component), True)
        else:
            rep = evals.run(s, args.stage, args.workdir, args.component)
            print(evals.to_markdown(rep) if args.md else json.dumps(rep, indent=2))
            return 0 if rep["ok"] else 1
    elif c == "cicd":
        for path in cicd.generate(s, args.out, args.requirements_path, vendor=not args.no_vendor):
            print(f"wrote {path}")
    elif c == "sync":
        res = s.sync(args.message)
        emit(res, True)
        return 0 if res.get("ok") else 1
    elif c == "serve":
        from .api import serve
        srv = serve(s, args.host, args.port)
        print(f"reqforge UI + API on http://{args.host}:{args.port}  (repo {s.root})")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
    elif c == "console":
        from .console import Console
        Console(s).cmdloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
