/* eslint-disable react-refresh/only-export-components */
import { useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"
import type { CodeLocation, Component, VerificationStatus } from "@/api/types"
import { blobUrl } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Label, tone and help text per verification status (badges always show the label, never colour alone). */
export const VERIF: Record<VerificationStatus, { label: string; cls: string; dot: string; help: string }> = {
  verified: {
    label: "verified",
    cls: "border-ok/35 bg-ok/10 text-ok",
    dot: "bg-ok",
    help: "every criterion has passing evidence for the current code",
  },
  pending: {
    label: "pending",
    cls: "border-info/35 bg-info/10 text-info",
    dot: "bg-info",
    help: "tagged tests or covering evals exist, but no result has been ingested",
  },
  untested: {
    label: "untested",
    cls: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
    help: "no tagged test or covering eval",
  },
  suspect: {
    label: "suspect",
    cls: "border-warn/40 bg-warn/10 text-warn",
    dot: "bg-warn",
    help: "passed, but a file it vouched for changed since",
  },
  failing: {
    label: "failing",
    cls: "border-err/40 bg-err/10 text-err",
    dot: "bg-err",
    help: "the latest result failed",
  },
}

export function VerifBadge({
  status,
  className,
  testId = "verif-badge",
}: {
  status: VerificationStatus | undefined | null
  className?: string
  testId?: string
}) {
  if (!status) return null
  const m = VERIF[status] ?? VERIF.untested
  return (
    <span
      data-testid={testId}
      data-status={status}
      title={m.help}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11.5px] leading-[17px] font-medium whitespace-nowrap",
        m.cls,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  )
}

/** A code location: link to the repository blob when the component has a repo_url, else the plain path. */
export function CodeLoc({
  loc,
  components,
  testId = "code-loc",
}: {
  loc: Pick<CodeLocation, "component" | "file" | "line" | "symbol">
  components: Component[] | undefined
  testId?: string
}) {
  const comp = components?.find((c) => c.key === loc.component)
  const url = blobUrl(comp?.repo_url, loc.file, loc.line)
  const where = `${loc.file}:${loc.line}`
  return (
    <span data-testid={testId} data-file={loc.file} className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className="rounded bg-muted px-1 text-[11px] text-muted-foreground">{loc.component}</span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="id-mono inline-flex items-center gap-0.5 break-all whitespace-normal text-primary hover:underline"
          title={comp?.path ? `${comp.path}/${loc.file}` : url}
        >
          {where}
          <ExternalLink className="size-3 flex-none" />
        </a>
      ) : (
        <span className="id-mono break-all whitespace-normal" title={comp?.path ? `${comp.path}/${loc.file}` : undefined}>
          {where}
        </span>
      )}
      {loc.symbol && (
        <code data-testid="code-symbol" className="text-[12px] break-all text-foreground/80">
          {loc.symbol}
        </code>
      )}
    </span>
  )
}

/** A one-line code snippet with a copy button. */
export function Snippet({ code }: { code: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="group flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1 font-mono text-[12px]">
      <code data-testid="tag-snippet" className="min-w-0 flex-1 break-all">
        {code}
      </code>
      <button
        type="button"
        aria-label="copy snippet"
        className="flex-none rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(
            () => {
              setDone(true)
              setTimeout(() => setDone(false), 1200)
            },
            () => undefined,
          )
        }}
      >
        {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** How to tag code and tests for a requirement (empty states). */
export function TagHelp({ id, ac = "AC1", implementation = true, tests = true }: { id: string; ac?: string; implementation?: boolean; tests?: boolean }) {
  return (
    <div data-testid="tag-help" className="space-y-1.5 text-[12.5px] text-muted-foreground">
      {implementation && (
        <>
          <p>Tag the implementing function or module with a comment:</p>
          <Snippet code={`# reqforge: implements ${id}`} />
        </>
      )}
      {tests && (
        <>
          <p>Tag a test with the criterion it verifies (pytest marker, Jest title, or a comment):</p>
          <Snippet code={`@pytest.mark.req("${id}#${ac}")`} />
          <Snippet code={`test("[${id}#${ac}] …", async () => { … })`} />
        </>
      )}
      <p>
        Then scan the component (Verification › Scan now) and ingest CI results (JUnit XML or a reqforge eval report).
      </p>
    </div>
  )
}
