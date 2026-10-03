import type { Kind } from "@/api/types"

export const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString("en-US")
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
/** 2722 -> "2.7K" (for dense badges) */
export const compact = (n: number) => (n < 1000 ? String(n) : compactFmt.format(n))
export const pct = (v: number | null | undefined) => `${Math.round((v || 0) * 100)}%`

const PREFIX: Record<string, Kind> = { REQ: "requirements", EPIC: "epics", STORY: "stories", TASK: "tasks" }
export const kindOf = (id: string): Kind | undefined => PREFIX[String(id).split("-")[0]]

/** Splits text on record ids; odd indices are ids. */
export const ID_SPLIT_RE = /((?:REQ|EPIC|STORY|TASK)-\d{4,})/
export const ID_RE_G = /\b((?:REQ|EPIC|STORY|TASK)-\d{4,})\b/g

export const singular = (kind: Kind) => kind.replace(/ies$/, "y").replace(/s$/, "")

export const asText = (x: unknown): string =>
  typeof x === "object" && x ? String((x as { id?: string }).id ?? JSON.stringify(x)) : String(x)

export function short(v: unknown): string {
  if (v == null || v === "") return "∅"
  if (Array.isArray(v)) return v.map(asText).join(", ") || "∅"
  if (typeof v === "object") return JSON.stringify(v)
  const s = String(v)
  return s.length > 160 ? s.slice(0, 160) + "…" : s
}

export const randomId = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export const severityClass = (s: string) =>
  s === "error" ? "text-err" : s === "warning" ? "text-warn" : "text-muted-foreground"

export const statusTone = (s: string) =>
  s === "pending" ? "text-warn" : s === "applied" ? "text-ok" : "text-muted-foreground"

export function viewPrompt(filters: Record<string, string>, q: string) {
  const parts = [filters.type, filters.category].filter(Boolean)
  return `Review the ${parts.join(" › ") || "requirements"} in this view${q ? ` matching “${q}”` : ""}: check MECE (overlaps, gaps, vague or unmeasurable statements) and traceability, then propose a changeset for what should change.`
}
