"""Interactive console: a REPL over the same store the CLI, API and agents use."""
from __future__ import annotations

import cmd
import json
import shlex

from . import lint, trace
from .cli import parse_assignments
from .model import kind_of_id
from .store import StoreError


class Console(cmd.Cmd):
    intro = ("reqforge console — kinds: req, epic, story, task.  `help` for commands, `quit` to exit.\n"
             "  ls req status:approved type:quality      show REQ-0001       find story pci\n"
             "  set REQ-0001 status=approved priority=must\n"
             "  bulk req type:quality -- status=approved +tags=nfr\n")

    def __init__(self, store):
        super().__init__()
        self.store = store
        self.prompt = f"reqforge[{store.config.get('key')}]> "
        self.last: list[str] = []

    def onecmd(self, line):
        try:
            return super().onecmd(line)
        except StoreError as e:
            print(f"error: {e}")
            for d in e.details:
                print(f"  - {d}")
        except (ValueError, KeyError, IndexError) as e:
            print(f"error: {e}")

    def emptyline(self):
        pass

    def _table(self, recs):
        self.last = [r["id"] for r in recs]
        for r in recs:
            tag = "/".join(str(r[f]) for f in ("type", "category", "kind", "priority", "status") if r.get(f))
            print(f"  {r['id']:<11} {tag:<40} {r.get('title', '')}")
        print(f"  ({len(recs)})")

    def do_ls(self, arg):
        """ls KIND [query]   — list/search; query tokens like status:approved filter exactly"""
        kind, _, q = arg.partition(" ")
        self._table(self.store.search(kind or "req", q))

    def do_find(self, arg):
        """find KIND text   — alias of ls"""
        self.do_ls(arg)

    def do_show(self, arg):
        """show ID"""
        print(json.dumps(self.store.get(kind_of_id(arg.strip()), arg.strip()), indent=2, ensure_ascii=False))

    def do_set(self, arg):
        """set ID field=value [field=value ...]"""
        rid, *pairs = shlex.split(arg)
        rec = self.store.update(kind_of_id(rid), rid, parse_assignments(pairs))
        print(f"  {rid} -> v{rec['version']}")

    def do_new(self, arg):
        """new KIND field=value ...   e.g. new req title="Login" statement="The system shall ..." type=functional category=auth"""
        kind, *pairs = shlex.split(arg)
        rec = self.store.create(kind, parse_assignments(pairs))
        print(f"  created {rec['id']}")

    def do_bulk(self, arg):
        """bulk KIND [query] -- field=value +listfield=v -listfield=v [--dry]
        Use `_` as the query to target the ids from the last listing."""
        left, _, right = arg.partition(" -- ")
        kind, _, q = left.partition(" ")
        set_, add, remove, dry = {}, {}, {}, False
        for tok in shlex.split(right):
            if tok == "--dry":
                dry = True
            elif tok.startswith("+"):
                add.update(parse_assignments([tok[1:]]))
            elif tok.startswith("-"):
                remove.update(parse_assignments([tok[1:]]))
            else:
                set_.update(parse_assignments([tok]))
        ids = self.last if q.strip() == "_" else None
        if not ids and not q.strip():
            raise ValueError("give a query (or `_` for the last listing); refusing to update everything")
        res = self.store.bulk_update(kind, ids, "" if ids else q, None, set_, add, remove, dry)
        print(f"  {'would change' if dry else 'changed'} {len(res['changed'])}: {' '.join(res['changed'])}")

    def do_rm(self, arg):
        """rm ID [force]"""
        rid, *rest = arg.split()
        self.store.delete(kind_of_id(rid), rid, force=bool(rest))
        print(f"  deleted {rid}")

    def do_lint(self, arg):
        """lint — MECE + quality findings"""
        print(lint.to_markdown(lint.lint(self.store)))

    def do_trace(self, arg):
        """trace — traceability evaluation"""
        print(trace.to_markdown(trace.evaluate(self.store)))

    def do_sync(self, arg):
        """sync [message] — commit + pull --rebase + push"""
        print(self.store.sync(arg or "reqforge: sync from console"))

    def do_quit(self, arg):
        """quit"""
        return True

    do_exit = do_quit
    do_EOF = do_quit
