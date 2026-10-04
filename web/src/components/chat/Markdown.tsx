import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { IdLink } from "@/components/common"
import { ID_RE_G } from "@/lib/format"

const ID_HREF = "#rf:"

/** Turn bare record ids into links, leaving fenced and inline code untouched. */
function linkifyIds(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((seg, i) => (i % 2 ? seg : seg.replace(ID_RE_G, `[$1](${ID_HREF}$1)`)))
    .join("")
}

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith(ID_HREF)) return <IdLink id={href.slice(ID_HREF.length)} />
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  },
}

/** `linkIds={false}` keeps record ids as plain text (outside a project, e.g. the help panel). */
export const Markdown = memo(function Markdown({ text, linkIds = true, className }: { text: string; linkIds?: boolean; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkIds ? linkifyIds(text) : text}
      </ReactMarkdown>
    </div>
  )
})
