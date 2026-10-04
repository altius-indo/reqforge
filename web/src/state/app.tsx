/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { KINDS, type Kind, type Meta, type Tab } from "@/api/types"
import { ls, pkey } from "@/lib/storage"
import { useApi } from "./project"

export type Filters = Record<string, string>

export interface LintState {
  rule: string
  severity: string
  offset: number
}

export interface ViewState {
  tab: Tab
  q: string
  filters: Filters
  sort: string
  order: "asc" | "desc"
  offset: number
  limit: number
  lint: LintState
}

export interface DrawerState {
  open: boolean
  kind: Kind
  /** null = creating a new record */
  id: string | null
  nonce: number
  /** drawer tab to show first (default "details") */
  tab?: string
}

const TABS: Tab[] = [...KINDS, "trace", "verification", "lint", "changes"]
const PAGE_SIZES = [50, 100, 250, 500]

function initialView(project: string): ViewState {
  const t = ls.get<string>(pkey("tab", project), "requirements")
  const lim = ls.get<number>("reqforge.limit", 100)
  return {
    tab: (TABS as string[]).includes(t) ? (t as Tab) : "requirements",
    q: "",
    filters: {},
    sort: "id",
    order: "asc",
    offset: 0,
    limit: PAGE_SIZES.includes(lim) ? lim : 100,
    lint: { rule: "", severity: "", offset: 0 },
  }
}

interface AppCtx {
  meta: Meta | undefined
  metaError: Error | null
  view: ViewState
  /** kind whose list/facets drive the sidebar (lint uses the requirements tree) */
  listKind: Kind | null
  setTab: (t: Tab) => void
  setFilter: (f: string, v: string) => void
  setFilters: (f: Filters, q?: string) => void
  toggleFacet: (f: string, v: string) => void
  setQuery: (q: string) => void
  toggleSort: (col: string) => void
  setOffset: (n: number) => void
  setLimit: (n: number) => void
  setLint: (patch: Partial<LintState>) => void
  goto: (tab: Tab, filters: Filters) => void
  // selection
  sel: Set<string>
  selAll: boolean
  toggleSel: (id: string, on: boolean) => void
  selectPage: (ids: string[], on: boolean) => void
  setSelAll: (on: boolean) => void
  clearSel: () => void
  // sidebar tree
  treeOpen: Set<string>
  toggleTree: (type: string) => void
  sideOpen: boolean
  setSideOpen: (b: boolean) => void
  // drawer
  drawer: DrawerState
  openDrawer: (kind: Kind | undefined, id: string | null, tab?: string) => void
  closeDrawer: () => void
  // data refresh
  refreshAll: () => void
}

const Ctx = createContext<AppCtx | null>(null)

/**
 * View state of the active project. The provider is mounted with `key={project}`, so switching
 * projects starts from a clean slate (filters, search, selection, paging, drawer, lint).
 */
export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const api = useApi()
  const project = api.key
  const metaQ = useQuery({ queryKey: ["p", project, "meta"], queryFn: api.meta, staleTime: Infinity, retry: false })
  const [view, setView] = useState<ViewState>(() => initialView(project))
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [selAll, setSelAllState] = useState(false)
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set(ls.get<string[]>(pkey("open", project), [])))
  const [sideOpen, setSideOpen] = useState(false)
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, kind: "requirements", id: null, nonce: 0 })

  const clearSel = useCallback(() => {
    setSel(new Set())
    setSelAllState(false)
  }, [])

  const setTab = useCallback(
    (t: Tab) => {
      ls.set(pkey("tab", project), t)
      setView((v) => ({ ...initialView(project), limit: v.limit, tab: t }))
      clearSel()
    },
    [clearSel, project],
  )

  const setFilters = useCallback(
    (filters: Filters, q?: string) => {
      setView((v) => ({ ...v, filters, q: q ?? v.q, offset: 0, lint: { ...v.lint, offset: 0 } }))
      clearSel()
    },
    [clearSel],
  )

  const setFilter = useCallback(
    (f: string, val: string) => {
      setView((v) => {
        const filters = { ...v.filters }
        if (val === "" || val == null) delete filters[f]
        else filters[f] = val
        return { ...v, filters, offset: 0, lint: { ...v.lint, offset: 0 } }
      })
      clearSel()
    },
    [clearSel],
  )

  const toggleFacet = useCallback(
    (f: string, val: string) => {
      setView((v) => {
        const cur = (v.filters[f] || "").split("|").filter(Boolean)
        const i = cur.indexOf(val)
        if (i >= 0) cur.splice(i, 1)
        else cur.push(val)
        const filters = { ...v.filters }
        if (cur.length) filters[f] = cur.join("|")
        else delete filters[f]
        return { ...v, filters, offset: 0, lint: { ...v.lint, offset: 0 } }
      })
      clearSel()
    },
    [clearSel],
  )

  const setQuery = useCallback(
    (q: string) => {
      setView((v) => ({ ...v, q, offset: 0, lint: { ...v.lint, offset: 0 } }))
      clearSel()
    },
    [clearSel],
  )

  const toggleSort = useCallback((col: string) => {
    setView((v) => ({ ...v, order: v.sort === col && v.order === "asc" ? "desc" : "asc", sort: col }))
  }, [])

  const setOffset = useCallback((offset: number) => setView((v) => ({ ...v, offset: Math.max(0, offset) })), [])
  const setLimit = useCallback((limit: number) => {
    ls.set("reqforge.limit", limit)
    setView((v) => ({ ...v, limit, offset: 0 }))
  }, [])
  const setLint = useCallback(
    (patch: Partial<LintState>) => setView((v) => ({ ...v, lint: { ...v.lint, ...patch } })),
    [],
  )
  const goto = useCallback(
    (tab: Tab, filters: Filters) => {
      ls.set(pkey("tab", project), tab)
      setView((v) => ({ ...initialView(project), limit: v.limit, tab, filters }))
      clearSel()
    },
    [clearSel, project],
  )

  const toggleSel = useCallback((id: string, on: boolean) => {
    setSelAllState(false)
    setSel((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })
  }, [])
  const selectPage = useCallback((ids: string[], on: boolean) => {
    if (!on) setSelAllState(false)
    setSel((s) => {
      const n = new Set(s)
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)))
      return n
    })
  }, [])

  const toggleTree = useCallback((type: string) => {
    setTreeOpen((s) => {
      const n = new Set(s)
      if (n.has(type)) n.delete(type)
      else n.add(type)
      ls.set(pkey("open", project), [...n])
      return n
    })
  }, [project])

  const openDrawer = useCallback((kind: Kind | undefined, id: string | null, tab?: string) => {
    if (!kind) return
    setDrawer((d) => ({ open: true, kind, id, nonce: d.nonce + 1, tab }))
  }, [])
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false })), [])

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "p" && q.queryKey[1] === project && q.queryKey[2] !== "meta",
    })
    // artifact counts in the project switcher / projects page
    void qc.invalidateQueries({ queryKey: ["projects"] })
  }, [qc, project])

  const listKind: Kind | null = (KINDS as string[]).includes(view.tab)
    ? (view.tab as Kind)
    : view.tab === "lint"
      ? "requirements"
      : null

  const value = useMemo<AppCtx>(
    () => ({
      meta: metaQ.data,
      metaError: metaQ.error,
      view,
      listKind,
      setTab,
      setFilter,
      setFilters,
      toggleFacet,
      setQuery,
      toggleSort,
      setOffset,
      setLimit,
      setLint,
      goto,
      sel,
      selAll,
      toggleSel,
      selectPage,
      setSelAll: setSelAllState,
      clearSel,
      treeOpen,
      toggleTree,
      sideOpen,
      setSideOpen,
      drawer,
      openDrawer,
      closeDrawer,
      refreshAll,
    }),
    [metaQ.data, metaQ.error, view, listKind, setTab, setFilter, setFilters, toggleFacet, setQuery, toggleSort,
      setOffset, setLimit, setLint, goto, sel, selAll, toggleSel, selectPage, clearSel, treeOpen, toggleTree,
      sideOpen, drawer, openDrawer, closeDrawer, refreshAll],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useApp outside AppProvider")
  return c
}

export const PAGE_SIZE_OPTIONS = PAGE_SIZES
