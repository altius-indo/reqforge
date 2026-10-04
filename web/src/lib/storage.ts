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
 * Global keys (token, page size, chat panel open, last project) are not suffixed.
 */
export const PROJECT_SCOPED = ["tab", "open", "chat.log", "chat.session"] as const
export type ProjectScoped = (typeof PROJECT_SCOPED)[number]
export const pkey = (name: ProjectScoped, project: string) => `reqforge.${name}.${project}`

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
