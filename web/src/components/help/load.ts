// The guides (Markdown text, ./guides.ts) are a lazily loaded chunk: prefetched when the browser is idle after
// start-up (or when the pointer or focus reaches a Help button), loaded at the latest on the first open, then cached.
export type GuidesModule = typeof import("./guides")

let guidesModule: Promise<GuidesModule> | null = null
let loaded: GuidesModule | null = null

export const loadGuides = () =>
  (guidesModule ??= import("./guides").then((m) => (loaded = m)).catch((e: unknown) => {
    guidesModule = null // let the next open retry
    throw e
  }))

/** the guides module if it has already loaded */
export const loadedGuides = () => loaded

export const preloadGuides = () => void loadGuides().catch(() => {})
