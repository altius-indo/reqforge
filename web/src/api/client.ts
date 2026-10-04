import type {
  AgentEvent,
  AgentLive,
  AgentPlan,
  AgentQueue,
  AgentQueueUpdate,
  BranchReview,
  CompleteResult,
  RunLog,
  StartResult,
  TaskReadiness,
  VerificationSnapshot,
  ApplyResult,
  BulkRequest,
  BulkResult,
  Changeset,
  ChangesetSummary,
  ChatEvent,
  ChatRequest,
  ChatStatus,
  CodeImpact,
  CodeListing,
  EvidenceRequest,
  IngestResult,
  ReqVerification,
  ScanResult,
  VerificationReport,
  CreateProjectRequest,
  DeleteProjectResult,
  DeleteResult,
  DesignDoc,
  Facets,
  ImportResult,
  Kind,
  LintPage,
  LintParams,
  ListParams,
  Meta,
  Page,
  Project,
  ProjectList,
  RecordBase,
  RecordContext,
  RejectResult,
  SyncResult,
  TraceReport,
} from "./types"

const TOKEN_KEY = "reqforge.token"

// ------------------------------------------------------------------ auth
export function getToken(): string {
  try {
    const v = localStorage.getItem(TOKEN_KEY)
    return v ? (JSON.parse(v) as string) : ""
  } catch {
    return ""
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t))
  } catch {
    /* storage unavailable */
  }
}

export function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

type Listener = () => void
const unauthorizedListeners = new Set<Listener>()
/** Subscribe to 401 responses (the header shows the token input). */
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn)
  return () => {
    unauthorizedListeners.delete(fn)
  }
}

// ------------------------------------------------------------------ core
export class ApiError extends Error {
  status: number
  details: unknown[]
  constructor(message: string, status: number, details: unknown[] = []) {
    super(message)
    this.status = status
    this.details = details
  }
}

/** Build a query string, dropping empty values. */
export function qs(o: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== "" && v != null) p.set(k, String(v))
  return p.toString()
}

export async function request<T>(method: string, path: string, body?: unknown, csv = false): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() }
  let data: string | undefined
  if (body !== undefined) {
    // the server refuses mutating requests without a non-simple content type (CSRF guard)
    headers["Content-Type"] = csv ? "text/csv" : "application/json"
    data = csv ? String(body) : JSON.stringify(body)
  }
  const r = await fetch(path, { method, headers, body: data })
  if (r.status === 401) {
    unauthorizedListeners.forEach((fn) => fn())
    throw new ApiError("unauthorized: enter the API token (REQFORGE_TOKEN)", 401)
  }
  const isJson = (r.headers.get("content-type") || "").includes("json")
  const out: unknown = isJson ? await r.json() : await r.text()
  if (!r.ok) {
    const e = (isJson ? out : { error: out || r.statusText }) as { error?: string; details?: unknown[] }
    throw new ApiError(e.error || r.statusText, r.status, Array.isArray(e.details) ? e.details : [])
  }
  return out as T
}

// ------------------------------------------------------------------ endpoints
/** Workspace-level project management (not project-scoped). */
export const projectsApi = {
  list: () => request<ProjectList>("GET", "/api/projects"),
  create: (body: CreateProjectRequest) => request<Project>("POST", "/api/projects", body),
  importRepo: (path: string, key?: string) =>
    request<Project>("POST", "/api/projects/import", key ? { path, key } : { path }),
  rename: (key: string, name: string) => request<Project>("PATCH", `/api/projects/${encodeURIComponent(key)}`, { name }),
  makeDefault: (key: string) =>
    request<Project>("PATCH", `/api/projects/${encodeURIComponent(key)}`, { default: true }),
  remove: (key: string, deleteRemote: boolean) =>
    request<DeleteProjectResult>(
      "DELETE",
      `/api/projects/${encodeURIComponent(key)}?${qs({ confirm: key, delete_remote: deleteRemote ? 1 : undefined })}`,
    ),
}

/** Base path of every project-scoped route. */
export const projectBase = (key: string) => `/api/p/${encodeURIComponent(key)}`

/** Endpoints of one project; every path is `/api/p/{key}/…`. */
export function projectApi(key: string) {
  const b = projectBase(key)
  return {
    key,
    meta: () => request<Meta>("GET", `${b}/meta`),
    list: (kind: Kind, params: ListParams) => request<Page>("GET", `${b}/${kind}?${qs(params)}`),
    facets: (kind: Kind, params: Record<string, string | undefined>) =>
      request<Facets>("GET", `${b}/${kind}/facets?${qs(params)}`),
    get: <T extends RecordBase = RecordBase>(kind: Kind, id: string) => request<T>("GET", `${b}/${kind}/${id}`),
    create: (kind: Kind, data: Record<string, unknown>) => request<RecordBase>("POST", `${b}/${kind}`, data),
    update: (kind: Kind, id: string, patch: Record<string, unknown>, version?: number) =>
      request<RecordBase>("PATCH", `${b}/${kind}/${id}`, version != null ? { ...patch, _version: version } : patch),
    remove: (kind: Kind, id: string, force = false) =>
      request<DeleteResult>("DELETE", `${b}/${kind}/${id}${force ? "?force=1" : ""}`),
    bulk: (kind: Kind, body: BulkRequest) => request<BulkResult>("POST", `${b}/${kind}/bulk`, body),
    importCsv: (kind: Kind, csv: string) => request<ImportResult>("POST", `${b}/${kind}/import`, csv, true),
    exportUrl: (kind: Kind, params: Record<string, string | undefined>) => `${b}/${kind}/export.csv?${qs(params)}`,
    context: (id: string) => request<RecordContext>("GET", `${b}/context/${id}`),
    lint: (params: LintParams) => request<LintPage>("GET", `${b}/lint?${qs({ limit: 100, ...params })}`),
    trace: () => request<TraceReport>("GET", `${b}/trace?matrix=0`),
    changesets: (status?: string) =>
      request<ChangesetSummary[]>("GET", `${b}/changesets${status ? `?status=${status}` : ""}`),
    changeset: (id: string) => request<Changeset>("GET", `${b}/changesets/${id}`),
    apply: (id: string, exclude: number[]) => request<ApplyResult>("POST", `${b}/changesets/${id}/apply`, { exclude }),
    reject: (id: string, reason: string) => request<RejectResult>("POST", `${b}/changesets/${id}/reject`, { reason }),
    sync: () => request<SyncResult>("POST", `${b}/sync`, {}),
    chatStatus: () => request<ChatStatus>("GET", `${b}/chat/status`),
    verification: () => request<VerificationReport>("GET", `${b}/verification`),
    reqVerification: (id: string) => request<ReqVerification>("GET", `${b}/verification?${qs({ req: id })}`),
    code: () => request<CodeListing>("GET", `${b}/code`),
    scan: (components?: string[]) =>
      request<ScanResult>("POST", `${b}/code/scan`, components?.length ? { components } : {}),
    ingest: (body: EvidenceRequest) => request<IngestResult>("POST", `${b}/evidence`, body),
    codeImpact: (component: string, base: string) =>
      request<CodeImpact>("GET", `${b}/impact?${qs({ component, base })}`),
    chatCancel: (chatId: string) => request<{ cancelled: boolean }>("POST", `${b}/chat/cancel`, { chat_id: chatId }),
    verificationHistory: (limit = 30) =>
      request<VerificationSnapshot[]>("GET", `${b}/verification/history?${qs({ limit })}`),
    // tasks: start, coding-agent runs, agent queue
    readiness: (id: string) => request<TaskReadiness>("GET", `${b}/tasks/${id}/readiness`),
    start: (id: string, version: number) => request<StartResult>("POST", `${b}/tasks/${id}/start`, { _version: version }),
    agentPlan: (id: string) => request<AgentPlan>("GET", `${b}/tasks/${id}/agent`),
    agentCancel: (id: string) => request<{ cancelled: boolean }>("POST", `${b}/tasks/${id}/agent/cancel`, {}),
    agentLive: (id: string, since = 0) => request<AgentLive>("GET", `${b}/tasks/${id}/agent/live?${qs({ since })}`),
    runs: (id: string) => request<RunLog[]>("GET", `${b}/tasks/${id}/runs`),
    branch: (id: string) => request<BranchReview>("GET", `${b}/tasks/${id}/branch`),
    complete: (id: string, version: number) =>
      request<CompleteResult>("POST", `${b}/tasks/${id}/complete`, { _version: version }),
    agentQueue: () => request<AgentQueue>("GET", `${b}/agent-queue`),
    setAgentQueue: (body: AgentQueueUpdate) => request<AgentQueue>("POST", `${b}/agent-queue`, body),
    // design documents (design/<slug>.md), read-only
    designDocs: () => request<DesignDoc[]>("GET", `${b}/design`),
    designDoc: (slug: string) => request<string>("GET", `${b}/design/${encodeURIComponent(slug)}`),
  }
}

export type ProjectApi = ReturnType<typeof projectApi>

// ------------------------------------------------------------------ server-sent event streams
/**
 * POST `body` to `path` and yield the server-sent events from the `text/event-stream` body.
 * Each event is a `data: {json}` line; events are separated by a blank line.
 */
async function* streamSse<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  if (r.status === 401) unauthorizedListeners.forEach((fn) => fn())
  if (!r.ok || !r.body) throw new ApiError((await r.text()) || r.statusText, r.status)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const parse = function* (chunk: string): Generator<T> {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue
      try {
        yield JSON.parse(line.slice(5).trim()) as T
      } catch {
        /* ignore malformed line */
      }
    }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n")
    let i: number
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      yield* parse(chunk)
    }
  }
  if (buf.trim()) yield* parse(buf)
}

/** POST /api/p/{key}/chat: the chat turn's events. */
export function streamChat(key: string, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  return streamSse<ChatEvent>(`${projectBase(key)}/chat`, req, signal)
}

/**
 * POST /api/p/{key}/tasks/{id}/agent: run the coding agent and yield its progress events, ending with `result`.
 * Aborting the stream does not stop the run (use agentCancel); its progress stays readable via agent/live.
 */
export function streamAgent(key: string, task: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  return streamSse<AgentEvent>(`${projectBase(key)}/tasks/${task}/agent`, {}, signal)
}
