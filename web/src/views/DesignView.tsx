import { FileText } from "lucide-react"
import type { DesignDoc } from "@/api/types"
import { ErrorText, IdList } from "@/components/common"
import { Markdown } from "@/components/chat/Markdown"
import { useApp } from "@/state/app"
import { useProjects } from "@/state/project"
import { useDesignDoc, useDesignDocs } from "@/state/queries"
import { cn } from "@/lib/utils"

/** Drop a leading `---` front matter block: title and realises are shown from the document list. */
function stripFrontMatter(md: string): string {
  const m = md.match(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  return m ? md.slice(m[0].length) : md
}

/**
 * Design tab (REQ-0055): the project's design documents (design/<slug>.md) by title, sorted by slug, and the
 * selected one rendered as GitHub-flavoured Markdown with its realised requirements; every record id opens the
 * drawer. The selection is the `doc` filter, so the drawer's Links & impact tab can open a document here.
 */
// reqforge: implements REQ-0055
export function DesignView() {
  const { view, setFilter } = useApp()
  const { activeProject } = useProjects()
  const q = useDesignDocs()
  if (q.error) return <ErrorText testId="design-error">{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const docs = [...q.data].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  if (!docs.length) {
    const dir = activeProject?.path ? `${activeProject.path.replace(/\/+$/, "")}/design/` : "design/"
    return (
      <div data-testid="design-empty" className="mx-auto mt-10 max-w-[560px] text-center text-[13.5px] text-muted-foreground">
        <FileText className="mx-auto mb-2 size-8 opacity-50" />
        <p className="font-medium text-foreground">No design documents yet.</p>
        <p className="mt-1">
          Add Markdown files as <code className="id-mono" data-testid="design-path">{dir}&lt;slug&gt;.md</code> in the
          requirements repository, with front matter giving a <code className="id-mono">title</code> and the{" "}
          <code className="id-mono">realises</code> list of requirement ids.
        </p>
      </div>
    )
  }
  const sel = docs.find((d) => d.slug === view.filters.doc) ?? docs[0]
  return (
    <div data-testid="design-view" className="grid gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
      <nav aria-label="design documents" className="md:sticky md:top-0 md:self-start">
        <ul data-testid="design-list" className="space-y-0.5">
          {docs.map((d) => (
            <li key={d.slug}>
              <button
                type="button"
                data-testid="design-item"
                data-slug={d.slug}
                aria-current={d.slug === sel.slug ? "page" : undefined}
                onClick={() => setFilter("doc", d.slug)}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted",
                  d.slug === sel.slug && "bg-muted font-semibold",
                )}
              >
                {d.title || d.slug}
                <span className="block id-mono text-[11px] font-normal text-muted-foreground">{d.slug}.md</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <DesignDocument key={sel.slug} doc={sel} />
    </div>
  )
}

function DesignDocument({ doc }: { doc: DesignDoc }) {
  const q = useDesignDoc(doc.slug)
  return (
    <article data-testid="design-doc" data-slug={doc.slug} className="min-w-0 max-w-[900px] rounded-lg border bg-card px-5 py-4">
      <h2 data-testid="design-title" className="text-[17px] font-semibold tracking-tight">
        {doc.title || doc.slug}
      </h2>
      <p className="id-mono text-[11.5px] text-muted-foreground">design/{doc.slug}.md</p>
      <div data-testid="design-realises" className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
        <span className="text-muted-foreground">Realises</span>
        {doc.realises?.length ? <IdList ids={doc.realises} /> : <span className="text-warn">no requirements listed</span>}
      </div>
      <div data-testid="design-body" className="mt-3 border-t pt-3">
        {q.error ? (
          <ErrorText>{(q.error as Error).message}</ErrorText>
        ) : q.data === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <Markdown text={stripFrontMatter(String(q.data))} className="design-md" />
        )}
      </div>
    </article>
  )
}
