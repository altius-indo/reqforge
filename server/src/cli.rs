//! reqforge command-line interface.

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use serde_json::{json, Map, Value};

use crate::model::{Kind, Rec, TAXONOMY};
use crate::store::{Res, Store, StoreError};
use crate::workspace::{resolve, Workspace};
use crate::{api, cicd, console, csvio, evals, lint, mcp, trace};

#[derive(Parser)]
#[command(name = "reqforge", version, about = "Requirements -> plan -> evals -> CI/CD, stored in git/GitHub.")]
pub struct Cli {
    /// requirements repo path (default: $REQFORGE_REPO, discover upward, or the workspace default project)
    #[arg(long, global = true)]
    pub repo: Option<PathBuf>,
    /// project key within the workspace (or $REQFORGE_PROJECT)
    #[arg(short = 'P', long, global = true)]
    pub project: Option<String>,
    /// workspace directory (default: $REQFORGE_WORKSPACE, discover upward, or ~/.reqforge)
    #[arg(long, global = true)]
    pub workspace: Option<PathBuf>,
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
        /// component key this code repo implements (enables scan, impact and code evidence)
        #[arg(short, long)]
        component: Option<String>,
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
    /// scan component sources for trace tags (`reqforge: implements REQ-…`, test markers)
    Scan {
        /// component key(s) to scan (default: all with a path)
        #[arg(short, long = "component")]
        component: Vec<String>,
        /// scan this checkout instead of the component's path (CI: --root .)
        #[arg(long)]
        root: Option<PathBuf>,
        /// report without writing the index
        #[arg(long)]
        dry_run: bool,
    },
    /// ingest CI results (JUnit XML, reqforge eval reports) as verification evidence
    Evidence {
        #[command(subcommand)]
        cmd: EvidenceCmd,
    },
    /// verification report: requirement -> criteria -> tests/evals -> evidence -> code
    Verify {
        #[arg(long)]
        md: bool,
        /// ignore evidence: only check code/test trace tags (PR gate before tests run)
        #[arg(long = "static")]
        static_only: bool,
        /// exit 1 when an error-level check fails (CI)
        #[arg(long)]
        gate: bool,
        /// detail for one requirement
        #[arg(long)]
        req: Option<String>,
    },
    /// requirements, tests and evals affected by a code change (PR impact)
    Impact {
        #[arg(short, long)]
        component: Option<String>,
        /// base ref (default origin/main, main, …)
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        root: Option<PathBuf>,
        #[arg(long)]
        md: bool,
        /// print only the test files to run, one per line
        #[arg(long)]
        select_tests: bool,
    },
    /// manage the projects in a workspace
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
    /// interactive console
    Console,
    /// run the MCP server on stdio
    Mcp,
}

#[derive(Subcommand)]
pub enum EvidenceCmd {
    /// ingest result files
    Ingest {
        files: Vec<PathBuf>,
        #[arg(short, long)]
        component: Option<String>,
        /// commit the results belong to (default: the scanned commit)
        #[arg(long)]
        commit: Option<String>,
        /// CI run URL
        #[arg(long)]
        run: Option<String>,
    },
    /// list latest evidence, optionally for one requirement or criterion
    List {
        #[arg(long)]
        target: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum ProjectCmd {
    /// list projects with their artifact counts
    List {
        #[arg(long)]
        json: bool,
    },
    /// create a project (a new requirements repository inside the workspace)
    Create {
        key: String,
        #[arg(long, default_value = "")]
        name: String,
        /// owner/name to create or attach on GitHub
        #[arg(long)]
        github: Option<String>,
        #[arg(long)]
        public: bool,
    },
    /// register an existing requirements repository as a project
    Import {
        path: PathBuf,
        #[arg(long)]
        key: Option<String>,
    },
    /// rename a project
    Rename { key: String, name: String },
    /// make a project the workspace default
    Default { key: String },
    /// delete a project and ALL its artifacts (requirements, plan, changesets, sessions, git history)
    Delete {
        key: String,
        /// repeat the project key to confirm
        #[arg(long)]
        confirm: String,
        /// also delete the GitHub repository (irreversible)
        #[arg(long)]
        delete_remote: bool,
    },
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

fn workspace(explicit: &Option<PathBuf>) -> Res<Workspace> {
    Workspace::open(&Workspace::locate(explicit.as_deref()).unwrap_or_else(Workspace::default_root))
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

// reqforge: implements REQ-0028
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
        Cmd::Project { cmd } => {
            let ws = workspace(&cli.workspace)?;
            match cmd {
                ProjectCmd::List { json: j } => {
                    let l = ws.list();
                    if j {
                        pretty(&l);
                    } else {
                        println!("workspace {}", l["workspace"].as_str().unwrap_or(""));
                        for p in l["projects"].as_array().into_iter().flatten() {
                            let a = &p["artifacts"];
                            println!(
                                "{} {:<12} {:<34} {} reqs · {} stories · {} tasks{}",
                                if p["default"] == json!(true) { "*" } else { " " },
                                p["key"].as_str().unwrap_or(""),
                                p["name"].as_str().unwrap_or(""),
                                a["requirements"], a["stories"], a["tasks"],
                                p["github"].as_str().map(|g| format!(" · github.com/{g}")).unwrap_or_default()
                            );
                        }
                    }
                }
                ProjectCmd::Create { key, name, github, public } => pretty(&ws.create(&key, &name, github.as_deref(), !public)?),
                ProjectCmd::Import { path, key } => pretty(&ws.import(&path, key.as_deref())?),
                ProjectCmd::Rename { key, name } => pretty(&ws.rename(&key, &name)?),
                ProjectCmd::Default { key } => pretty(&ws.set_default(&key)?),
                ProjectCmd::Delete { key, confirm, delete_remote } => pretty(&ws.delete(&key, &confirm, delete_remote)?),
            }
            return Ok(0);
        }
        Cmd::Serve { host, port } => {
            // --repo / a project directory => single-project mode; otherwise the workspace
            let ws_dir = Workspace::locate(cli.workspace.as_deref());
            let single = cli.repo.is_some()
                || (ws_dir.is_none() && cli.project.is_none() && (std::env::var("REQFORGE_REPO").map(|v| !v.is_empty()).unwrap_or(false) || Store::discover(None).is_ok()));
            let rt = tokio::runtime::Runtime::new().map_err(|e| StoreError::bad(e.to_string()))?;
            rt.block_on(async {
                let (addr, h, what) = if single {
                    let store = resolve(cli.repo.as_deref(), None, None)?;
                    let root = store.root.display().to_string();
                    let store = Arc::try_unwrap(store).unwrap_or_else(|a| Store::open(&a.root).expect("reopen"));
                    let (addr, h) = api::serve(Arc::new(store), &host, port).await.map_err(|e| StoreError::bad(format!("bind {host}:{port}: {e}")))?;
                    (addr, h, format!("project {root}"))
                } else {
                    let ws = Arc::new(Workspace::open(&ws_dir.unwrap_or_else(Workspace::default_root))?);
                    let what = format!("workspace {} ({} projects)", ws.root.display(), ws.list()["projects"].as_array().map(Vec::len).unwrap_or(0));
                    let (addr, h) = api::serve_workspace(ws, &host, port).await.map_err(|e| StoreError::bad(format!("bind {host}:{port}: {e}")))?;
                    (addr, h, what)
                };
                println!("reqforge UI + API on http://{addr}  ({what})");
                use std::io::Write;
                let _ = std::io::stdout().flush();
                let _ = h.await;
                Ok::<(), StoreError>(())
            })?;
            return Ok(0);
        }
        _ => {}
    }
    let s = resolve(cli.repo.as_deref(), cli.project.as_deref(), cli.workspace.as_deref())?;
    let s: &Store = &s;
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
            let rep = lint::lint(s);
            println!("{}", if md { lint::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
            return Ok(if gate && rep["ok"] != json!(true) { 1 } else { 0 });
        }
        Cmd::Trace { md, gate } => {
            let rep = trace::evaluate(s);
            println!("{}", if md { trace::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
            return Ok(if gate && rep["ok"] != json!(true) { 1 } else { 0 });
        }
        Cmd::Evals { cmd } => match cmd {
            EvalsCmd::List { stage, component } => pretty(&json!(evals::registry(s, stage.as_deref(), component.as_deref()))),
            EvalsCmd::Run { stage, workdir, component, md } => {
                let rep = evals::run(s, &stage, &workdir, component.as_deref(), None).map_err(StoreError::bad)?;
                println!("{}", if md { evals::to_markdown(&rep) } else { serde_json::to_string_pretty(&rep).unwrap() });
                return Ok(if rep["ok"] == json!(true) { 0 } else { 1 });
            }
        },
        Cmd::Cicd { out, requirements_path, no_vendor, component } => {
            for p in cicd::generate_for(s, &out, &requirements_path, !no_vendor, component.as_deref()).map_err(StoreError::bad)? {
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
        Cmd::Scan { component, root, dry_run } => pretty(&crate::codetrace::scan(s, &component, root.as_deref(), !dry_run)?),
        Cmd::Evidence { cmd } => match cmd {
            EvidenceCmd::Ingest { files, component, commit, run } => {
                let mut loaded = vec![];
                for f in &files {
                    let text = std::fs::read_to_string(f).map_err(|e| StoreError::bad(format!("{}: {e}", f.display())))?;
                    loaded.push((f.display().to_string(), text));
                }
                let o = crate::evidence::IngestOpts { component: component.as_deref(), commit: commit.as_deref(), run: run.as_deref() };
                pretty(&crate::evidence::ingest(s, &loaded, &o)?)
            }
            EvidenceCmd::List { target } => {
                let t = target.unwrap_or_default();
                let rows: Vec<Value> = crate::evidence::load_latest(&s.root)
                    .values()
                    .filter(|e| t.is_empty() || e.target == t || e.target.starts_with(&format!("{t}#")))
                    .map(|e| serde_json::to_value(e).unwrap())
                    .collect();
                pretty(&json!(rows))
            }
        },
        Cmd::Verify { md, gate, req, static_only } => {
            let full = if static_only {
                std::sync::Arc::new(crate::verify::compute(s, &crate::codetrace::load_all(&s.root), &Default::default()))
            } else {
                crate::verify::report(s)
            };
            if let Some(r) = req {
                pretty(&full["requirements"].get(&r).cloned().ok_or_else(|| StoreError::new(format!("{r} not found"), 404))?);
                return Ok(0);
            }
            if md {
                println!("{}", crate::verify::to_markdown(&full));
            } else {
                pretty(&crate::verify::summary(&full));
            }
            return Ok(if gate && full["ok"] != json!(true) { 1 } else { 0 });
        }
        Cmd::Impact { component, base, root, md, select_tests } => {
            let rep = crate::impact::impact(s, component.as_deref(), root.as_deref(), base.as_deref())?;
            if select_tests {
                for t in rep["tests"].as_array().into_iter().flatten() {
                    println!("{}", t["file"].as_str().unwrap_or(""));
                }
            } else if md {
                print!("{}", crate::impact::to_markdown(&rep));
            } else {
                pretty(&rep);
            }
        }
        Cmd::Console => console::run(s),
        Cmd::Mcp | Cmd::Init { .. } | Cmd::Taxonomy | Cmd::Project { .. } | Cmd::Serve { .. } => unreachable!(),
    }
    Ok(0)
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::bad(e.to_string())
    }
}
