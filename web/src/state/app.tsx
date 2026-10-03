/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api/client"
import { KINDS, type Kind, type Meta, type Tab } from "@/api/types"
import { ls } from "@/lib/storage"

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
}

const TABS: Tab[] = [...KINDS, "trace", "lint", "changes"]
const PAGE_SIZES = [50, 100, 250, 500]

function initialView(): ViewState {
  const t = ls.get<string>("reqforge.tab", "requirements")
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
  openDrawer: (kind: Kind | undefined, id: string | null) => void
  closeDrawer: () => void
  // data refresh
  refreshAll: () => void
  showToken: boolean
  setShowToken: (b: boolean) => void
}

const Ctx = createContext<AppCtx | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const metaQ = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: Infinity, retry: false })
  const [view, setView] = useState<ViewState>(initialView)
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [selAll, setSelAllState] = useState(false)
  const [treeOpen, setTreeOpen] = useState<Set<string>>(() => new Set(ls.get<string[]>("reqforge.open", [])))
  const [sideOpen, setSideOpen] = useState(false)
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, kind: "requirements", id: null, nonce: 0 })
  const [showToken, setShowToken] = useState(false)

  const clearSel = useCallback(() => {
    setSel(new Set())
    setSelAllState(false)
  }, [])

  const setTab = useCallback(
    (t: Tab) => {
      ls.set("reqforge.tab", t)
      setView((v) => ({ ...initialView(), limit: v.limit, tab: t }))
      clearSel()
    },
    [clearSel],
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
      ls.set("reqforge.tab", tab)
      setView((v) => ({ ...initialView(), limit: v.limit, tab, filters }))
      clearSel()
    },
    [clearSel],
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
      ls.set("reqforge.open", [...n])
      return n
    })
  }, [])

  const openDrawer = useCallback((kind: Kind | undefined, id: string | null) => {
    if (!kind) return
    setDrawer((d) => ({ open: true, kind, id, nonce: d.nonce + 1 }))
  }, [])
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false })), [])

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "meta" })
  }, [qc])

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
      showToken,
      setShowToken,
    }),
    [metaQ.data, metaQ.error, view, listKind, setTab, setFilter, setFilters, toggleFacet, setQuery, toggleSort,
      setOffset, setLimit, setLint, goto, sel, selAll, toggleSel, selectPage, clearSel, treeOpen, toggleTree,
      sideOpen, drawer, openDrawer, closeDrawer, refreshAll, showToken],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useApp outside AppProvider")
  return c
}

export const PAGE_SIZE_OPTIONS = PAGE_SIZES
