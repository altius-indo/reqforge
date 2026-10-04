import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Markdown } from "@/components/chat/Markdown"
import { cn } from "@/lib/utils"
import { loadGuides, loadedGuides, type GuidesModule } from "./load"

const sectionDomId = (id: string) => `help-sec-${id}`

/**
 * Body of the help panel: table of contents + the guide sections (web/help/*.md), filtered by the
 * search box in the panel header. Shows a loading line until the guides chunk is in. Mounted afresh on
 * every open (keyed), so it starts on the section for the active tab. Contents entries are
 * buttons, not `#` links: the URL hash is the app's route.
 */
// reqforge: implements REQ-0048
export function HelpPanel({ context, query }: { context: string; query: string }) {
  const [mod, setMod] = useState<GuidesModule | null>(loadedGuides)
  const [error, setError] = useState("")
  useEffect(() => {
    if (mod) return
    let live = true
    loadGuides().then(
      (m) => live && setMod(m),
      (e: unknown) => live && setError((e as Error).message),
    )
    return () => {
      live = false
    }
  }, [mod])
  if (error) return <p data-testid="help-error" className="p-4 text-err">Could not load the help guides: {error}</p>
  if (!mod) return <p className="p-4 text-muted-foreground">Loading…</p>
  return <HelpSections guides={mod} context={context} query={query} />
}

function HelpSections({ guides, context, query }: { guides: GuidesModule; context: string; query: string }) {
  const { GUIDES, searchGuides, sectionFor } = guides
  const [current, setCurrent] = useState(() => sectionFor(context))
  const contentRef = useRef<HTMLDivElement>(null)
  const shown = searchGuides(query)
  const q = query.trim()

  const scrollTo = (id: string) => {
    const box = contentRef.current
    const el = document.getElementById(sectionDomId(id))
    // the content box is `relative`, so offsetTop is measured from its top
    if (box && el) box.scrollTop = el.offsetTop
  }

  // open on the section for the active tab
  const initial = useRef(current)
  useLayoutEffect(() => scrollTo(initial.current), [])

  // a new search starts at the top of the results
  useLayoutEffect(() => {
    if (q && contentRef.current) contentRef.current.scrollTop = 0
  }, [q])

  return (
    <div data-testid="help-body" data-section={current} className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <nav
        aria-label="help contents"
        data-testid="help-toc"
        className="flex-none border-b px-2 py-2 sm:w-[190px] sm:overflow-y-auto sm:border-r sm:border-b-0"
      >
        <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Contents</div>
        <ol className="flex flex-wrap gap-0.5 sm:flex-col">
          {shown.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                data-testid="help-toc-item"
                data-section={g.id}
                aria-current={g.id === current ? "true" : undefined}
                aria-controls={sectionDomId(g.id)}
                onClick={() => {
                  setCurrent(g.id)
                  scrollTo(g.id)
                }}
                className={cn(
                  "w-full rounded-md px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
                  g.id === current && "bg-muted font-semibold text-foreground",
                )}
              >
                {g.title}
              </button>
            </li>
          ))}
        </ol>
        {q && (
          <p data-testid="help-match-count" className="px-2 pt-1.5 text-[11.5px] text-muted-foreground">
            {shown.length} of {GUIDES.length} sections match
          </p>
        )}
      </nav>
      <div ref={contentRef} data-testid="help-content" className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-[40vh]">
        {shown.length ? (
          shown.map((g) => (
            <section
              key={g.id}
              id={sectionDomId(g.id)}
              data-testid="help-section"
              data-section={g.id}
              data-current={g.id === current ? "true" : undefined}
              aria-labelledby={`${sectionDomId(g.id)}-title`}
              className="border-b pt-1 pb-5 last:border-b-0"
            >
              <h2 id={`${sectionDomId(g.id)}-title`} className="mb-1.5 text-[16px] font-semibold tracking-tight">
                {g.title}
              </h2>
              <Markdown text={g.body} linkIds={false} className="help-md" />
            </section>
          ))
        ) : (
          <p data-testid="help-no-results" role="status" className="pt-6 text-center text-muted-foreground">
            No help sections match “{q}”. Try another word, or clear the search to see every guide.
          </p>
        )}
      </div>
    </div>
  )
}
