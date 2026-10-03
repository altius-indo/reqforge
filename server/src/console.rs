//! Interactive console: a REPL over the same store the CLI, API and agents use.

use std::io::{BufRead, Write};

use serde_json::Value;

use crate::cli::parse_assignments;
use crate::model::{s, Kind};
use crate::store::{Res, Store, StoreError};
use crate::{lint, trace};

pub const INTRO: &str = "reqforge console — kinds: req, epic, story, task.  `help` for commands, `quit` to exit.
  ls req status:approved type:quality      show REQ-0001       find story pci
  set REQ-0001 status=approved priority=must
  bulk req type:quality -- status=approved +tags=nfr
";

const HELP: &str = "commands:
  ls KIND [query]        list/search; query tokens like status:approved filter exactly (alias: find)
  show ID                print a record
  set ID f=v [f=v ...]   update fields
  new KIND f=v ...       create a record
  bulk KIND [query|_] -- f=v +listf=v -listf=v [--dry]   mass update (`_` = ids of the last listing)
  rm ID [force]          delete
  lint | trace           MECE/quality lint, traceability evaluation
  sync [message]         commit + pull --rebase + push
  quit";

pub struct Console<'a, W: Write> {
    pub store: &'a Store,
    pub out: W,
    pub last: Vec<String>,
}

impl<'a, W: Write> Console<'a, W> {
    pub fn new(store: &'a Store, out: W) -> Self {
        Console { store, out, last: vec![] }
    }

    fn table(&mut self, recs: &[std::sync::Arc<crate::model::Rec>]) {
        self.last = recs.iter().map(|r| s(r, "id").to_string()).collect();
        for r in recs {
            let tag: Vec<&str> = ["type", "category", "kind", "priority", "status"].iter().map(|f| s(r, f)).filter(|x| !x.is_empty()).collect();
            let _ = writeln!(self.out, "  {:<11} {:<40} {}", s(r, "id"), tag.join("/"), s(r, "title"));
        }
        let _ = writeln!(self.out, "  ({})", recs.len());
    }

    /// Execute one line. Returns false when the console should exit.
    pub fn onecmd(&mut self, line: &str) -> bool {
        match self.exec(line) {
            Ok(cont) => cont,
            Err(e) => {
                let _ = writeln!(self.out, "error: {}", e.message);
                for d in &e.details {
                    let _ = writeln!(self.out, "  - {}", d.as_str().map(String::from).unwrap_or_else(|| d.to_string()));
                }
                true
            }
        }
    }

    fn exec(&mut self, line: &str) -> Res<bool> {
        let line = line.trim();
        let (cmd, rest) = line.split_once(' ').unwrap_or((line, ""));
        let rest = rest.trim();
        let kind_of = |id: &str| Kind::of_id(id).map_err(StoreError::bad);
        match cmd {
            "" => {}
            "quit" | "exit" | "EOF" => return Ok(false),
            "help" | "?" => {
                let _ = writeln!(self.out, "{HELP}");
            }
            "ls" | "find" => {
                let (k, q) = rest.split_once(' ').unwrap_or((rest, ""));
                let kind = Kind::parse(if k.is_empty() { "req" } else { k }).map_err(StoreError::bad)?;
                let recs = self.store.search(kind, q, &Default::default());
                self.table(&recs);
            }
            "show" => {
                let rec = self.store.get(kind_of(rest)?, rest)?;
                let _ = writeln!(self.out, "{}", serde_json::to_string_pretty(&Value::Object(rec)).unwrap());
            }
            "set" => {
                let toks = shlex::split(rest).ok_or_else(|| StoreError::bad("unbalanced quotes"))?;
                let (id, pairs) = toks.split_first().ok_or_else(|| StoreError::bad("usage: set ID f=v ..."))?;
                let rec = self.store.update(kind_of(id)?, id, &parse_assignments(pairs).map_err(StoreError::bad)?, None, None)?;
                let _ = writeln!(self.out, "  {id} -> v{}", rec["version"]);
            }
            "new" => {
                let toks = shlex::split(rest).ok_or_else(|| StoreError::bad("unbalanced quotes"))?;
                let (k, pairs) = toks.split_first().ok_or_else(|| StoreError::bad("usage: new KIND f=v ..."))?;
                let rec = self.store.create(Kind::parse(k).map_err(StoreError::bad)?, &parse_assignments(pairs).map_err(StoreError::bad)?, None)?;
                let _ = writeln!(self.out, "  created {}", s(&rec, "id"));
            }
            "bulk" => {
                let (left, right) = rest.split_once(" -- ").unwrap_or((rest, ""));
                let (k, q) = left.split_once(' ').unwrap_or((left, ""));
                let kind = Kind::parse(k).map_err(StoreError::bad)?;
                let (mut set, mut add, mut remove, mut dry) = (vec![], vec![], vec![], false);
                for tok in shlex::split(right).ok_or_else(|| StoreError::bad("unbalanced quotes"))? {
                    if tok == "--dry" {
                        dry = true;
                    } else if let Some(t) = tok.strip_prefix('+') {
                        add.push(t.to_string());
                    } else if let Some(t) = tok.strip_prefix('-') {
                        remove.push(t.to_string());
                    } else {
                        set.push(tok);
                    }
                }
                let q = q.trim();
                let ids = (q == "_").then(|| self.last.clone());
                if ids.as_ref().map(Vec::is_empty).unwrap_or(true) && q.is_empty() {
                    return Err(StoreError::bad("give a query (or `_` for the last listing); refusing to update everything"));
                }
                let res = self.store.bulk_update(
                    kind,
                    ids.clone(),
                    if ids.is_some() { "" } else { q },
                    &Default::default(),
                    &parse_assignments(&set).map_err(StoreError::bad)?,
                    &parse_assignments(&add).map_err(StoreError::bad)?,
                    &parse_assignments(&remove).map_err(StoreError::bad)?,
                    dry,
                    None,
                )?;
                let changed: Vec<&str> = res["changed"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let _ = writeln!(self.out, "  {} {}: {}", if dry { "would change" } else { "changed" }, changed.len(), changed.join(" "));
            }
            "rm" => {
                let mut it = rest.split_whitespace();
                let id = it.next().ok_or_else(|| StoreError::bad("usage: rm ID [force]"))?;
                self.store.delete(kind_of(id)?, id, it.next().is_some())?;
                let _ = writeln!(self.out, "  deleted {id}");
            }
            "lint" => {
                let _ = writeln!(self.out, "{}", lint::to_markdown(&lint::lint(self.store)));
            }
            "trace" => {
                let _ = writeln!(self.out, "{}", trace::to_markdown(&trace::evaluate(self.store)));
            }
            "sync" => {
                let r = self.store.sync(if rest.is_empty() { "reqforge: sync from console" } else { rest })?;
                let _ = writeln!(self.out, "{r}");
            }
            other => {
                let _ = writeln!(self.out, "*** Unknown syntax: {other}  (try `help`)");
            }
        }
        Ok(true)
    }
}

pub fn run(store: &Store) {
    let mut c = Console::new(store, std::io::stdout());
    let _ = write!(c.out, "{INTRO}");
    let prompt = format!("reqforge[{}]> ", store.config_value()["key"].as_str().unwrap_or(""));
    let stdin = std::io::stdin();
    loop {
        let _ = write!(c.out, "{prompt}");
        let _ = c.out.flush();
        let mut line = String::new();
        if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if !c.onecmd(&line) {
            break;
        }
    }
}
