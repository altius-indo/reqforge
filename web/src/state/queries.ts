import { keepPreviousData, useQuery } from "@tanstack/react-query"
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
