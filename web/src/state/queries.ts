import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ApiError } from "@/api/client"
import type { Kind, LintParams } from "@/api/types"
import type { Filters, ViewState } from "./app"
import { useApi } from "./project"

// Every project-scoped query key starts with ["p", <KEY>, …] so switching projects never
// shows another project's cached data, and one project's cache can be dropped as a unit.

export function listParams(view: ViewState) {
  return { q: view.q, ...view.filters, sort: view.sort, order: view.order, offset: view.offset, limit: view.limit }
}

export function facetParams(q: string, filters: Filters) {
  return { q, ...filters }
}

export function useListPage(kind: Kind | null, view: ViewState) {
  const api = useApi()
  const params = listParams(view)
  return useQuery({
    queryKey: ["p", api.key, "list", kind, params],
    queryFn: () => api.list(kind!, params),
    enabled: !!kind,
    placeholderData: keepPreviousData,
  })
}

export function useFacets(kind: Kind | null, params: Record<string, string | undefined>) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "facets", kind, params],
    queryFn: () => api.facets(kind!, params),
    enabled: !!kind,
    placeholderData: keepPreviousData,
  })
}

export function useLintPage(params: LintParams) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "lint", params],
    queryFn: () => api.lint(params),
    placeholderData: keepPreviousData,
  })
}

export function useTrace() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "trace"], queryFn: api.trace })
}

export function useChangesets() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "changesets", "all"], queryFn: () => api.changesets() })
}

export function usePendingCount() {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "changesets", "pending"],
    queryFn: () => api.changesets("pending"),
    select: (l) => l.length,
    refetchInterval: 60_000,
  })
}

export function useChangeset(id: string) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "changeset", id], queryFn: () => api.changeset(id) })
}

export function useRecord(kind: Kind, id: string | null) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "record", kind, id], queryFn: () => api.get(kind, id!), enabled: !!id })
}

export function useRecordContext(id: string | null, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "context", id],
    queryFn: () => api.context(id!),
    enabled: !!id && enabled,
  })
}

export function useChatStatus() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "chat-status"], queryFn: api.chatStatus, staleTime: 5 * 60_000 })
}

export function useVerification(enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "verification"], queryFn: api.verification, enabled })
}

/** components with their scan summaries (GET /code) */
export function useCode() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "code"], queryFn: api.code, staleTime: 60_000 })
}

export function useCodeImpact(component: string, base: string, nonce: number) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "code-impact", component, base, nonce],
    queryFn: () => api.codeImpact(component, base),
    enabled: !!component && nonce > 0,
    retry: false,
  })
}

/** verified-ratio snapshots, oldest first (GET /verification/history) */
export function useVerificationHistory(limit = 30) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "verification-history", limit], queryFn: () => api.verificationHistory(limit) })
}

/** whether a task can start (by hand / with an agent) and what blocks it */
export function useReadiness(id: string | null, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "readiness", id],
    queryFn: () => api.readiness(id!),
    enabled: !!id && enabled,
    // dependencies change elsewhere (other tabs, the agent queue): re-check whenever a Start button mounts
    staleTime: 0,
  })
}

/** agent readiness, branch, worktree and brief of a task (GET tasks/{id}/agent) */
export function useAgentPlan(id: string | null, enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "agent-plan", id], queryFn: () => api.agentPlan(id!), enabled: !!id && enabled, staleTime: 0 })
}

/** a task's agent run logs, newest first */
export function useRuns(id: string | null, enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "runs", id], queryFn: () => api.runs(id!), enabled: !!id && enabled })
}

/** review of a task's agent branch (GET tasks/{id}/branch); `null` when the task has no agent branch (404) */
export function useBranchReview(id: string | null, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "branch", id],
    queryFn: async () => {
      try {
        return await api.branch(id!)
      } catch (e) {
        // 404: no agent branch; 400: the story has no usable component (so there cannot be one)
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return null
        throw e
      }
    },
    enabled: !!id && enabled,
    staleTime: 0,
    retry: false,
  })
}

/** the project's agent queue; polled while mounted and the page is visible */
export function useAgentQueue(pollMs = 3000) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "agent-queue"],
    queryFn: api.agentQueue,
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  })
}

/** the project's design documents (design/<slug>.md): slug, title, realises */
export function useDesignDocs() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "design"], queryFn: api.designDocs })
}

/** one design document's raw Markdown */
export function useDesignDoc(slug: string | null) {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "design", slug], queryFn: () => api.designDoc(slug!), enabled: !!slug })
}

/** every decision with its status, linked requirements and exercised flag (GET /decisions/exercised) */
export function useDecisions() {
  const api = useApi()
  return useQuery({ queryKey: ["p", api.key, "decisions"], queryFn: api.decisions })
}

/** every task id + title + status, for pickers (depends_on) */
export function useTaskOptions(enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: ["p", api.key, "task-options"],
    queryFn: async () => (await api.list("tasks", { sort: "id", order: "asc", limit: 5000, offset: 0 })).items,
    enabled,
    staleTime: 30_000,
  })
}
