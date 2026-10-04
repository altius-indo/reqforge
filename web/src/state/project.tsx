/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { onUnauthorized, projectApi, projectsApi, type ProjectApi } from "@/api/client"
import type { Project, ProjectList } from "@/api/types"
import { clearProjectStorage, ls, migrateLegacyStorage } from "@/lib/storage"

/**
 * The active project and the workspace's project list.
 *
 * Routing lives in the URL hash: `#/p/<KEY>` is the app for a project, `#/projects` the
 * projects page. The active project is the hash key when it exists, else the last-used
 * project (`reqforge.project`), else the server default, else none (onboarding).
 * Everything below the app (view state, chat, queries) is keyed by the active project.
 */

const LAST_KEY = "reqforge.project"
/** project key rules, mirrored from the server (it uppercases input) */
export const KEY_RE = /^[A-Z][A-Z0-9_-]{1,15}$/

export type Route = "app" | "projects"
type Loc = { route: Route; key: string | null }

function parseHash(h: string): Loc {
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean)
  if (parts[0] === "projects") return { route: "projects", key: null }
  if (parts[0] === "p" && parts[1]) return { route: "app", key: decodeURIComponent(parts[1]).toUpperCase() }
  return { route: "app", key: null }
}

const hashFor = (key: string) => `#/p/${encodeURIComponent(key)}`

const hashListeners = new Set<() => void>()
function subscribeHash(fn: () => void) {
  hashListeners.add(fn)
  window.addEventListener("hashchange", fn)
  return () => {
    hashListeners.delete(fn)
    window.removeEventListener("hashchange", fn)
  }
}
/** history.replaceState does not fire hashchange; tell subscribers ourselves. */
const notifyHash = () => hashListeners.forEach((fn) => fn())

let migrated = false
async function fetchProjects(): Promise<ProjectList> {
  const d = await projectsApi.list()
  if (!migrated) {
    migrated = true
    // pre-projects chat log / tab / tree keys belong to the default project
    if (d.default) migrateLegacyStorage(d.default)
  }
  return d
}

export type CreateMode = "create" | "import"

interface ProjectCtx {
  list: ProjectList | undefined
  projects: Project[]
  single: boolean
  error: Error | null
  /** the active project's key, or null (no projects / not loaded yet) */
  active: string | null
  activeProject: Project | null
  route: Route
  /** switch to a project and show its app (pushes a history entry) */
  open: (key: string) => void
  showProjects: () => void
  refresh: () => Promise<unknown>
  /** forget a deleted project (storage, cache); if it was active, `next` (the new default) takes over */
  forget: (key: string, next: string | null) => void
  createMode: CreateMode | null
  openCreate: (mode?: CreateMode) => void
  closeCreate: () => void
  showToken: boolean
  setShowToken: (b: boolean) => void
}

const Ctx = createContext<ProjectCtx | null>(null)

export function ProjectProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: 30_000, retry: false })
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const loc = useMemo(() => parseHash(hash), [hash])
  // last-used project: from storage at load, then every project opened (switcher, hash, back/forward)
  const [stored] = useState<string | null>(() => ls.get<string | null>(LAST_KEY, null))
  const [last, setLast] = useState<string | null>(() => parseHash(window.location.hash).key ?? stored)
  const [createMode, setCreateMode] = useState<CreateMode | null>(null)
  const [showToken, setShowToken] = useState(false)

  useEffect(() => onUnauthorized(() => setShowToken(true)), [])

  useEffect(() => {
    const onHash = () => {
      const l = parseHash(window.location.hash)
      if (l.route === "app" && l.key) setLast(l.key)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const projects = useMemo(() => q.data?.projects ?? [], [q.data])
  const has = useCallback((k: string | null) => !!k && projects.some((p) => p.key === k), [projects])

  let active: string | null = null
  if (q.data) {
    if (loc.route === "app" && has(loc.key)) active = loc.key
    else if (has(last)) active = last
    else if (has(stored)) active = stored
    else if (has(q.data.default)) active = q.data.default
    else active = projects[0]?.key ?? null
  }

  // remember the last-used project across reloads
  useEffect(() => {
    if (active) ls.set(LAST_KEY, active)
  }, [active])

  // keep the hash canonical (#/p/<active>) on the app route; report unknown keys
  const fetching = q.isFetching
  useEffect(() => {
    if (!q.data || loc.route !== "app" || fetching) return
    if (loc.key && !has(loc.key)) toast.error(`project ${loc.key} not found`)
    const want = active ? hashFor(active) : ""
    if (window.location.hash !== want && (active || window.location.hash)) {
      window.history.replaceState(null, "", want || window.location.pathname + window.location.search)
      notifyHash()
    }
  }, [q.data, loc, active, has, fetching])

  const open = useCallback((key: string) => {
    setLast(key)
    const h = hashFor(key)
    if (window.location.hash !== h) window.location.hash = h
  }, [])

  const showProjects = useCallback(() => {
    if (window.location.hash !== "#/projects") window.location.hash = "#/projects"
  }, [])

  const { refetch } = q
  const refresh = useCallback(() => refetch(), [refetch])

  const forget = useCallback(
    (key: string, next: string | null) => {
      clearProjectStorage(key)
      qc.removeQueries({ queryKey: ["p", key] })
      setLast((l) => (l === key ? next : l))
      if (ls.get<string | null>(LAST_KEY, null) === key) ls.remove(LAST_KEY)
    },
    [qc],
  )

  const openCreate = useCallback((mode: CreateMode = "create") => setCreateMode(mode), [])
  const closeCreate = useCallback(() => setCreateMode(null), [])

  const activeProject = projects.find((p) => p.key === active) ?? null
  const value = useMemo<ProjectCtx>(
    () => ({
      list: q.data,
      projects,
      single: !!q.data?.single,
      error: q.error,
      active,
      activeProject,
      route: loc.route,
      open,
      showProjects,
      refresh,
      forget,
      createMode,
      openCreate,
      closeCreate,
      showToken,
      setShowToken,
    }),
    [q.data, projects, q.error, active, activeProject, loc.route, open, showProjects, refresh, forget, createMode,
      openCreate, closeCreate, showToken],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useProjects(): ProjectCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useProjects outside ProjectProvider")
  return c
}

/** The active project's key; only call below the project-keyed app subtree. */
export function useProjectKey(): string {
  const { active } = useProjects()
  if (!active) throw new Error("no active project")
  return active
}

/** Endpoints bound to the active project (`/api/p/<KEY>/…`). */
export function useApi(): ProjectApi {
  const key = useProjectKey()
  return useMemo(() => projectApi(key), [key])
}
