//! Workspace: the top-level container of projects.
//!
//! A workspace is a directory holding `reqforge-workspace.json` (the project registry). Each
//! project is an independent reqforge repository (its own git history and, optionally, its own
//! GitHub remote), by default at `<workspace>/<key>/`; existing repositories can be imported
//! from anywhere. Deleting a project removes its whole directory: requirements, epics, stories,
//! tasks, changesets, sessions, reports and git history. Deleting the GitHub repository as well
//! is an explicit opt-in.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::KINDS;
use crate::store::{dump, now, Res, Store, StoreError, CONFIG_FILE};

pub const WORKSPACE_FILE: &str = "reqforge-workspace.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub key: String,
    pub name: String,
    /// relative to the workspace root when inside it, absolute otherwise
    pub path: String,
    pub created: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub projects: Vec<Entry>,
}

fn one() -> u32 {
    1
}

pub struct Workspace {
    pub root: PathBuf,
    /// single-project mode (server started with --repo): registry is in memory and read-only
    pub single: bool,
    reg: RwLock<Registry>,
    stores: Mutex<HashMap<String, Arc<Store>>>,
    write: Mutex<()>,
}

pub fn valid_key(key: &str) -> bool {
    Regex::new(r"^[A-Z][A-Z0-9_-]{1,15}$").unwrap().is_match(key)
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn count(dir: &Path, ext: &str) -> usize {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(ext) && !e.file_name().to_string_lossy().starts_with('.'))
        .count()
}

/// Counts of everything a project directory holds (what a delete removes).
pub fn artifacts(path: &Path) -> Value {
    let mut out = serde_json::Map::new();
    for k in KINDS {
        out.insert(k.as_str().into(), json!(count(&path.join(k.dir()), ".json")));
    }
    out.insert("changesets".into(), json!(count(&path.join("changesets"), ".json")));
    out.insert("sessions".into(), json!(count(&path.join("sessions"), ".md")));
    out.insert("reports".into(), json!(count(&path.join("reports"), ".md")));
    out.insert("code_indexes".into(), json!(count(&path.join("code"), ".json")));
    out.insert("evidence".into(), json!(crate::evidence::load_latest(path).len()));
    Value::Object(out)
}

pub fn remote_url(path: &Path) -> Option<String> {
    let o = Command::new("git").arg("-C").arg(path).args(["remote", "get-url", "origin"]).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// owner/name from a GitHub remote URL (https or ssh).
pub fn github_slug(url: &str) -> Option<String> {
    let re = Regex::new(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$").unwrap();
    re.captures(url).map(|c| format!("{}/{}", &c[1], &c[2]))
}

impl Workspace {
    /// `--workspace` / REQFORGE_WORKSPACE / walk up from cwd for reqforge-workspace.json.
    pub fn locate(explicit: Option<&Path>) -> Option<PathBuf> {
        if let Some(p) = explicit {
            return Some(p.to_path_buf());
        }
        if let Ok(env) = std::env::var("REQFORGE_WORKSPACE") {
            if !env.is_empty() {
                return Some(PathBuf::from(env));
            }
        }
        let here = std::env::current_dir().ok()?;
        here.ancestors().find(|d| d.join(WORKSPACE_FILE).exists()).map(Path::to_path_buf)
    }

    pub fn default_root() -> PathBuf {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join(".reqforge")
    }

    /// Open the workspace at `root`, creating it if needed.
    pub fn open(root: &Path) -> Res<Workspace> {
        fs::create_dir_all(root).map_err(|e| StoreError::bad(format!("{}: {e}", root.display())))?;
        let root = canon(root);
        let file = root.join(WORKSPACE_FILE);
        let reg: Registry = if file.exists() {
            serde_json::from_str(&fs::read_to_string(&file).map_err(|e| StoreError::bad(e.to_string()))?)
                .map_err(|e| StoreError::bad(format!("{WORKSPACE_FILE}: {e}")))?
        } else {
            let r = Registry { version: 1, ..Default::default() };
            fs::write(&file, dump(&serde_json::to_value(&r).unwrap())).map_err(|e| StoreError::bad(e.to_string()))?;
            r
        };
        Ok(Workspace { root, single: false, reg: RwLock::new(reg), stores: Mutex::new(HashMap::new()), write: Mutex::new(()) })
    }

    /// Single-project mode around an existing repository (no registry file; create/delete disabled).
    pub fn single(store: Store) -> Workspace {
        let key = store.config_value()["key"].as_str().unwrap_or("PROJ").to_string();
        let name = store.config_value()["name"].as_str().unwrap_or("").to_string();
        let root = store.root.clone();
        let entry = Entry { key: key.clone(), name, path: root.display().to_string(), created: String::new() };
        let ws = Workspace {
            root: root.clone(),
            single: true,
            reg: RwLock::new(Registry { version: 1, default: Some(key.clone()), projects: vec![entry] }),
            stores: Mutex::new(HashMap::new()),
            write: Mutex::new(()),
        };
        ws.stores.lock().unwrap().insert(key, Arc::new(store));
        ws
    }

    fn save(&self, reg: &Registry) -> Res<()> {
        if self.single {
            return Ok(());
        }
        let file = self.root.join(WORKSPACE_FILE);
        let tmp = file.with_extension("json.tmp");
        fs::write(&tmp, dump(&serde_json::to_value(reg).unwrap())).map_err(|e| StoreError::bad(e.to_string()))?;
        fs::rename(&tmp, &file).map_err(|e| StoreError::bad(e.to_string()))
    }

    fn guard_multi(&self) -> Res<()> {
        if self.single {
            return Err(StoreError::bad("server is in single-project mode (started with --repo); start it with --workspace to manage projects"));
        }
        Ok(())
    }

    pub fn abs(&self, e: &Entry) -> PathBuf {
        let p = PathBuf::from(&e.path);
        if p.is_absolute() {
            p
        } else {
            self.root.join(p)
        }
    }

    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.root).map(|r| r.display().to_string()).unwrap_or_else(|_| p.display().to_string())
    }

    pub fn entry(&self, key: &str) -> Res<Entry> {
        self.reg
            .read()
            .unwrap()
            .projects
            .iter()
            .find(|e| e.key.eq_ignore_ascii_case(key))
            .cloned()
            .ok_or_else(|| StoreError::new(format!("project {key} not found"), 404))
    }

    pub fn default_key(&self) -> Option<String> {
        let reg = self.reg.read().unwrap();
        reg.default
            .clone()
            .filter(|d| reg.projects.iter().any(|e| &e.key == d))
            .or_else(|| reg.projects.first().map(|e| e.key.clone()))
    }

    pub fn store(&self, key: &str) -> Res<Arc<Store>> {
        let e = self.entry(key)?;
        let mut stores = self.stores.lock().unwrap();
        if let Some(s) = stores.get(&e.key) {
            if s.root.join(CONFIG_FILE).exists() {
                return Ok(s.clone());
            }
            stores.remove(&e.key);
        }
        let s = Arc::new(Store::open(self.abs(&e)).map_err(|err| {
            StoreError::new(format!("project {} at {} is unavailable: {}", e.key, self.abs(&e).display(), err.message), 410)
        })?);
        stores.insert(e.key.clone(), s.clone());
        Ok(s)
    }

    pub fn describe(&self, e: &Entry) -> Value {
        let path = self.abs(e);
        let ok = path.join(CONFIG_FILE).exists();
        let remote = if ok { remote_url(&path) } else { None };
        json!({"key": e.key, "name": e.name, "path": path.display().to_string(), "created": e.created,
               "default": self.default_key().as_deref() == Some(e.key.as_str()), "available": ok,
               "remote": remote, "github": remote.as_deref().and_then(github_slug), "artifacts": artifacts(&path)})
    }

    pub fn list(&self) -> Value {
        let reg = self.reg.read().unwrap().clone();
        json!({"workspace": self.root.display().to_string(), "single": self.single, "default": self.default_key(),
               "projects": reg.projects.iter().map(|e| self.describe(e)).collect::<Vec<_>>()})
    }

    // reqforge: implements REQ-0018
    pub fn create(&self, key: &str, name: &str, github: Option<&str>, private: bool) -> Res<Value> {
        self.guard_multi()?;
        let key = key.trim().to_uppercase();
        if !valid_key(&key) {
            return Err(StoreError::bad(format!("invalid project key '{key}': 2–16 chars, A–Z first, then A–Z 0–9 _ -")));
        }
        let name = if name.trim().is_empty() { key.clone() } else { name.trim().to_string() };
        let _g = self.write.lock().unwrap();
        if self.entry(&key).is_ok() {
            return Err(StoreError::new(format!("project {key} already exists"), 409));
        }
        let path = self.root.join(key.to_lowercase());
        if path.exists() && fs::read_dir(&path).map(|mut d| d.next().is_some()).unwrap_or(false) {
            return Err(StoreError::new(format!("{} already exists and is not empty", path.display()), 409));
        }
        let store = Store::init(&path, &key, &name, github.filter(|g| !g.is_empty()), private)?;
        let entry = Entry { key: key.clone(), name, path: self.rel(&store.root), created: now() };
        {
            let mut reg = self.reg.write().unwrap();
            reg.projects.push(entry.clone());
            if reg.default.is_none() {
                reg.default = Some(key.clone());
            }
            self.save(&reg)?;
        }
        self.stores.lock().unwrap().insert(key, Arc::new(store));
        Ok(self.describe(&entry))
    }

    // reqforge: implements REQ-0018
    /// Register an existing reqforge repository (anywhere on disk) as a project.
    pub fn import(&self, path: &Path, key: Option<&str>) -> Res<Value> {
        self.guard_multi()?;
        let store = Store::open(path)?;
        let cfg = store.config_value();
        let key = key.map(str::to_uppercase).unwrap_or_else(|| cfg["key"].as_str().unwrap_or("").to_uppercase());
        if !valid_key(&key) {
            return Err(StoreError::bad(format!("invalid project key '{key}'; pass one explicitly")));
        }
        let _g = self.write.lock().unwrap();
        if self.entry(&key).is_ok() {
            return Err(StoreError::new(format!("project {key} already exists"), 409));
        }
        if self.reg.read().unwrap().projects.iter().any(|e| canon(&self.abs(e)) == store.root) {
            return Err(StoreError::new(format!("{} is already registered", store.root.display()), 409));
        }
        let entry = Entry { key: key.clone(), name: cfg["name"].as_str().unwrap_or(&key).to_string(), path: self.rel(&store.root), created: now() };
        {
            let mut reg = self.reg.write().unwrap();
            reg.projects.push(entry.clone());
            if reg.default.is_none() {
                reg.default = Some(key.clone());
            }
            self.save(&reg)?;
        }
        self.stores.lock().unwrap().insert(key, Arc::new(store));
        Ok(self.describe(&entry))
    }

    pub fn rename(&self, key: &str, name: &str) -> Res<Value> {
        let e = self.entry(key)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::bad("name must not be empty"));
        }
        let store = self.store(&e.key)?;
        let mut patch = serde_json::Map::new();
        patch.insert("name".into(), json!(name));
        store.save_config(&patch)?;
        let _g = self.write.lock().unwrap();
        let mut reg = self.reg.write().unwrap();
        if let Some(x) = reg.projects.iter_mut().find(|x| x.key == e.key) {
            x.name = name.to_string();
        }
        self.save(&reg)?;
        let entry = reg.projects.iter().find(|x| x.key == e.key).cloned().unwrap();
        drop(reg);
        Ok(self.describe(&entry))
    }

    pub fn set_default(&self, key: &str) -> Res<Value> {
        self.guard_multi()?;
        let e = self.entry(key)?;
        let _g = self.write.lock().unwrap();
        let mut reg = self.reg.write().unwrap();
        reg.default = Some(e.key.clone());
        self.save(&reg)?;
        drop(reg);
        Ok(self.list())
    }

    // reqforge: implements REQ-0019
    /// Delete a project and everything it holds. `confirm` must equal the key. When
    /// `delete_remote` is set and the project has a GitHub remote, `gh repo delete` is run too.
    pub fn delete(&self, key: &str, confirm: &str, delete_remote: bool) -> Res<Value> {
        self.guard_multi()?;
        let e = self.entry(key)?;
        if confirm != e.key {
            return Err(StoreError::bad(format!("confirmation does not match: type the project key {} to delete it", e.key)));
        }
        let path = canon(&self.abs(&e));
        // safety: only ever remove a reqforge repository, never the workspace itself or an ancestor of it
        if path.exists() {
            if !path.join(CONFIG_FILE).exists() {
                return Err(StoreError::new(format!("{} is not a reqforge repository; refusing to delete it", path.display()), 409));
            }
            if self.root.starts_with(&path) {
                return Err(StoreError::new(format!("{} contains the workspace; refusing to delete it", path.display()), 409));
            }
        }
        let _g = self.write.lock().unwrap();
        let removed = artifacts(&path);
        let remote = if path.exists() { remote_url(&path) } else { None };
        // hold the project's write lock so no write lands mid-delete
        let store = self.stores.lock().unwrap().remove(&e.key);
        let _lock = match &store {
            Some(s) => s.lock().ok(),
            None => None,
        };
        {
            let mut reg = self.reg.write().unwrap();
            reg.projects.retain(|x| x.key != e.key);
            if reg.default.as_deref() == Some(e.key.as_str()) {
                reg.default = reg.projects.first().map(|x| x.key.clone());
            }
            self.save(&reg)?;
        }
        drop(_lock);
        drop(store);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|err| StoreError::bad(format!("deregistered {} but could not remove {}: {err}", e.key, path.display())))?;
        }
        let mut remote_result = Value::Null;
        if delete_remote {
            remote_result = match remote.as_deref().and_then(github_slug) {
                None => json!({"deleted": false, "reason": "no GitHub remote"}),
                Some(slug) => match Command::new("gh").args(["repo", "delete", &slug, "--yes"]).output() {
                    Ok(o) if o.status.success() => json!({"deleted": true, "repo": slug}),
                    Ok(o) => json!({"deleted": false, "repo": slug, "error": String::from_utf8_lossy(&o.stderr).trim().to_string()}),
                    Err(err) => json!({"deleted": false, "repo": slug, "error": err.to_string()}),
                },
            };
        }
        Ok(json!({"deleted": e.key, "path": path.display().to_string(), "removed": removed, "remote": remote,
                  "remote_deleted": remote_result, "default": self.default_key()}))
    }
}

/// Resolve the project a CLI/MCP command acts on:
/// 1. explicit repo path   2. explicit project key (or REQFORGE_PROJECT) in the workspace
/// 3. REQFORGE_REPO / a reqforge.json (or .reqforge-repo pointer) above the cwd
/// 4. the workspace's default project.
pub fn resolve(repo: Option<&Path>, project: Option<&str>, workspace: Option<&Path>) -> Res<Arc<Store>> {
    if let Some(r) = repo {
        return Ok(Arc::new(Store::open(r)?));
    }
    let env_project = std::env::var("REQFORGE_PROJECT").ok().filter(|s| !s.is_empty());
    let ws_root = || Workspace::locate(workspace).unwrap_or_else(Workspace::default_root);
    if let Some(key) = project.map(String::from).or(env_project) {
        let root = ws_root();
        if !root.join(WORKSPACE_FILE).exists() {
            return Err(StoreError::new(format!("no workspace at {} (create a project first)", root.display()), 404));
        }
        return Workspace::open(&root)?.store(&key);
    }
    match Store::discover(None) {
        Ok(s) => Ok(Arc::new(s)),
        Err(e) => {
            let root = ws_root();
            if root.join(WORKSPACE_FILE).exists() {
                let ws = Workspace::open(&root)?;
                if let Some(k) = ws.default_key() {
                    return ws.store(&k);
                }
                return Err(StoreError::new(format!("workspace {} has no projects; run `reqforge project create KEY --name NAME`", root.display()), 404));
            }
            Err(e)
        }
    }
}
