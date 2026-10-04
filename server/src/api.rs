//! REST API + embedded web UI (axum).
//!
//! Projects (workspace):
//! GET    /api/projects                     {workspace, single, default, projects:[{key,name,path,remote,github,artifacts,..}]}
//! POST   /api/projects                     {key, name, github?, private?} create
//! POST   /api/projects/import              {path, key?} register an existing repository
//! PATCH  /api/projects/{key}               {name?} rename, {default: true} make default
//! DELETE /api/projects/{key}?confirm=KEY[&delete_remote=1]   delete the project and all its artifacts
//! Every route below is project-scoped as /api/p/{key}/...; unscoped /api/... uses the default project.
//!
//! GET    /api/meta                         taxonomy, schemas, enums, config
//! GET    /api/{kind}?q=..&field=value      search; add limit/offset/sort/order for {total, items} pages
//! GET    /api/{kind}/facets?q=..           facet counts (+ requirement category tree)
//! POST   /api/{kind}                       create
//! GET    /api/{kind}/{id}                  read
//! PATCH  /api/{kind}/{id}                  update; "_version" (or If-Match) for optimistic concurrency
//! DELETE /api/{kind}/{id}?force=1          delete
//! POST   /api/{kind}/bulk                  {ids|q|where, set, add, remove, dry_run}
//! POST   /api/{kind}/import                {rows:[...]} or text/csv body — upsert by id
//! GET    /api/{kind}/export.csv            CSV export
//! GET    /api/context/{id}                 record + links, impact, lint findings
//! GET    /api/lint[?rule&severity&type&category&q&offset&limit] | /api/trace[?matrix=0] | /api/evals?stage=
//! GET    /api/changesets?status= | GET /api/changesets/{id} | POST /api/changesets[/simulate]
//! POST   /api/changesets/{id}/apply {exclude} | /reject {reason}
//! GET    /api/sessions | GET /api/sessions/{id} | POST /api/sessions {title, markdown}
//! POST   /api/sync | PATCH /api/config
//! GET    /api/chat/status | POST /api/chat (SSE) | POST /api/chat/cancel {chat_id}
//! Auth: REQFORGE_TOKEN set => /api/* needs `Authorization: Bearer <token>`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde_json::{json, Map, Value};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::changes;
use crate::chat::ChatRunner;
use crate::model::{enums_json, schemas_json, taxonomy_json, Kind, Rec, KINDS};
use crate::store::{Res, Store, StoreError};
use crate::workspace::Workspace;
use crate::{csvio, evals, query};

pub struct AppState {
    pub ws: Arc<Workspace>,
    pub chats: std::sync::Mutex<HashMap<String, Arc<ChatRunner>>>,
    pub token: String,
}

impl AppState {
    fn chat(&self, key: &str, store: &Store) -> Arc<ChatRunner> {
        self.chats.lock().unwrap().entry(key.to_string()).or_insert_with(|| Arc::new(ChatRunner::new(store.root.clone(), &store.config_value()))).clone()
    }
    /// Resolve the project for a request: explicit key, else the workspace default.
    fn project(&self, key: Option<&str>) -> Res<(String, Arc<Store>)> {
        let key = match key {
            Some(k) => k.to_string(),
            None => self.ws.default_key().ok_or_else(|| StoreError::new("no projects yet: create one with POST /api/projects", 404))?,
        };
        let store = self.ws.store(&key)?;
        Ok((self.ws.entry(&key)?.key, store))
    }
}

/// Router over a single repository (single-project mode).
pub fn router(store: Arc<Store>) -> Router {
    router_with_token(store, std::env::var("REQFORGE_TOKEN").unwrap_or_default())
}

pub fn router_with_token(store: Arc<Store>, token: String) -> Router {
    let store = Arc::try_unwrap(store).unwrap_or_else(|a| Store::open(&a.root).expect("reopen store"));
    workspace_router(Arc::new(Workspace::single(store)), token)
}

pub fn workspace_router(ws: Arc<Workspace>, token: String) -> Router {
    Router::new().fallback(dispatch).with_state(Arc::new(AppState { ws, chats: Default::default(), token }))
}

pub fn meta(store: &Store) -> Value {
    let kinds: Map<String, Value> = KINDS.iter().map(|k| (k.as_str().to_string(), json!(k.prefix()))).collect();
    json!({"config": store.config_value(), "kinds": kinds, "taxonomy": taxonomy_json(), "schemas": schemas_json(), "enums": enums_json()})
}

enum Out {
    Json(u16, Value),
    Raw(u16, String, &'static str),
}

fn json_resp(status: u16, v: &Value) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "application/json; charset=utf-8")], v.to_string())
        .into_response()
}

fn err_resp(e: &StoreError) -> Response {
    json_resp(e.status, &json!({"error": e.message, "details": e.details}))
}

// ---------------------------------------------------------------- guard

/// CSRF / DNS-rebinding guard for a localhost server that can start Claude runs and write
/// records: Host must be a loopback name (unless a token is set), a browser Origin must match
/// Host, and writes must use a non-"simple" content type so cross-site pages need a CORS
/// preflight that this server never approves.
fn same_origin(headers: &HeaderMap, method: &Method, body_len: usize, token: &str) -> bool {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_lowercase();
    let hostname = if host.starts_with('[') {
        host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_else(|| host.clone())
    };
    if token.is_empty() && !["localhost", "127.0.0.1", "[::1]"].contains(&hostname.as_str()) && !hostname.ends_with(".localhost") {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        let netloc = origin.split("://").nth(1).unwrap_or(origin).split('/').next().unwrap_or("").to_lowercase();
        if netloc != host {
            return false;
        }
    }
    if matches!(*method, Method::POST | Method::PATCH | Method::PUT | Method::DELETE) && body_len > 0 {
        let ct = headers.get(header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).unwrap_or("");
        let ct = ct.split(';').next().unwrap_or("").trim().to_lowercase();
        if ct != "application/json" && ct != "text/csv" {
            return false;
        }
    }
    true
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    if token.is_empty() {
        return true;
    }
    let got = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()).unwrap_or("");
    let want = format!("Bearer {token}");
    use subtle::ConstantTimeEq;
    got.len() == want.len() && bool::from(got.as_bytes().ct_eq(want.as_bytes()))
}

// ---------------------------------------------------------------- static UI

#[cfg(feature = "ui")]
#[derive(rust_embed::RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

fn static_file(path: &str) -> Response {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let serve = |name: &str, data: Vec<u8>| {
        let mime = mime_guess::from_path(name).first_or_octet_stream().to_string();
        let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
        ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_string())], data).into_response()
    };
    // REQFORGE_UI_DIR serves a UI build from disk (development / testing).
    if let Ok(dir) = std::env::var("REQFORGE_UI_DIR") {
        let base = std::path::PathBuf::from(dir);
        let p = base.join(path);
        if !path.contains("..") && p.is_file() {
            return serve(path, std::fs::read(p).unwrap_or_default());
        }
        if !path.contains('.') {
            return serve("index.html", std::fs::read(base.join("index.html")).unwrap_or_default());
        }
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    #[cfg(feature = "ui")]
    {
        if let Some(f) = Assets::get(path) {
            return serve(path, f.data.into_owned());
        }
        if !path.contains('.') {
            if let Some(f) = Assets::get("index.html") {
                return serve("index.html", f.data.into_owned());
            }
        }
    }
    let _ = &serve;
    (StatusCode::NOT_FOUND, "not found (UI not embedded: build with the `ui` feature)").into_response()
}

// ---------------------------------------------------------------- dispatch

async fn dispatch(State(st): State<Arc<AppState>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let path = uri.path().to_string();
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(String::from).collect();
    if parts.first().map(String::as_str) != Some("api") {
        return if method == Method::GET { static_file(&path) } else { json_resp(404, &json!({"error": "not found"})) };
    }
    if !same_origin(&headers, &method, body.len(), &st.token) {
        return json_resp(403, &json!({"error": "cross-origin or non-JSON request refused"}));
    }
    if !authorized(&headers, &st.token) {
        return json_resp(401, &json!({"error": "unauthorized"}));
    }
    let qs: HashMap<String, String> = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).into_owned().collect();
    let is_csv = headers.get(header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).map(|c| c.contains("text/csv")).unwrap_or(false);
    let raw = String::from_utf8_lossy(&body).to_string();
    let jbody: Value = if is_csv || raw.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return json_resp(400, &json!({"error": format!("invalid JSON body: {e}")})),
        }
    };
    let if_match = headers.get(header::IF_MATCH).and_then(|h| h.to_str().ok()).map(String::from);
    let st2 = st.clone();
    if parts.get(1).map(String::as_str) == Some("projects") {
        let m = method.clone();
        let res = tokio::task::spawn_blocking(move || projects_route(&st2, &m, &parts[2..], &qs, &jbody)).await;
        return match res {
            Ok(Ok((code, v))) => json_resp(code, &v),
            Ok(Err(e)) => err_resp(&e),
            Err(e) => json_resp(500, &json!({"error": e.to_string()})),
        };
    }
    // /api/p/{key}/... is project-scoped; anything else goes to the default project
    let (key, rest): (Option<String>, Vec<String>) = if parts.get(1).map(String::as_str) == Some("p") && parts.len() >= 3 {
        (Some(parts[2].clone()), parts[3..].to_vec())
    } else {
        (None, parts[1..].to_vec())
    };
    let (key, store) = match st.project(key.as_deref()) {
        Ok(x) => x,
        Err(e) => return err_resp(&e),
    };
    let chat = st.chat(&key, &store);
    if rest == ["chat".to_string()] && method == Method::POST {
        return chat_sse(chat, jbody);
    }
    let res = tokio::task::spawn_blocking(move || route(&store, &chat, &method, &rest, qs, jbody, if is_csv { Some(raw) } else { None }, if_match)).await;
    match res {
        Ok(Ok(Out::Json(code, v))) => json_resp(code, &v),
        Ok(Ok(Out::Raw(code, text, ct))) => (StatusCode::from_u16(code).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, ct)], text).into_response(),
        Ok(Err(e)) => err_resp(&e),
        Err(e) => json_resp(500, &json!({"error": e.to_string()})),
    }
}

fn chat_sse(chat: Arc<ChatRunner>, b: Value) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(64);
    let chat_id = b.get("chat_id").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("default").to_string();
    let message = b.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let session = b.get("session_id").and_then(Value::as_str).map(String::from);
    let ctx = b.get("context").cloned().unwrap_or(Value::Null);
    tokio::spawn(async move { chat.stream(chat_id, message, session, ctx, tx).await });
    let stream = ReceiverStream::new(rx).map(|ev| Ok::<Bytes, Infallible>(Bytes::from(format!("data: {ev}\n\n"))));
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}

fn obj(v: &Value, k: &str) -> Rec {
    v.get(k).and_then(Value::as_object).cloned().unwrap_or_default()
}

fn where_from(qs: &HashMap<String, String>, skip: &[&str]) -> Map<String, Value> {
    qs.iter().filter(|(k, _)| !skip.contains(&k.as_str())).map(|(k, v)| (k.clone(), json!(v))).collect()
}

fn num(qs: &HashMap<String, String>, k: &str, d: usize) -> usize {
    qs.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn projects_route(st: &AppState, method: &Method, p: &[String], qs: &HashMap<String, String>, b: &Value) -> Res<(u16, Value)> {
    let ws = &st.ws;
    let bs = |k: &str| b.get(k).and_then(Value::as_str).map(String::from).or_else(|| qs.get(k).cloned());
    let flag = |k: &str| b.get(k).and_then(Value::as_bool).unwrap_or(false) || matches!(qs.get(k).map(String::as_str), Some("1") | Some("true"));
    let ps: Vec<&str> = p.iter().map(String::as_str).collect();
    match (method.clone(), ps.as_slice()) {
        (Method::GET, []) => Ok((200, ws.list())),
        (Method::POST, []) => {
            let key = bs("key").ok_or_else(|| StoreError::bad("key required"))?;
            let private = b.get("private").and_then(Value::as_bool).unwrap_or(true);
            Ok((201, ws.create(&key, &bs("name").unwrap_or_default(), bs("github").as_deref(), private)?))
        }
        (Method::POST, ["import"]) => {
            let path = bs("path").ok_or_else(|| StoreError::bad("path required"))?;
            Ok((201, ws.import(std::path::Path::new(&path), bs("key").as_deref())?))
        }
        (Method::GET, [key]) => Ok((200, ws.describe(&ws.entry(key)?))),
        (Method::PATCH | Method::PUT, [key]) => {
            let mut out = ws.describe(&ws.entry(key)?);
            if let Some(name) = bs("name") {
                out = ws.rename(key, &name)?;
            }
            if b.get("default").and_then(Value::as_bool) == Some(true) {
                ws.set_default(key)?;
                out = ws.describe(&ws.entry(key)?);
            }
            Ok((200, out))
        }
        (Method::DELETE, [key]) => {
            let entry = ws.entry(key)?;
            if let Some(c) = st.chats.lock().unwrap().remove(&entry.key) {
                c.cancel_all();
            }
            Ok((200, ws.delete(key, &bs("confirm").unwrap_or_default(), flag("delete_remote"))?))
        }
        _ => Err(StoreError::new("no such route", 404)),
    }
}

#[allow(clippy::too_many_arguments)]
fn route(store: &Store, chat: &ChatRunner, method: &Method, p: &[String], qs: HashMap<String, String>, b: Value, csv: Option<String>, if_match: Option<String>) -> Res<Out> {
    let ps: Vec<&str> = p.iter().map(String::as_str).collect();
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    match ps.as_slice() {
        ["meta"] if get => return Ok(Out::Json(200, meta(store))),
        ["config"] if matches!(*method, Method::PATCH | Method::PUT) => {
            return Ok(Out::Json(200, store.save_config(b.as_object().unwrap_or(&Map::new()))?))
        }
        ["lint"] => {
            let paged = ["limit", "offset", "rule", "severity", "type", "category", "q"].iter().any(|k| qs.contains_key(*k));
            if paged {
                let g = |k: &str| qs.get(k).cloned().unwrap_or_default();
                return Ok(Out::Json(200, query::lint_page(store, &g("rule"), &g("severity"), &g("type"), &g("category"), &g("q"), num(&qs, "offset", 0), num(&qs, "limit", 100))));
            }
            return Ok(Out::Json(200, (*changes::lint_memo(store)).clone()));
        }
        ["trace"] => {
            let mut rep = (*changes::trace_memo(store)).clone();
            if qs.get("matrix").map(String::as_str) == Some("0") {
                rep.as_object_mut().unwrap().remove("matrix");
            }
            return Ok(Out::Json(200, rep));
        }
        ["evals"] => return Ok(Out::Json(200, json!(evals::registry(store, qs.get("stage").map(String::as_str), qs.get("component").map(String::as_str))))),
        ["sync"] if post => return Ok(Out::Json(200, store.sync(b.get("message").and_then(Value::as_str).unwrap_or("reqforge: sync from API"))?)),
        ["chat", "status"] => return Ok(Out::Json(200, chat.status())),
        ["chat", "cancel"] if post => {
            let id = b.get("chat_id").and_then(Value::as_str).unwrap_or("default");
            return Ok(Out::Json(200, json!({"cancelled": chat.cancel(id)})));
        }
        ["context", id] => return Ok(Out::Json(200, changes::context(store, id)?)),
        ["changesets"] if get => return Ok(Out::Json(200, json!(changes::list(store, qs.get("status").map(String::as_str))))),
        ["changesets"] if post => return Ok(Out::Json(201, changes::propose(store, &b)?)),
        ["changesets", "simulate"] if post => return Ok(Out::Json(200, changes::simulate(store, &b))),
        ["changesets", id] if get => return Ok(Out::Json(200, changes::get(store, id)?)),
        ["changesets", id, "apply"] if post => {
            let ex: Vec<usize> = b.get("exclude").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).map(|x| x as usize).collect();
            return Ok(Out::Json(200, changes::apply(store, id, &ex)?));
        }
        ["changesets", id, "reject"] if post => {
            return Ok(Out::Json(200, changes::reject(store, id, b.get("reason").and_then(Value::as_str).unwrap_or(""))?))
        }
        ["sessions"] if get => return Ok(Out::Json(200, json!(store.sessions()))),
        ["sessions"] if post => {
            let title = b.get("title").and_then(Value::as_str).ok_or_else(|| StoreError::bad("title required"))?;
            let md = b.get("markdown").and_then(Value::as_str).ok_or_else(|| StoreError::bad("markdown required"))?;
            return Ok(Out::Json(201, json!({"id": store.save_session(title, md, b.get("id").and_then(Value::as_str))?})));
        }
        ["sessions", id] if id.starts_with("ELI-") => {
            let f = store.root.join("sessions").join(format!("{id}.md"));
            let text = std::fs::read_to_string(f).map_err(|_| StoreError::new(format!("{id} not found"), 404))?;
            return Ok(Out::Raw(200, text, "text/markdown; charset=utf-8"));
        }
        _ => {}
    }
    let kind = Kind::parse(ps.first().copied().unwrap_or("")).map_err(|e| StoreError::new(e, 404))?;
    match ps.as_slice() {
        [_] if get => {
            let q = qs.get("q").cloned().unwrap_or_default();
            let paging = ["limit", "offset", "sort", "order"].iter().any(|k| qs.contains_key(*k));
            let w = where_from(&qs, &["q", "limit", "offset", "sort", "order"]);
            if paging {
                let sort = qs.get("sort").cloned().unwrap_or_else(|| "id".into());
                let order = qs.get("order").cloned().unwrap_or_else(|| "asc".into());
                return Ok(Out::Json(200, query::page(store, kind, &q, &w, &sort, &order, num(&qs, "offset", 0), num(&qs, "limit", 100))));
            }
            let rows: Vec<Value> = store.search(kind, &q, &w).iter().map(|r| Value::Object((**r).clone())).collect();
            Ok(Out::Json(200, json!(rows)))
        }
        [_] if post => Ok(Out::Json(201, Value::Object(store.create(kind, b.as_object().unwrap_or(&Map::new()), None)?))),
        [_, "bulk"] if post => {
            let ids: Option<Vec<String>> = b.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect());
            Ok(Out::Json(
                200,
                store.bulk_update(
                    kind,
                    ids,
                    b.get("q").and_then(Value::as_str).unwrap_or(""),
                    &obj(&b, "where"),
                    &obj(&b, "set"),
                    &obj(&b, "add"),
                    &obj(&b, "remove"),
                    b.get("dry_run").and_then(Value::as_bool).unwrap_or(false),
                    None,
                )?,
            ))
        }
        [_, "import"] if post => {
            let rows: Vec<Rec> = match csv {
                Some(text) => csvio::parse(&text, kind)?,
                None => b.get("rows").and_then(Value::as_array).ok_or_else(|| StoreError::bad("'rows'"))?.iter().filter_map(|r| r.as_object().cloned()).collect(),
            };
            Ok(Out::Json(200, store.upsert_many(kind, &rows, None)?))
        }
        [_, "facets"] if get => {
            let q = qs.get("q").cloned().unwrap_or_default();
            Ok(Out::Json(200, query::facets(store, kind, &q, &where_from(&qs, &["q"]))))
        }
        [_, "export.csv"] if get => {
            let q = qs.get("q").cloned().unwrap_or_default();
            let mut w = where_from(&qs, &["q"]);
            let rows = if w.contains_key("covered") {
                let ids: Vec<String> = query::page(store, kind, &q, &w, "id", "asc", 0, usize::MAX)["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r["id"].as_str().map(String::from))
                    .collect();
                w.remove("covered");
                store.search(kind, &q, &w).into_iter().filter(|r| ids.iter().any(|i| Some(i.as_str()) == r.get("id").and_then(Value::as_str))).collect()
            } else {
                store.search(kind, &q, &w)
            };
            Ok(Out::Raw(200, csvio::export(&rows, kind), "text/csv; charset=utf-8"))
        }
        [_, id] if get => Ok(Out::Json(200, Value::Object(store.get(kind, id)?))),
        [_, id] if matches!(*method, Method::PATCH | Method::PUT) => {
            let mut patch = b.as_object().cloned().unwrap_or_default();
            let ver = patch.remove("_version").and_then(|v| v.as_i64()).or_else(|| if_match.and_then(|s| s.trim_matches('"').parse().ok()));
            Ok(Out::Json(200, Value::Object(store.update(kind, id, &patch, ver, None)?)))
        }
        [_, id] if *method == Method::DELETE => {
            let force = matches!(qs.get("force").map(String::as_str), Some("1") | Some("true"));
            Ok(Out::Json(200, store.delete(kind, id, force)?))
        }
        _ => Err(StoreError::new("no such route", 404)),
    }
}

/// Bind and serve a single repository. Returns the bound address (port 0 picks a free port).
pub async fn serve(store: Arc<Store>, host: &str, port: u16) -> std::io::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    serve_app(router(store), host, port).await
}

/// Bind and serve a workspace (multi-project).
pub async fn serve_workspace(ws: Arc<Workspace>, host: &str, port: u16) -> std::io::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    serve_app(workspace_router(ws, std::env::var("REQFORGE_TOKEN").unwrap_or_default()), host, port).await
}

async fn serve_app(app: Router, host: &str, port: u16) -> std::io::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    let addr = listener.local_addr()?;
    let h = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((addr, h))
}
