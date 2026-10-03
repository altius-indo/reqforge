import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import type { Kind, LintParams } from "@/api/types"
import type { Filters, ViewState } from "./app"

export function listParams(view: ViewState) {
  return { q: view.q, ...view.filters, sort: view.sort, order: view.order, offset: view.offset, limit: view.limit }
}

export function facetParams(q: string, filters: Filters) {
  return { q, ...filters }
}

export function useListPage(kind: Kind | null, view: ViewState) {
  const params = listParams(view)
  return useQuery({
    queryKey: ["list", kind, params],
    queryFn: () => api.list(kind!, params),
    enabled: !!kind,
    placeholderData: keepPreviousData,
  })
}

export function useFacets(kind: Kind | null, params: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ["facets", kind, params],
    queryFn: () => api.facets(kind!, params),
    enabled: !!kind,
    placeholderData: keepPreviousData,
  })
}

export function useLintPage(params: LintParams) {
  return useQuery({ queryKey: ["lint", params], queryFn: () => api.lint(params), placeholderData: keepPreviousData })
}

export function useTrace() {
  return useQuery({ queryKey: ["trace"], queryFn: api.trace })
}

export function useChangesets() {
  return useQuery({ queryKey: ["changesets", "all"], queryFn: () => api.changesets() })
}

export function usePendingCount() {
  return useQuery({
    queryKey: ["changesets", "pending"],
    queryFn: () => api.changesets("pending"),
    select: (l) => l.length,
    refetchInterval: 60_000,
  })
}

export function useChangeset(id: string) {
  return useQuery({ queryKey: ["changeset", id], queryFn: () => api.changeset(id) })
}

export function useRecord(kind: Kind, id: string | null) {
  return useQuery({ queryKey: ["record", kind, id], queryFn: () => api.get(kind, id!), enabled: !!id })
}

export function useRecordContext(id: string | null, enabled: boolean) {
  return useQuery({ queryKey: ["context", id], queryFn: () => api.context(id!), enabled: !!id && enabled })
}

export function useChatStatus() {
  return useQuery({ queryKey: ["chat-status"], queryFn: api.chatStatus, staleTime: 5 * 60_000 })
}
