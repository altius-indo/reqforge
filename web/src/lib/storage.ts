/** JSON localStorage helpers that never throw (private mode, quota, blocked storage). */
export const ls = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key)
      return v == null ? fallback : (JSON.parse(v) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* ignore */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
  has(key: string): boolean {
    try {
      return localStorage.getItem(key) != null
    } catch {
      return false
    }
  },
}

/**
 * Per-project localStorage keys: `reqforge.<name>.<KEY>`.
 * Global keys (token, page size, chat panel open, panel layout, last project) are not suffixed.
 */
export const PROJECT_SCOPED = ["tab", "open", "chat.log", "chat.session", "chat.wrap"] as const
export type ProjectScoped = (typeof PROJECT_SCOPED)[number]
export const pkey = (name: ProjectScoped, project: string) => `reqforge.${name}.${project}`

/**
 * Side panel layout on wide screens (REQ-0064): global, so it survives reloads and project switches.
 * The chat panel's collapsed state is `reqforge.chat.open` (owned by the chat state).
 */
export const PANELS_KEY = "reqforge.panels"
export type PanelLayout = { side: number; chat: number; sideCollapsed: boolean }

export function loadPanels(fallback: PanelLayout): PanelLayout {
  const raw = ls.get<Partial<PanelLayout> | null>(PANELS_KEY, null)
  if (!raw || typeof raw !== "object") return fallback
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)
  return {
    side: num(raw.side, fallback.side),
    chat: num(raw.chat, fallback.chat),
    sideCollapsed: typeof raw.sideCollapsed === "boolean" ? raw.sideCollapsed : fallback.sideCollapsed,
  }
}

export const savePanels = (p: PanelLayout) => ls.set(PANELS_KEY, p)

/** Forget everything stored for a project (after it is deleted). */
export function clearProjectStorage(project: string) {
  for (const n of PROJECT_SCOPED) ls.remove(pkey(n, project))
}

/**
 * One-time migration of the pre-projects unscoped keys (`reqforge.tab`, `reqforge.open`,
 * `reqforge.chat.log`, `reqforge.chat.session`) to the given (default) project.
 */
export function migrateLegacyStorage(project: string) {
  for (const n of PROJECT_SCOPED) {
    const old = `reqforge.${n}`
    if (!ls.has(old)) continue
    if (!ls.has(pkey(n, project))) ls.set(pkey(n, project), ls.get<unknown>(old, null))
    ls.remove(old)
  }
}
