//! File-backed record store. One JSON file per record, laid out for clean git diffs.
//!
//! <repo>/reqforge.json            project config (key, gates, coverage waivers, cicd)
//! <repo>/requirements/REQ-0001.json, epics/, stories/, tasks/
//! <repo>/sessions/ELI-0001.md     elicitation transcripts
//! <repo>/changesets/CS-0001.json  proposed / applied change batches

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use fs2::FileExt;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::model::{coerce, defaults, is_system, schema, validate, FType, Kind, Rec, KINDS};

pub const CONFIG_FILE: &str = "reqforge.json";

pub fn default_config() -> Value {
    json!({
        "key": "PROJ",
        "name": "Untitled project",
        "autocommit": true,
        "gates": {
            "min_requirement_coverage": 1.0,
            "min_criteria_coverage": 0.8,
            "require_evals_for_code": true
        },
        "coverage_waivers": {},
        "components": {},
        "cicd": {
            "requirements_repo": "",
            "reqforge_git": "",
            "setup_steps": [],
            "deploy_command": "",
            "monitor_cron": "*/30 * * * *"
        }
    })
}

// ------------------------------------------------------------------------- errors

#[derive(Debug, Clone)]
pub struct StoreError {
    pub message: String,
    pub status: u16,
    pub details: Vec<Value>,
}

impl StoreError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        StoreError { message: message.into(), status, details: vec![] }
    }
    pub fn with(message: impl Into<String>, status: u16, details: Vec<Value>) -> Self {
        StoreError { message: message.into(), status, details }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(message, 400)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for StoreError {}
impl From<String> for StoreError {
    fn from(s: String) -> Self {
        StoreError::bad(s)
    }
}

pub type Res<T> = Result<T, StoreError>;

// ------------------------------------------------------------------------- helpers

pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

pub fn dump(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default() + "\n"
}

pub fn as_list(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(|x| json!(x)).collect(),
        Value::Null => vec![],
        other => vec![other.clone()],
    }
}

/// Split free text into words and `field:value` filters (merged over `where`).
pub fn parse_query(q: &str, where_: &Map<String, Value>) -> (Vec<String>, Map<String, Value>) {
    let mut w = where_.clone();
    let mut words = vec![];
    for tok in q.split_whitespace() {
        if tok.contains(':') && !tok.starts_with("http") {
            let (f, v) = tok.split_once(':').unwrap();
            w.insert(f.to_string(), json!(v));
        } else {
            words.push(tok.to_lowercase());
        }
    }
    (words, w)
}

fn val_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.to_lowercase(),
        Value::Null => "none".into(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string().to_lowercase(),
    }
}

pub fn matches(value: Option<&Value>, wanted: &Value) -> bool {
    let wanted = match wanted {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let options: Vec<String> = wanted.split('|').map(|o| o.to_lowercase()).collect();
    if let Some(Value::Array(a)) = value {
        return a.iter().any(|v| options.contains(&val_str(v)));
    }
    if wanted.is_empty() || wanted == "none" || wanted == "null" {
        return crate::model::is_empty(value);
    }
    options.contains(&val_str(value.unwrap_or(&Value::Null)))
}

pub fn keep(rec: &Rec, blob: &str, words: &[String], where_: &Map<String, Value>) -> bool {
    where_.iter().all(|(f, v)| matches(rec.get(f), v)) && words.iter().all(|w| blob.contains(w.as_str()))
}

// ------------------------------------------------------------------------- source

/// Read access that lint/trace/impact need; implemented by Store and by the
/// in-memory overlay used to simulate changesets.
pub trait Source {
    fn records(&self, kind: Kind) -> Vec<Arc<Rec>>;
    fn config(&self) -> Value;
    fn exists(&self, kind: Kind, id: &str) -> bool;
    /// Design documents (design/<slug>.md) in the repository.
    fn design_docs(&self) -> Vec<crate::design::DesignDoc> {
        vec![]
    }
}

pub struct Entry {
    pub rec: Arc<Rec>,
    pub blob: String,
}

type FileCache = BTreeMap<String, (u128, u64, Arc<Entry>)>;
/// name -> (repository revision it was computed at, value)
type Memo = HashMap<String, (Vec<u64>, Arc<Value>)>;

pub struct Store {
    pub root: PathBuf,
    config: RwLock<Value>,
    files: Mutex<HashMap<Kind, FileCache>>,
    memo: Mutex<Memo>,
    write: Mutex<()>,
}

pub struct WriteGuard<'a> {
    _g: MutexGuard<'a, ()>,
    _f: File,
}

impl Source for Store {
    fn records(&self, kind: Kind) -> Vec<Arc<Rec>> {
        self.entries(kind).into_iter().map(|e| e.rec.clone()).collect()
    }
    fn config(&self) -> Value {
        self.config.read().unwrap().clone()
    }
    fn exists(&self, kind: Kind, id: &str) -> bool {
        self.path(kind, id).exists()
    }
    fn design_docs(&self) -> Vec<crate::design::DesignDoc> {
        crate::design::list(&self.root)
    }
}

impl Store {
    pub fn open(root: impl AsRef<Path>) -> Res<Store> {
        let root = fs::canonicalize(root.as_ref()).unwrap_or_else(|_| root.as_ref().to_path_buf());
        let cfg = root.join(CONFIG_FILE);
        if !cfg.exists() {
            return Err(StoreError::new(
                format!("{} is not a reqforge repository (no {CONFIG_FILE}); run `reqforge init`", root.display()),
                404,
            ));
        }
        let file: Value = serde_json::from_str(&fs::read_to_string(&cfg).map_err(|e| StoreError::bad(e.to_string()))?)
            .map_err(|e| StoreError::bad(format!("{CONFIG_FILE}: {e}")))?;
        let mut config = default_config();
        if let (Some(c), Some(f)) = (config.as_object_mut(), file.as_object()) {
            for (k, v) in f {
                c.insert(k.clone(), v.clone());
            }
        }
        Ok(Store {
            root,
            config: RwLock::new(config),
            files: Mutex::new(HashMap::new()),
            memo: Mutex::new(HashMap::new()),
            write: Mutex::new(()),
        })
    }

    pub fn discover(start: Option<&Path>) -> Res<Store> {
        if let Ok(env) = std::env::var("REQFORGE_REPO") {
            if !env.is_empty() {
                return Store::open(env);
            }
        }
        let here = start.map(Path::to_path_buf).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let here = fs::canonicalize(&here).unwrap_or(here);
        for d in here.ancestors() {
            if d.join(CONFIG_FILE).exists() {
                return Store::open(d);
            }
            let ptr = d.join(".reqforge-repo");
            if ptr.exists() {
                let rel = fs::read_to_string(&ptr).unwrap_or_default();
                return Store::open(d.join(rel.trim()));
            }
        }
        Err(StoreError::new("no reqforge repository found (set REQFORGE_REPO or run `reqforge init`)", 404))
    }

    pub fn init(root: impl AsRef<Path>, key: &str, name: &str, github: Option<&str>, private: bool) -> Res<Store> {
        let root = root.as_ref();
        fs::create_dir_all(root).map_err(|e| StoreError::bad(e.to_string()))?;
        let cfgp = root.join(CONFIG_FILE);
        if !cfgp.exists() {
            let mut cfg = default_config();
            cfg["key"] = json!(key.to_uppercase());
            cfg["name"] = json!(name);
            fs::write(&cfgp, dump(&cfg)).map_err(|e| StoreError::bad(e.to_string()))?;
        }
        for d in KINDS.iter().map(|k| k.dir()).chain(["sessions", "changesets"]) {
            let p = root.join(d);
            fs::create_dir_all(&p).ok();
            let keep = p.join(".gitkeep");
            if !keep.exists() {
                fs::write(keep, "").ok();
            }
        }
        let readme = root.join("README.md");
        if !readme.exists() {
            fs::write(
                readme,
                format!(
                    "# {name} — requirements\n\nManaged by reqforge. Edit with `reqforge serve` (UI), `reqforge console`, \
                     the CLI, or the REST API. Records are JSON; one file per record.\n"
                ),
            )
            .ok();
        }
        git::ensure_repo(root);
        git::commit_all(root, "reqforge: initialise requirements repository");
        if let Some(slug) = github {
            git::create_remote(root, slug, private).map_err(StoreError::bad)?;
        }
        Store::open(root)
    }

    pub fn config_value(&self) -> Value {
        self.config.read().unwrap().clone()
    }

    pub fn cfg_bool(&self, k: &str, default: bool) -> bool {
        self.config.read().unwrap().get(k).and_then(Value::as_bool).unwrap_or(default)
    }

    pub fn save_config(&self, patch: &Map<String, Value>) -> Res<Value> {
        let _g = self.lock()?;
        let cfg = {
            let mut c = self.config.write().unwrap();
            for (k, v) in patch {
                c[k] = v.clone();
            }
            c.clone()
        };
        fs::write(self.root.join(CONFIG_FILE), dump(&cfg)).map_err(|e| StoreError::bad(e.to_string()))?;
        self.commit(&format!("reqforge: update config ({})", patch.keys().cloned().collect::<Vec<_>>().join(", ")));
        Ok(cfg)
    }

    // ------------------------------------------------------------ internals
    /// Process + cross-process write lock. Not reentrant: inner `*_unlocked` helpers never take it.
    pub fn lock(&self) -> Res<WriteGuard<'_>> {
        let g = self.write.lock().unwrap_or_else(|p| p.into_inner());
        let f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(self.root.join(".reqforge.lock"))
            .map_err(|e| StoreError::bad(e.to_string()))?;
        f.lock_exclusive().map_err(|e| StoreError::bad(e.to_string()))?;
        Ok(WriteGuard { _g: g, _f: f })
    }

    pub fn path(&self, kind: Kind, id: &str) -> PathBuf {
        self.root.join(kind.dir()).join(format!("{id}.json"))
    }

    fn next_id(&self, kind: Kind) -> String {
        let re = Regex::new(&format!(r"^{}-(\d+)\.json$", kind.prefix())).unwrap();
        let max = fs::read_dir(self.root.join(kind.dir()))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| re.captures(&e.file_name().to_string_lossy()).and_then(|c| c[1].parse::<u64>().ok()))
            .max()
            .unwrap_or(0);
        format!("{}-{:04}", kind.prefix(), max + 1)
    }

    // reqforge: implements REQ-0037
    // reqforge: implements REQ-0042
    pub fn write_unlocked(&self, kind: Kind, rec: &Rec) -> Res<()> {
        let mut ordered = Map::new();
        if let Some(id) = rec.get("id") {
            ordered.insert("id".into(), id.clone());
        }
        for f in schema(kind) {
            if let Some(v) = rec.get(f.name) {
                ordered.insert(f.name.into(), v.clone());
            }
        }
        for (k, v) in rec {
            if !ordered.contains_key(k) {
                ordered.insert(k.clone(), v.clone());
            }
        }
        let id = rec.get("id").and_then(Value::as_str).ok_or_else(|| StoreError::bad("record has no id"))?;
        let path = self.path(kind, id);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, dump(&Value::Object(ordered))).map_err(|e| StoreError::bad(e.to_string()))?;
        fs::rename(&tmp, &path).map_err(|e| StoreError::bad(e.to_string()))?;
        Ok(())
    }

    pub fn commit(&self, message: &str) {
        if self.cfg_bool("autocommit", true) {
            git::commit_all(&self.root, message);
        }
    }

    // reqforge: implements REQ-0004
    fn check(&self, kind: Kind, rec: &Rec) -> Res<()> {
        let exists = |k: Kind, id: &str| self.exists(k, id);
        let mut errors = validate(kind, rec, Some(&exists));
        if kind == Kind::Components {
            errors.extend(crate::model::component_key_clash(rec, &self.records(Kind::Components)));
        }
        if kind == Kind::Tasks && errors.is_empty() {
            errors.extend(crate::model::task_dependency_errors(rec, &self.records(Kind::Tasks)));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            let id = rec.get("id").and_then(Value::as_str).unwrap_or("");
            Err(StoreError::with(
                format!("invalid {} {}", kind.singular(), id).trim().to_string(),
                422,
                errors.into_iter().map(Value::String).collect(),
            ))
        }
    }

    // ------------------------------------------------------------ reads
    // reqforge: implements REQ-0039
    /// Refresh the per-file cache: only files whose mtime/size changed are re-read, so reads
    /// stay cheap with thousands of records and still see external edits (git pull).
    pub fn entries(&self, kind: Kind) -> Vec<Arc<Entry>> {
        let dir = self.root.join(kind.dir());
        let mut files = self.files.lock().unwrap();
        let cache = files.entry(kind).or_default();
        let mut seen: FileCache = BTreeMap::new();
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let size = md.len();
            if let Some(hit) = cache.get(&name) {
                if hit.0 == mtime && hit.1 == size {
                    seen.insert(name, hit.clone());
                    continue;
                }
            }
            let Ok(text) = fs::read_to_string(e.path()) else { continue };
            let Ok(Value::Object(rec)) = serde_json::from_str::<Value>(&text) else { continue };
            let blob = serde_json::to_string(&rec).unwrap_or_default().to_lowercase();
            seen.insert(name, (mtime, size, Arc::new(Entry { rec: Arc::new(rec), blob })));
        }
        *cache = seen;
        cache.values().map(|v| v.2.clone()).collect()
    }

    pub fn all(&self, kind: Kind) -> Vec<Arc<Rec>> {
        self.records(kind)
    }

    /// Cheap signature of the whole repository state, for memoising derived views.
    pub fn revision(&self) -> Vec<u64> {
        let cfg_m = fs::metadata(self.root.join(CONFIG_FILE))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let mut sig = vec![cfg_m];
        // derived artefacts that verification and lint depend on: code indexes, evidence, design docs
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for d in ["code", "evidence", crate::design::DIR] {
            for e in fs::read_dir(self.root.join(d)).into_iter().flatten().flatten() {
                if let Ok(md) = e.metadata() {
                    (e.file_name().to_string_lossy().to_string(), md.len(), md.modified().ok()).hash(&mut h);
                }
            }
        }
        sig.push(h.finish());
        for k in KINDS {
            self.entries(k);
            let files = self.files.lock().unwrap();
            let mut h = std::collections::hash_map::DefaultHasher::new();
            if let Some(c) = files.get(&k) {
                for (n, v) in c {
                    (n, v.0, v.1).hash(&mut h);
                }
            }
            sig.push(h.finish());
        }
        sig
    }

    pub fn memo(&self, name: &str, f: impl FnOnce() -> Value) -> Arc<Value> {
        let rev = self.revision();
        if let Some((r, v)) = self.memo.lock().unwrap().get(name) {
            if *r == rev {
                return v.clone();
            }
        }
        let v = Arc::new(f());
        self.memo.lock().unwrap().insert(name.into(), (rev, v.clone()));
        v
    }

    pub fn get(&self, kind: Kind, id: &str) -> Res<Rec> {
        self.entries(kind)
            .into_iter()
            .find(|e| e.rec.get("id").and_then(Value::as_str) == Some(id))
            .map(|e| (*e.rec).clone())
            .ok_or_else(|| StoreError::new(format!("{id} not found"), 404))
    }

    // reqforge: implements REQ-0006
    /// Free-text search. Tokens like field:value (or field:a|b) filter exactly;
    /// other tokens must each appear (case-insensitive) somewhere in the record.
    pub fn search(&self, kind: Kind, q: &str, where_: &Map<String, Value>) -> Vec<Arc<Rec>> {
        let (words, w) = parse_query(q, where_);
        self.entries(kind).into_iter().filter(|e| keep(&e.rec, &e.blob, &words, &w)).map(|e| e.rec.clone()).collect()
    }

    // ------------------------------------------------------------ writes
    pub fn create(&self, kind: Kind, data: &Rec, message: Option<&str>) -> Res<Rec> {
        let _g = self.lock()?;
        let rec = self.create_unlocked(kind, data)?;
        self.commit(message.unwrap_or(&format!("{}: create — {}", s(&rec, "id"), s(&rec, "title"))));
        Ok(rec)
    }

    // reqforge: implements REQ-0003
    pub fn create_unlocked(&self, kind: Kind, data: &Rec) -> Res<Rec> {
        let mut body = defaults(kind);
        for (k, v) in data {
            if !is_system(k) {
                body.insert(k.clone(), coerce(kind, k, v.clone()));
            }
        }
        let id = data.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| self.next_id(kind));
        if self.path(kind, &id).exists() {
            return Err(StoreError::new(format!("{id} already exists"), 409));
        }
        let t = now();
        let mut rec = Rec::new();
        rec.insert("id".into(), json!(id));
        rec.extend(body);
        rec.insert("version".into(), json!(1));
        rec.insert("created".into(), json!(t));
        rec.insert("updated".into(), json!(t));
        self.check(kind, &rec)?;
        self.write_unlocked(kind, &rec)?;
        Ok(rec)
    }

    pub fn update(&self, kind: Kind, id: &str, patch: &Rec, expected_version: Option<i64>, message: Option<&str>) -> Res<Rec> {
        let _g = self.lock()?;
        let rec = self.apply_unlocked(kind, id, patch, expected_version, None, None)?;
        self.write_unlocked(kind, &rec)?;
        let fields: Vec<&str> = patch.keys().map(String::as_str).filter(|k| !is_system(k)).collect();
        self.commit(message.unwrap_or(&format!("{id}: update {}", fields.join(", "))));
        Ok(rec)
    }

    // reqforge: implements REQ-0005
    pub fn apply_unlocked(
        &self,
        kind: Kind,
        id: &str,
        patch: &Rec,
        expected_version: Option<i64>,
        add: Option<&Rec>,
        remove: Option<&Rec>,
    ) -> Res<Rec> {
        let cur = self.get(kind, id)?;
        let cur_v = cur.get("version").and_then(Value::as_i64).unwrap_or(0);
        if let Some(ev) = expected_version {
            if ev != cur_v {
                return Err(StoreError::new(
                    format!("{id} was modified (version {cur_v}, you had {ev}); reload and retry"),
                    409,
                ));
            }
        }
        let mut rec = cur.clone();
        for (k, v) in patch {
            if !is_system(k) {
                rec.insert(k.clone(), coerce(kind, k, v.clone()));
            }
        }
        for (k, vals) in add.into_iter().flatten() {
            let mut list: Vec<Value> = rec.get(k).map(as_list).unwrap_or_default();
            for v in as_list(vals) {
                if !list.contains(&v) {
                    list.push(v);
                }
            }
            rec.insert(k.clone(), Value::Array(list));
        }
        for (k, vals) in remove.into_iter().flatten() {
            let drop = as_list(vals);
            let list: Vec<Value> = rec.get(k).map(as_list).unwrap_or_default().into_iter().filter(|v| !drop.contains(v)).collect();
            rec.insert(k.clone(), Value::Array(list));
        }
        rec.insert("version".into(), json!(cur_v + 1));
        rec.insert("updated".into(), json!(now()));
        self.check(kind, &rec)?;
        Ok(rec)
    }

    // reqforge: implements REQ-0007
    /// Mass update. Validates every record first; writes all or nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn bulk_update(
        &self,
        kind: Kind,
        ids: Option<Vec<String>>,
        q: &str,
        where_: &Map<String, Value>,
        set: &Rec,
        add: &Rec,
        remove: &Rec,
        dry_run: bool,
        message: Option<&str>,
    ) -> Res<Value> {
        let _g = self.lock()?;
        let targets: Vec<String> = match ids {
            Some(ids) if !ids.is_empty() => ids,
            _ => self.search(kind, q, where_).iter().map(|r| s(r, "id").to_string()).collect(),
        };
        if targets.is_empty() {
            return Ok(json!({"matched": 0, "changed": [], "dry_run": dry_run}));
        }
        let mut new = vec![];
        let mut errors = vec![];
        for id in &targets {
            match self.apply_unlocked(kind, id, set, None, Some(add), Some(remove)) {
                Ok(r) => new.push(r),
                Err(e) => errors.push(json!({"id": id, "error": e.message, "details": e.details})),
            }
        }
        if !errors.is_empty() {
            return Err(StoreError::with(
                format!("bulk update rejected: {} of {} records invalid", errors.len(), targets.len()),
                422,
                errors,
            ));
        }
        if !dry_run {
            for r in &new {
                self.write_unlocked(kind, r)?;
            }
            let what: Vec<String> = set
                .keys()
                .cloned()
                .chain(add.keys().map(|k| format!("+{k}")))
                .chain(remove.keys().map(|k| format!("-{k}")))
                .collect();
            self.commit(message.unwrap_or(&format!("bulk: {} on {} {}", what.join(", "), new.len(), kind.as_str())));
        }
        Ok(json!({"matched": targets.len(), "changed": new.iter().map(|r| s(r, "id")).collect::<Vec<_>>(), "dry_run": dry_run}))
    }

    /// Create rows without an id / unknown id; patch rows whose id exists. One commit.
    pub fn upsert_many(&self, kind: Kind, rows: &[Rec], message: Option<&str>) -> Res<Value> {
        let _g = self.lock()?;
        let (mut created, mut updated) = (vec![], vec![]);
        for row in rows {
            match row.get("id").and_then(Value::as_str) {
                Some(id) if self.path(kind, id).exists() => {
                    let rec = self.apply_unlocked(kind, id, row, None, None, None)?;
                    self.write_unlocked(kind, &rec)?;
                    updated.push(id.to_string());
                }
                _ => created.push(s(&self.create_unlocked(kind, row)?, "id").to_string()),
            }
        }
        self.commit(message.unwrap_or(&format!(
            "import: {} created, {} updated {}",
            created.len(),
            updated.len(),
            kind.as_str()
        )));
        Ok(json!({"created": created, "updated": updated}))
    }

    pub fn delete(&self, kind: Kind, id: &str, force: bool) -> Res<Value> {
        let _g = self.lock()?;
        self.get(kind, id)?;
        let refs = self.references_to(id);
        if !refs.is_empty() && !force {
            return Err(StoreError::with(
                format!("{id} is referenced by {}; pass force to delete anyway", refs.join(", ")),
                409,
                refs.iter().map(|r| json!(r)).collect(),
            ));
        }
        fs::remove_file(self.path(kind, id)).map_err(|e| StoreError::bad(e.to_string()))?;
        self.commit(&format!("{id}: delete"));
        Ok(json!({"deleted": id, "dangling": refs}))
    }

    pub fn references_to(&self, id: &str) -> Vec<String> {
        let mut refs = vec![];
        for k in KINDS {
            for rec in self.records(k) {
                for f in schema(k) {
                    let hit = match f.ftype {
                        FType::Ref => rec.get(f.name).and_then(Value::as_str) == Some(id),
                        FType::RefList => crate::model::strs(&rec, f.name).contains(&id),
                        _ => false,
                    };
                    if hit {
                        refs.push(s(&rec, "id").to_string());
                        break;
                    }
                }
            }
        }
        refs
    }

    // ------------------------------------------------------------ sessions
    pub fn save_session(&self, title: &str, markdown: &str, id: Option<&str>) -> Res<String> {
        let _g = self.lock()?;
        let d = self.root.join("sessions");
        fs::create_dir_all(&d).ok();
        let id = match id.filter(|s| !s.is_empty()) {
            Some(i) => i.to_string(),
            None => {
                let re = Regex::new(r"^ELI-(\d+)\.md$").unwrap();
                let max = fs::read_dir(&d)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| re.captures(&e.file_name().to_string_lossy()).and_then(|c| c[1].parse::<u64>().ok()))
                    .max()
                    .unwrap_or(0);
                format!("ELI-{:04}", max + 1)
            }
        };
        fs::write(d.join(format!("{id}.md")), format!("# {id} — {title}\n\n{}\n", markdown.trim()))
            .map_err(|e| StoreError::bad(e.to_string()))?;
        self.commit(&format!("{id}: elicitation session — {title}"));
        Ok(id)
    }

    pub fn sessions(&self) -> Vec<Value> {
        let mut names: Vec<PathBuf> = fs::read_dir(self.root.join("sessions"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("ELI-")).unwrap_or(false))
            .collect();
        names.sort();
        names
            .iter()
            .map(|p| {
                let id = p.file_stem().unwrap().to_string_lossy().to_string();
                let first = fs::read_to_string(p).unwrap_or_default().lines().next().unwrap_or("").to_string();
                let title = first.trim_start_matches(['#', ' ']).split_once(" — ").map(|x| x.1.to_string()).unwrap_or(first);
                json!({"id": id, "title": title})
            })
            .collect()
    }

    pub fn sync(&self, message: &str) -> Res<Value> {
        let _g = self.lock()?;
        Ok(git::sync(&self.root, message))
    }
}

pub fn s<'a>(rec: &'a Rec, k: &str) -> &'a str {
    crate::model::s(rec, k)
}

// ============================================================================ git

/// GitHub persistence via git + gh. Every mutation is a commit (autocommit) and
/// `sync` rebases and pushes.
pub mod git {
    use super::*;

    fn run(root: &Path, args: &[&str]) -> Option<std::process::Output> {
        Command::new("git").arg("-C").arg(root).args(args).output().ok()
    }

    pub fn is_repo(root: &Path) -> bool {
        run(root, &["rev-parse", "--is-inside-work-tree"]).map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn ensure_repo(root: &Path) {
        if !is_repo(root) {
            run(root, &["init", "-q", "-b", "main"]);
        }
        let ignore = root.join(".gitignore");
        let existing = fs::read_to_string(&ignore).unwrap_or_default();
        let lines: Vec<&str> = existing.lines().collect();
        let missing: Vec<&str> = [".reqforge.lock", "*.json.tmp"].into_iter().filter(|p| !lines.contains(p)).collect();
        if !missing.is_empty() {
            let mut all: Vec<&str> = lines.clone();
            all.extend(missing);
            fs::write(ignore, all.join("\n") + "\n").ok();
        }
    }

    // reqforge: implements REQ-0035
    /// Commit everything under `root`, and only that: a requirements folder can live inside a
    /// code repository without sweeping up unrelated work in progress.
    pub fn commit_all(root: &Path, message: &str) -> bool {
        if !is_repo(root) {
            return false;
        }
        run(root, &["add", "-A", "--", "."]);
        let clean = run(root, &["diff", "--cached", "--quiet", "--", "."]).map(|o| o.status.success()).unwrap_or(true);
        if clean {
            return false;
        }
        run(root, &["commit", "-q", "-m", message, "--", "."]).map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn has_remote(root: &Path) -> bool {
        run(root, &["remote"]).map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty()).unwrap_or(false)
    }

    // reqforge: implements REQ-0035
    pub fn sync(root: &Path, message: &str) -> Value {
        if !is_repo(root) {
            return json!({"ok": false, "error": "not a git repository"});
        }
        let committed = commit_all(root, message);
        if !has_remote(root) {
            return json!({"ok": true, "committed": committed, "pushed": false, "note": "no remote configured"});
        }
        let branch = run(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "main".into());
        if let Some(pull) = run(root, &["pull", "--rebase", "--autostash", "origin", &branch]) {
            let err = String::from_utf8_lossy(&pull.stderr).to_string();
            if !pull.status.success() && !err.contains("couldn't find remote ref") {
                run(root, &["rebase", "--abort"]);
                return json!({"ok": false, "committed": committed, "error": format!("pull --rebase failed: {}", err.trim())});
            }
        }
        match run(root, &["push", "-u", "origin", &branch]) {
            Some(p) if p.status.success() => json!({"ok": true, "committed": committed, "pushed": true}),
            Some(p) => json!({"ok": false, "committed": committed,
                "error": format!("push failed: {}", String::from_utf8_lossy(&p.stderr).trim())}),
            None => json!({"ok": false, "committed": committed, "error": "git not available"}),
        }
    }

    /// Create (or attach to) a GitHub repo `owner/name` and push. A URL or path (https://…,
    /// git@…, /srv/repo.git, ./remote) is attached as `origin` as-is, without gh.
    // reqforge: implements REQ-0035
    pub fn create_remote(root: &Path, slug: &str, private: bool) -> Result<(), String> {
        if has_remote(root) {
            return Ok(());
        }
        let is_url = slug.contains("://") || slug.starts_with("git@") || slug.starts_with('/') || slug.starts_with('.') || slug.ends_with(".git");
        if is_url {
            run(root, &["remote", "add", "origin", slug]);
            let branch = run(root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|| "main".into());
            return match run(root, &["push", "-u", "origin", &branch]) {
                Some(o) if o.status.success() => Ok(()),
                Some(o) => Err(format!("push to {slug} failed: {}", String::from_utf8_lossy(&o.stderr).trim())),
                None => Err("git not available".into()),
            };
        }
        let gh = Command::new("gh").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !gh {
            run(root, &["remote", "add", "origin", &format!("git@github.com:{slug}.git")]);
            return Ok(());
        }
        let exists = Command::new("gh").args(["repo", "view", slug]).output().map(|o| o.status.success()).unwrap_or(false);
        if exists {
            run(root, &["remote", "add", "origin", &format!("https://github.com/{slug}.git")]);
            run(root, &["push", "-u", "origin", "main"]);
            Ok(())
        } else {
            let out = Command::new("gh")
                .args(["repo", "create", slug, if private { "--private" } else { "--public" }, "--source"])
                .arg(root)
                .arg("--push")
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!("gh repo create failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
            }
        }
    }
}
