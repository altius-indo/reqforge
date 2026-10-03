//! reqforge command-line interface.

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use serde_json::{json, Map, Value};

use crate::model::{Kind, Rec, TAXONOMY};
use crate::store::{Res, Store, StoreError};
use crate::{api, cicd, console, csvio, evals, lint, mcp, trace};

#[derive(Parser)]
#[command(name = "reqforge", version, about = "Requirements -> plan -> evals -> CI/CD, stored in git/GitHub.")]
pub struct Cli {
    /// requirements repo path (default: $REQFORGE_REPO or discover upward)
    #[arg(long, global = true)]
    pub repo: Option<PathBuf>,
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// initialise a requirements repository
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// short project key, e.g. PAY
        #[arg(long)]
        key: String,
        #[arg(long)]
        name: String,
        /// owner/name to create or attach on GitHub
        #[arg(long)]
        github: Option<String>,
        #[arg(long)]
        public: bool,
    },
    /// search/list records
    List {
        kind: String,
        /// free text; field:value tokens filter
        #[arg(short, long, default_value = "")]
        query: String,
        /// field=value (value may be a|b)
        #[arg(short, long = "where")]
        where_: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// show one record
    Show { id: String },
    /// create a record
    Add {
        kind: String,
        /// field=value (lists: comma-separated or JSON)
        #[arg(short, long)]
        set: Vec<String>,
        /// JSON object
        #[arg(long)]
        data: Option<String>,
        /// JSON file
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// patch a record
    Edit {
        id: String,
        #[arg(long)]
        if_version: Option<i64>,
        #[arg(short, long)]
        set: Vec<String>,
        #[arg(long)]
        data: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// delete a record
    Rm {
        id: String,
        #[arg(long)]
        force: bool,
    },
    /// mass update
    Bulk {
        kind: String,
        /// comma-separated ids
        #[arg(long)]
        ids: Option<String>,
        #[arg(short, long, default_value = "")]
        query: String,
        #[arg(short, long = "where")]
        where_: Vec<String>,
        #[arg(short, long)]
        set: Vec<String>,
        /// listfield=v1,v2 (e.g. tags=pci)
        #[arg(long)]
        add: Vec<String>,
        #[arg(long)]
        remove: Vec<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// upsert records from CSV or JSON (array) file
    Import { kind: String, file: PathBuf },
    /// export records as CSV
    Export {
        kind: String,
        #[arg(short, long, default_value = "")]
        query: String,
    },
    /// MECE/quality lint
    Lint {
        #[arg(long)]
        md: bool,
        /// exit 1 on failure (CI)
        #[arg(long)]
        gate: bool,
    },
    /// traceability evaluation
    Trace {
        #[arg(long)]
        md: bool,
        #[arg(long)]
        gate: bool,
    },
    /// eval registry and runner
    Evals {
        #[command(subcommand)]
        cmd: EvalsCmd,
    },
    /// generate the GitHub Actions pipeline into a code repo
    Cicd {
        #[arg(default_value = ".")]
        out: PathBuf,
        /// path of the requirements repo inside the code repo
        #[arg(long, default_value = "")]
        requirements_path: String,
        /// do not vendor the reqforge server sources into .reqforge/
        #[arg(long)]
        no_vendor: bool,
    },
    /// read or patch project config: --set key=JSON
    Config {
        #[arg(short, long)]
        set: Vec<String>,
    },
    /// commit, pull --rebase, push
    Sync {
        #[arg(short, long, default_value = "reqforge: sync")]
        message: String,
    },
    /// print the requirement taxonomy
    Taxonomy,
    /// REST API + web UI
    Serve {
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 8787)]
        port: u16,
    },
    /// interactive console
    Console,
    /// run the MCP server on stdio
    Mcp,
}

#[derive(Subcommand)]
pub enum EvalsCmd {
    List {
        #[arg(long)]
        stage: Option<String>,
        #[arg(long)]
        component: Option<String>,
    },
    Run {
        #[arg(long)]
        stage: String,
        #[arg(long, default_value = ".")]
        workdir: PathBuf,
        #[arg(long)]
        component: Option<String>,
        #[arg(long)]
        md: bool,
    },
}

/// field=value pairs; values that parse as JSON (lists/objects/bools/null) are decoded.
pub fn parse_assignments<S: AsRef<str>>(pairs: &[S]) -> Result<Rec, String> {
    let mut out = Rec::new();
    for pair in pairs {
        let pair = pair.as_ref();
        let (k, v) = pair.split_once('=').ok_or_else(|| format!("expected field=value, got '{pair}'"))?;
        let val = if v.starts_with('[') || v.starts_with('{') || ["true", "false", "null"].contains(&v) {
            serde_json::from_str(v).unwrap_or_else(|_| json!(v))
        } else {
            json!(v)
        };
        out.insert(k.trim().to_string(), val);
    }
    Ok(out)
}

fn emit_list(rows: &[Arc<Rec>], as_json: bool) {
    if as_json {
        let v: Vec<Value> = rows.iter().map(|r| Value::Object((**r).clone())).collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
        return;
    }
    for r in rows {
        let extra: Vec<&str> = ["type", "category", "priority", "status", "kind", "epic", "story"].iter().map(|f| crate::model::s(r, f)).filter(|x| !x.is_empty()).collect();
        println!("{:<11} {:<38} {}", crate::model::s(r, "id"), extra.join(" "), crate::model::s(r, "title"));
    }
    eprintln!("({} records)", rows.len());
}

fn pretty(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn data(set: &[String], data: &Option<String>, file: &Option<PathBuf>) -> Res<Rec> {
    let mut out = Rec::new();
    if let Some(f) = file {
        let text = std::fs::read_to_string(f).map_err(|e| StoreError::bad(format!("{}: {e}", f.display())))?;
        out.extend(serde_json::from_str::<Map<String, Value>>(&text).map_err(|e| StoreError::bad(e.to_string()))?);
    }
    if let Some(d) = data {
        out.extend(serde_json::from_str::<Map<String, Value>>(d).map_err(|e| StoreError::bad(format!("--data: {e}")))?);
    }
    out.extend(parse_assignments(set)?);
    Ok(out)
}

fn kind(k: &str) -> Res<Kind> {
    Kind::parse(k).map_err(StoreError::bad)
}

fn open(repo: &Option<PathBuf>) -> Res<Store> {
    match repo {
        Some(r) => Store::open(r),
        None => Store::discover(None),
    }
}

pub fn main() -> i32 {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {}", e.message);
            for d in &e.details {
                eprintln!("  - {}", d.as_str().map(String::from).unwrap_or_else(|| d.to_string()));
            }
            2
        }
    }
}

pub fn run(cli: Cli) -> Res<i32> {
    match cli.cmd {
        Cmd::Mcp => {
            mcp::main();
            return Ok(0);
        }
        Cmd::Init { path, key, name, github, public } => {
            let s = Store::init(&path, &key, &name, github.as_deref(), !public)?;
            println!("initialised {}{}", s.root.display(), github.map(|g| format!(" -> github.com/{g}")).unwrap_or_default());
            return Ok(0);
        }
        Cmd::Taxonomy => {
            for t in &TAXONOMY {
                println!("{}. {}: {}", t.order, t.name, t.test);
                match t.categories {
                    Some(c) => c.iter().for_each(|(n, d)| println!("     - {n}: {d}")),
                    None => println!("     - <capability area>: free-form"),
                }
            }
            return Ok(0);
        }
        _ => {}
    }
    let s = open(&cli.repo)?;
    match cli.cmd {
        Cmd::List { kind: k, query, where_, json } => emit_list(&s.search(kind(&k)?, &query, &parse_assignments(&where_)?), json),
        Cmd::Show { id } => pretty(&Value::Object(s.get(Kind::of_id(&id)?, &id)?)),
        Cmd::Add { kind: k, set, data: d, file } => pretty(&Value::Object(s.create(kind(&k)?, &data(&set, &d, &file)?, None)?)),
        Cmd::Edit { id, if_version, set, data: d, file } => {
            pretty(&Value::Object(s.update(Kind::of_id(&id)?, &id, &data(&set, &d, &file)?, if_version, None)?))
        }
        Cmd::Rm { id, force } => pretty(&s.delete(Kind::of_id(&id)?, &id, force)?),
        Cmd::Bulk { kind: k, ids, query, where_, set, add, remove, dry_run } => {
            if ids.is_none() && query.is_empty() && where_.is_empty() {
                return Err(StoreError::bad("bulk needs a selection: --ids, -q or -w (refusing to touch every record)"));
            }
            let ids = ids.map(|x| x.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect());
            pretty(&s.bulk_update(kind(&k)?, ids, &query, &parse_assignments(&where_)?, &parse_assignments(&set)?, &parse_assignments(&add)?, &parse_assignments(&remove)?, dry_run, None)?)
        }
        Cmd::Import { kind: k, file } => {
            let k = kind(&k)?;
            let text = std::fs::read_to_string(&file).map_err(|e| StoreError::bad(format!("{}: {e}", file.display())))?;
            let rows: Vec<Rec> = if file.extension().map(|e| e == "json").unwrap_or(false) {
                serde_json::from_str::<Vec<Value>>(&text).map_err(|e| StoreError::bad(e.to_string()))?.into_iter().filter_map(|v| v.as_object().cloned()).collect()
            } else {
                csvio::parse(&text, k)?
            };
            let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            pretty(&s.upsert_many(k, &rows, Some(&format!("import {name}")))?)
        }
        Cmd::Export { kind: k, query } => {
            let k = kind(&k)?;
            print!("{}", csvio::export(&s.search(k, &query, &Map::new()), k));
        }
        Cmd::Lint { md, gate } => {
            let rep = lint::lint(&s);
            println!("{}", if md { lint::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
            return Ok(if gate && rep["ok"] != json!(true) { 1 } else { 0 });
        }
        Cmd::Trace { md, gate } => {
            let rep = trace::evaluate(&s);
            println!("{}", if md { trace::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
            return Ok(if gate && rep["ok"] != json!(true) { 1 } else { 0 });
        }
        Cmd::Evals { cmd } => match cmd {
            EvalsCmd::List { stage, component } => pretty(&json!(evals::registry(&s, stage.as_deref(), component.as_deref()))),
            EvalsCmd::Run { stage, workdir, component, md } => {
                let rep = evals::run(&s, &stage, &workdir, component.as_deref(), None).map_err(StoreError::bad)?;
                println!("{}", if md { evals::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
                return Ok(if rep["ok"] == json!(true) { 0 } else { 1 });
            }
        },
        Cmd::Cicd { out, requirements_path, no_vendor } => {
            for p in cicd::generate(&s, &out, &requirements_path, !no_vendor).map_err(StoreError::bad)? {
                println!("wrote {p}");
            }
        }
        Cmd::Config { set } => {
            if set.is_empty() {
                pretty(&s.config_value());
            } else {
                pretty(&s.save_config(&parse_assignments(&set)?)?);
            }
        }
        Cmd::Sync { message } => {
            let r = s.sync(&message)?;
            pretty(&r);
            return Ok(if r["ok"] == json!(true) { 0 } else { 1 });
        }
        Cmd::Serve { host, port } => {
            let rt = tokio::runtime::Runtime::new().map_err(|e| StoreError::bad(e.to_string()))?;
            rt.block_on(async {
                let store = Arc::new(s);
                let root = store.root.clone();
                let (addr, h) = api::serve(store, &host, port).await.map_err(|e| StoreError::bad(format!("bind {host}:{port}: {e}")))?;
                println!("reqforge UI + API on http://{addr}  (repo {})", root.display());
                use std::io::Write;
                let _ = std::io::stdout().flush();
                let _ = h.await;
                Ok::<(), StoreError>(())
            })?;
        }
        Cmd::Console => console::run(&s),
        Cmd::Mcp | Cmd::Init { .. } | Cmd::Taxonomy => unreachable!(),
    }
    Ok(0)
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::bad(e.to_string())
    }
}
