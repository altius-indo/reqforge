import type {
  ApplyResult,
  BulkRequest,
  BulkResult,
  Changeset,
  ChangesetSummary,
  ChatEvent,
  ChatRequest,
  ChatStatus,
  DeleteResult,
  Facets,
  ImportResult,
  Kind,
  LintPage,
  LintParams,
  ListParams,
  Meta,
  Page,
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
export const api = {
  meta: () => request<Meta>("GET", "/api/meta"),
  list: (kind: Kind, params: ListParams) => request<Page>("GET", `/api/${kind}?${qs(params)}`),
  facets: (kind: Kind, params: Record<string, string | undefined>) =>
    request<Facets>("GET", `/api/${kind}/facets?${qs(params)}`),
  get: <T extends RecordBase = RecordBase>(kind: Kind, id: string) => request<T>("GET", `/api/${kind}/${id}`),
  create: (kind: Kind, data: Record<string, unknown>) => request<RecordBase>("POST", `/api/${kind}`, data),
  update: (kind: Kind, id: string, patch: Record<string, unknown>, version?: number) =>
    request<RecordBase>("PATCH", `/api/${kind}/${id}`, version != null ? { ...patch, _version: version } : patch),
  remove: (kind: Kind, id: string, force = false) =>
    request<DeleteResult>("DELETE", `/api/${kind}/${id}${force ? "?force=1" : ""}`),
  bulk: (kind: Kind, body: BulkRequest) => request<BulkResult>("POST", `/api/${kind}/bulk`, body),
  importCsv: (kind: Kind, csv: string) => request<ImportResult>("POST", `/api/${kind}/import`, csv, true),
  exportUrl: (kind: Kind, params: Record<string, string | undefined>) => `/api/${kind}/export.csv?${qs(params)}`,
  context: (id: string) => request<RecordContext>("GET", `/api/context/${id}`),
  lint: (params: LintParams) => request<LintPage>("GET", `/api/lint?${qs({ limit: 100, ...params })}`),
  trace: () => request<TraceReport>("GET", "/api/trace?matrix=0"),
  changesets: (status?: string) => request<ChangesetSummary[]>("GET", `/api/changesets${status ? `?status=${status}` : ""}`),
  changeset: (id: string) => request<Changeset>("GET", `/api/changesets/${id}`),
  apply: (id: string, exclude: number[]) => request<ApplyResult>("POST", `/api/changesets/${id}/apply`, { exclude }),
  reject: (id: string, reason: string) => request<RejectResult>("POST", `/api/changesets/${id}/reject`, { reason }),
  sync: () => request<SyncResult>("POST", "/api/sync", {}),
  chatStatus: () => request<ChatStatus>("GET", "/api/chat/status"),
  chatCancel: (chatId: string) => request<{ cancelled: boolean }>("POST", "/api/chat/cancel", { chat_id: chatId }),
}

// ------------------------------------------------------------------ chat stream
/**
 * POST /api/chat and yield the server-sent events from the `text/event-stream` body.
 * Each event is a `data: {json}` line; events are separated by a blank line.
 */
export async function* streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
    signal,
  })
  if (r.status === 401) unauthorizedListeners.forEach((fn) => fn())
  if (!r.ok || !r.body) throw new ApiError((await r.text()) || r.statusText, r.status)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const parse = function* (chunk: string): Generator<ChatEvent> {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue
      try {
        yield JSON.parse(line.slice(5).trim()) as ChatEvent
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
