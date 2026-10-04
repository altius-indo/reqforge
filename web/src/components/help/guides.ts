// The help guides: web/help/NN-<id>.md, bundled as raw text at build time (see web/help/README.md).
// Only the lazily loaded help panel imports this module, so the guides ship in that chunk.

export interface Guide {
  id: string
  title: string
  /** tab / page contexts that open the panel on this section */
  tabs: string[]
  keywords: string
  /** Markdown body (front matter stripped) */
  body: string
  /** lower-cased title + keywords + body, for search */
  haystack: string
  file: string
}

const files = import.meta.glob<string>("../../../help/[0-9]*.md", { query: "?raw", import: "default", eager: true })

function parse(file: string, raw: string): Guide {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const meta: Record<string, string> = {}
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const body = (m?.[2] ?? raw).trim()
  const name = file.split("/").pop() ?? file
  const id = meta.id || name.replace(/^\d+-/, "").replace(/\.md$/, "")
  const title = meta.title || id
  const keywords = meta.keywords || ""
  return {
    id,
    title,
    tabs: (meta.tabs || "").split(",").map((t) => t.trim()).filter(Boolean),
    keywords,
    body,
    haystack: `${title}\n${keywords}\n${body}`.toLowerCase(),
    file: name,
  }
}

export const GUIDES: Guide[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([file, raw]) => parse(file, raw))

/** The section for a tab / page context (`requirements`, `lint`, `projects`, `chat`, …); the first guide otherwise. */
export function sectionFor(context: string): string {
  return (GUIDES.find((g) => g.tabs.includes(context)) ?? GUIDES[0])?.id ?? ""
}

/** Sections whose title, keywords or text contain every word of the query (case-insensitive). */
export function searchGuides(query: string): Guide[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return GUIDES
  return GUIDES.filter((g) => words.every((w) => g.haystack.includes(w)))
}
