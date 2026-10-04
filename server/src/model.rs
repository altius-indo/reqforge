//! Domain model: record kinds, the MECE requirement taxonomy, field schemas, validation.
//! Pure data + pure functions shared by the CLI, REST API, MCP server and UI metadata.

use serde_json::{json, Map, Value};

pub type Rec = Map<String, Value>;
/// Referential-integrity callback: does a record of `kind` with this id exist?
pub type Exists<'a> = &'a dyn Fn(Kind, &str) -> bool;

// --------------------------------------------------------------------------- kinds

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Requirements,
    Epics,
    Stories,
    Tasks,
    Components,
}

pub const KINDS: [Kind; 5] = [Kind::Requirements, Kind::Epics, Kind::Stories, Kind::Tasks, Kind::Components];

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Requirements => "requirements",
            Kind::Epics => "epics",
            Kind::Stories => "stories",
            Kind::Tasks => "tasks",
            Kind::Components => "components",
        }
    }
    pub fn prefix(self) -> &'static str {
        match self {
            Kind::Requirements => "REQ",
            Kind::Epics => "EPIC",
            Kind::Stories => "STORY",
            Kind::Tasks => "TASK",
            Kind::Components => "COMP",
        }
    }
    pub fn dir(self) -> &'static str {
        self.as_str()
    }
    pub fn singular(self) -> &'static str {
        match self {
            Kind::Requirements => "requirement",
            Kind::Epics => "epic",
            Kind::Stories => "story",
            Kind::Tasks => "task",
            Kind::Components => "component",
        }
    }
    pub fn parse(s: &str) -> Result<Kind, String> {
        match s.trim().to_lowercase().as_str() {
            "requirements" | "req" | "reqs" | "requirement" => Ok(Kind::Requirements),
            "epics" | "epic" => Ok(Kind::Epics),
            "stories" | "story" => Ok(Kind::Stories),
            "tasks" | "task" => Ok(Kind::Tasks),
            "components" | "component" | "comp" => Ok(Kind::Components),
            _ => Err(format!("unknown kind '{s}' (expected one of requirements, epics, stories, tasks, components)")),
        }
    }
    pub fn of_id(id: &str) -> Result<Kind, String> {
        let prefix = id.split('-').next().unwrap_or("").to_uppercase();
        KINDS
            .into_iter()
            .find(|k| k.prefix() == prefix)
            .ok_or_else(|| format!("cannot infer kind from id '{id}'"))
    }
}

// ------------------------------------------------------------------------ taxonomy
// Mutual exclusivity comes from a decision ORDER: a requirement takes the FIRST type
// whose test it passes. Collective exhaustiveness comes from functional being the
// catch-all plus the coverage check in lint (every category populated or waived).

pub struct TaxType {
    pub name: &'static str,
    pub order: u32,
    pub test: &'static str,
    pub categories: Option<&'static [(&'static str, &'static str)]>,
}

pub const TAXONOMY: [TaxType; 5] = [
    TaxType {
        name: "constraint",
        order: 1,
        test: "Is it imposed from outside the solution space and non-negotiable (law, contract, mandated technology, budget, physical environment)?",
        categories: Some(&[
            ("regulatory", "Laws, regulations, certifications (GDPR, HIPAA, PCI DSS, SOC 2, accessibility law)."),
            ("technology", "Mandated platforms, languages, vendors, licences."),
            ("business", "Budget, schedule, organisational policy, contractual terms."),
            ("environment", "Physical/operational environment the system must run in."),
        ]),
    },
    TaxType {
        name: "interface",
        order: 2,
        test: "Does it specify a boundary the system exposes or consumes (UI, API, protocol, external system, device)?",
        categories: Some(&[
            ("user-interface", "Screens, interaction flows, channels, localisation."),
            ("api", "Programmatic interfaces the system exposes."),
            ("integration", "External systems / third-party services consumed."),
            ("hardware", "Devices, sensors, physical I/O."),
        ]),
    },
    TaxType {
        name: "data",
        order: 3,
        test: "Is it about information the system stores: its structure, lifecycle, quality or migration?",
        categories: Some(&[
            ("model", "Entities, attributes, relationships, identifiers."),
            ("lifecycle", "Creation, retention, archival, deletion of data."),
            ("quality", "Accuracy, completeness, consistency, lineage."),
            ("migration", "Moving/transforming existing data."),
        ]),
    },
    TaxType {
        name: "quality",
        order: 4,
        test: "Does it say HOW WELL the system must do something (measurable characteristic)? Categories = ISO/IEC 25010:2023.",
        categories: Some(&[
            ("functional-suitability", "Completeness, correctness, appropriateness of functions."),
            ("performance-efficiency", "Time behaviour, resource utilisation, capacity."),
            ("compatibility", "Co-existence, interoperability."),
            ("interaction-capability", "Usability: learnability, operability, accessibility, error protection."),
            ("reliability", "Availability, fault tolerance, recoverability."),
            ("security", "Confidentiality, integrity, non-repudiation, accountability, authenticity."),
            ("maintainability", "Modularity, analysability, modifiability, testability."),
            ("flexibility", "Adaptability, scalability, installability, replaceability."),
            ("safety", "Operational constraint, risk identification, fail-safe, hazard warning."),
        ]),
    },
    TaxType {
        name: "functional",
        order: 5,
        test: "Otherwise: it states WHAT the system does (a behaviour or capability). Category = capability area.",
        categories: None,
    },
];

pub fn tax_type(name: &str) -> Option<&'static TaxType> {
    TAXONOMY.iter().find(|t| t.name == name)
}

pub const PRIORITIES: &[&str] = &["must", "should", "could", "wont"];
pub const REQ_STATUSES: &[&str] = &["draft", "proposed", "approved", "implemented", "verified", "deprecated"];
pub const WORK_STATUSES: &[&str] = &["todo", "in-progress", "blocked", "done"];
pub const STORY_DELIVERABLES: &[&str] = &["code", "design", "infrastructure", "documentation"];
pub const TASK_KINDS: &[&str] = &["design", "code", "deployment", "monitoring"];
pub const TYPES: &[&str] = &["constraint", "interface", "data", "quality", "functional"];

/// Eval kind -> pipeline stage. Stage order is the CI/CD order.
pub const EVAL_KINDS: &[(&str, &str)] = &[
    ("static", "commit"),
    ("unit", "commit"),
    ("contract", "commit"),
    ("integration", "acceptance"),
    ("e2e", "acceptance"),
    ("accessibility", "acceptance"),
    ("llm-judge", "acceptance"),
    ("security", "security"),
    ("performance", "performance"),
    ("smoke", "post-deploy"),
    ("synthetic-monitor", "monitor"),
];
pub const STAGES: &[&str] = &["commit", "acceptance", "security", "performance", "post-deploy", "monitor"];

pub fn eval_stage(kind: &str) -> Option<&'static str> {
    EVAL_KINDS.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s)
}

/// Quality categories whose requirements must be verified by an eval of a matching kind.
pub fn quality_eval_match(category: &str) -> Option<&'static [&'static str]> {
    match category {
        "performance-efficiency" => Some(&["performance"]),
        "security" => Some(&["security"]),
        "interaction-capability" => Some(&["accessibility", "e2e"]),
        "reliability" => Some(&["integration", "e2e", "synthetic-monitor", "smoke"]),
        _ => None,
    }
}

/// Vague terms ISO/IEC/IEEE 29148 calls out as unverifiable.
pub const VAGUE_TERMS: &[&str] = &[
    "user-friendly", "user friendly", "easy", "simple", "fast", "quick", "efficient", "robust", "flexible",
    "seamless", "intuitive", "adequate", "as appropriate", "as needed", "etc", "and/or", "minimal", "maximize",
    "minimize", "state-of-the-art", "scalable", "best", "support",
];

// --------------------------------------------------------------------------- schema

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FType {
    Str,
    Text,
    Enum,
    List,
    Ref,
    RefList,
    ObjList,
    Int,
}

impl FType {
    pub fn as_str(self) -> &'static str {
        match self {
            FType::Str => "str",
            FType::Text => "text",
            FType::Enum => "enum",
            FType::List => "list",
            FType::Ref => "ref",
            FType::RefList => "reflist",
            FType::ObjList => "objlist",
            FType::Int => "int",
        }
    }
    pub fn is_list(self) -> bool {
        matches!(self, FType::List | FType::RefList | FType::ObjList)
    }
}

pub struct Field {
    pub name: &'static str,
    pub ftype: FType,
    pub required: bool,
    pub values: &'static [&'static str],
    pub default: Option<&'static str>,
    pub ref_kind: Option<Kind>,
    pub keys: &'static [&'static str],
}

const fn f(name: &'static str, ftype: FType) -> Field {
    Field { name, ftype, required: false, values: &[], default: None, ref_kind: None, keys: &[] }
}
const fn req(mut x: Field) -> Field {
    x.required = true;
    x
}
const fn en(name: &'static str, values: &'static [&'static str], default: Option<&'static str>) -> Field {
    Field { name, ftype: FType::Enum, required: false, values, default, ref_kind: None, keys: &[] }
}
const fn rf(name: &'static str, ftype: FType, kind: Kind) -> Field {
    Field { name, ftype, required: false, values: &[], default: None, ref_kind: Some(kind), keys: &[] }
}
const fn ol(name: &'static str, keys: &'static [&'static str]) -> Field {
    Field { name, ftype: FType::ObjList, required: false, values: &[], default: None, ref_kind: None, keys }
}

static REQUIREMENTS: [Field; 14] = [
    req(f("title", FType::Str)),
    req(f("statement", FType::Text)),
    req(en("type", TYPES, None)),
    req(f("category", FType::Str)),
    en("priority", PRIORITIES, Some("should")),
    en("status", REQ_STATUSES, Some("draft")),
    f("rationale", FType::Text),
    ol("acceptance_criteria", &["id", "text"]),
    rf("parent", FType::Ref, Kind::Requirements),
    f("tags", FType::List),
    f("standards", FType::List),
    f("stakeholders", FType::List),
    f("source", FType::Str),
    f("notes", FType::Text),
];
static EPICS: [Field; 5] = [
    req(f("title", FType::Str)),
    f("description", FType::Text),
    rf("requirements", FType::RefList, Kind::Requirements),
    en("status", WORK_STATUSES, Some("todo")),
    f("tags", FType::List),
];
static STORIES: [Field; 11] = [
    req(f("title", FType::Str)),
    req(rf("epic", FType::Ref, Kind::Epics)),
    f("narrative", FType::Text),
    rf("requirements", FType::RefList, Kind::Requirements),
    en("deliverable", STORY_DELIVERABLES, Some("code")),
    f("component", FType::Str),
    ol("acceptance_criteria", &["id", "text"]),
    ol("evals", &["id", "name", "kind", "command"]),
    en("status", WORK_STATUSES, Some("todo")),
    f("points", FType::Int),
    f("tags", FType::List),
];
static TASKS: [Field; 8] = [
    req(f("title", FType::Str)),
    req(rf("story", FType::Ref, Kind::Stories)),
    req(en("kind", TASK_KINDS, None)),
    f("description", FType::Text),
    f("done_when", FType::Text),
    en("status", WORK_STATUSES, Some("todo")),
    f("estimate", FType::Str),
    f("tags", FType::List),
];

/// A code component: a module/service/package whose source carries trace tags.
/// `key` is what stories reference in `component`; `path` is the local checkout (relative to the
/// requirements repo or absolute); `globs` select the files within it.
pub const TAG_MODES: &[&str] = &["auto", "explicit"];

static COMPONENTS: [Field; 10] = [
    req(f("title", FType::Str)),
    req(f("key", FType::Str)),
    f("path", FType::Str),
    f("repo_url", FType::Str),
    f("globs", FType::List),
    f("language", FType::Str),
    // auto: requirement ids in test files count as "verifies" tags; explicit: only
    // `reqforge: implements|verifies` comments count (for code that mentions ids as data)
    en("tag_mode", TAG_MODES, Some("auto")),
    f("owners", FType::List),
    f("description", FType::Text),
    f("tags", FType::List),
];

pub const COMPONENT_KEY_RE: &str = r"^[a-z0-9][a-z0-9._-]{0,63}$";

pub fn schema(kind: Kind) -> &'static [Field] {
    match kind {
        Kind::Requirements => &REQUIREMENTS,
        Kind::Epics => &EPICS,
        Kind::Stories => &STORIES,
        Kind::Tasks => &TASKS,
        Kind::Components => &COMPONENTS,
    }
}

pub fn field(kind: Kind, name: &str) -> Option<&'static Field> {
    schema(kind).iter().find(|f| f.name == name)
}

pub const SYSTEM_FIELDS: &[&str] = &["id", "version", "created", "updated"];

pub fn is_system(k: &str) -> bool {
    SYSTEM_FIELDS.contains(&k)
}

pub fn defaults(kind: Kind) -> Rec {
    let mut out = Rec::new();
    for f in schema(kind) {
        if let Some(d) = f.default {
            out.insert(f.name.into(), json!(d));
        } else if f.ftype.is_list() {
            out.insert(f.name.into(), json!([]));
        }
    }
    out
}

/// Coerce a CLI/form string value into the field's type. Unknown fields pass through.
pub fn coerce(kind: Kind, field_name: &str, value: Value) -> Value {
    let Some(spec) = field(kind, field_name) else { return value };
    let Value::String(s) = &value else { return value };
    match spec.ftype {
        FType::List | FType::RefList => {
            Value::Array(s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(|x| json!(x)).collect())
        }
        FType::Int => {
            if s.trim().is_empty() {
                Value::Null
            } else {
                s.trim().parse::<i64>().map(|n| json!(n)).unwrap_or(value)
            }
        }
        FType::Ref => {
            if s.trim().is_empty() {
                Value::Null
            } else {
                json!(s.trim())
            }
        }
        _ => value,
    }
}

/// Python-style list repr used in validation messages: ['a', 'b'].
pub fn pylist<S: AsRef<str>>(xs: &[S]) -> String {
    format!("[{}]", xs.iter().map(|x| format!("'{}'", x.as_ref())).collect::<Vec<_>>().join(", "))
}

pub fn pyval(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        other => other.to_string(),
    }
}

pub fn is_empty(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

// reqforge: implements REQ-0004
/// Return a list of hard errors. `exists(kind, id)` checks referential integrity.
pub fn validate(kind: Kind, rec: &Rec, exists: Option<Exists>) -> Vec<String> {
    let mut errors = Vec::new();
    for f in schema(kind) {
        let val = rec.get(f.name);
        if f.required && is_empty(val) {
            errors.push(format!("{}: required", f.name));
            continue;
        }
        if is_empty(val) {
            continue;
        }
        let val = val.unwrap();
        match f.ftype {
            FType::Str | FType::Text if !val.is_string() => errors.push(format!("{}: must be a string", f.name)),
            FType::Enum => {
                if !val.as_str().map(|s| f.values.contains(&s)).unwrap_or(false) {
                    errors.push(format!("{}: '{}' not in {}", f.name, pyval(val), pylist(f.values)));
                }
            }
            FType::Int if !(val.is_i64() || val.is_u64()) => errors.push(format!("{}: must be an integer", f.name)),
            FType::List | FType::RefList => {
                if !val.as_array().map(|a| a.iter().all(Value::is_string)).unwrap_or(false) {
                    errors.push(format!("{}: must be a list of strings", f.name));
                }
            }
            FType::ObjList => match val.as_array() {
                Some(items) if items.iter().all(Value::is_object) => {
                    for (i, item) in items.iter().enumerate() {
                        for key in f.keys {
                            if *key == "command" {
                                continue; // commands may be filled in later; trace reports it
                            }
                            if is_empty(item.get(*key)) {
                                errors.push(format!("{}[{}].{}: required", f.name, i, key));
                            }
                        }
                    }
                }
                _ => errors.push(format!("{}: must be a list of objects", f.name)),
            },
            _ => {}
        }
        if let (Some(exists), Some(rk)) = (exists, f.ref_kind) {
            match f.ftype {
                FType::Ref => {
                    if let Some(s) = val.as_str() {
                        if !exists(rk, s) {
                            errors.push(format!("{}: {} does not exist", f.name, s));
                        }
                    }
                }
                FType::RefList => {
                    for r in val.as_array().into_iter().flatten().filter_map(Value::as_str) {
                        if !exists(rk, r) {
                            errors.push(format!("{}: {} does not exist", f.name, r));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if kind == Kind::Requirements {
        if let (Some(t), Some(c)) = (rec.get("type").and_then(Value::as_str), rec.get("category").and_then(Value::as_str)) {
            if let Some(tt) = tax_type(t) {
                if let Some(cats) = tt.categories {
                    if !c.is_empty() && !cats.iter().any(|(n, _)| *n == c) {
                        let names: Vec<&str> = cats.iter().map(|(n, _)| *n).collect();
                        errors.push(format!("category: '{c}' not valid for type '{t}' (expected one of {})", pylist(&names)));
                    }
                }
            }
        }
    }
    if kind == Kind::Components {
        let k = rec.get("key").and_then(Value::as_str).unwrap_or("");
        if !k.is_empty() && !regex::Regex::new(COMPONENT_KEY_RE).unwrap().is_match(k) {
            errors.push(format!("key: '{k}' must be lowercase letters, digits, '.', '_' or '-' (e.g. checkout-service)"));
        }
    }
    if kind == Kind::Stories {
        for (i, ev) in rec.get("evals").and_then(Value::as_array).into_iter().flatten().enumerate() {
            if let Some(k) = ev.get("kind").and_then(Value::as_str) {
                if !k.is_empty() && eval_stage(k).is_none() {
                    let names: Vec<&str> = EVAL_KINDS.iter().map(|(k, _)| *k).collect();
                    errors.push(format!("evals[{i}].kind: '{k}' not in {}", pylist(&names)));
                }
            }
        }
    }
    errors
}

// ------------------------------------------------------------------ JSON metadata

pub fn taxonomy_json() -> Value {
    let mut out = Map::new();
    for t in &TAXONOMY {
        let cats = match t.categories {
            Some(c) => Value::Object(c.iter().map(|(n, d)| (n.to_string(), json!(d))).collect()),
            None => Value::Null,
        };
        out.insert(t.name.into(), json!({"order": t.order, "test": t.test, "categories": cats}));
    }
    Value::Object(out)
}

pub fn schemas_json() -> Value {
    let mut out = Map::new();
    for k in KINDS {
        let mut fields = Map::new();
        for f in schema(k) {
            let mut o = Map::new();
            o.insert("type".into(), json!(f.ftype.as_str()));
            if f.required {
                o.insert("required".into(), json!(true));
            }
            if !f.values.is_empty() {
                o.insert("values".into(), json!(f.values));
            }
            if let Some(d) = f.default {
                o.insert("default".into(), json!(d));
            }
            if let Some(rk) = f.ref_kind {
                o.insert("kind".into(), json!(rk.as_str()));
            }
            if !f.keys.is_empty() {
                o.insert("keys".into(), json!(f.keys));
            }
            fields.insert(f.name.into(), Value::Object(o));
        }
        out.insert(k.as_str().into(), Value::Object(fields));
    }
    Value::Object(out)
}

pub fn enums_json() -> Value {
    json!({
        "priority": PRIORITIES, "req_status": REQ_STATUSES, "work_status": WORK_STATUSES,
        "deliverable": STORY_DELIVERABLES, "task_kind": TASK_KINDS,
        "eval_kind": EVAL_KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>(), "stage": STAGES,
    })
}

// ------------------------------------------------------------------ small helpers

pub fn s<'a>(rec: &'a Rec, k: &str) -> &'a str {
    rec.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn strs<'a>(rec: &'a Rec, k: &str) -> Vec<&'a str> {
    rec.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

pub fn objs<'a>(rec: &'a Rec, k: &str) -> Vec<&'a Map<String, Value>> {
    rec.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).collect()).unwrap_or_default()
}

// reqforge: implements REQ-0024
/// Component keys are unique within a project.
pub fn component_key_clash(rec: &Rec, all: &[std::sync::Arc<Rec>]) -> Vec<String> {
    let (id, key) = (s(rec, "id"), s(rec, "key"));
    all.iter()
        .filter(|o| s(o, "key") == key && s(o, "id") != id && !key.is_empty())
        .map(|o| format!("key: '{key}' is already used by {}", s(o, "id")))
        .collect()
}
