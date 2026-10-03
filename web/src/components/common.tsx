import type { ReactNode } from "react"
import { useApp } from "@/state/app"
import { ID_SPLIT_RE, kindOf } from "@/lib/format"
import { cn } from "@/lib/utils"

/** A record id that opens the record drawer. */
export function IdLink({ id, className }: { id: string; className?: string }) {
  const { openDrawer } = useApp()
  const kind = kindOf(id)
  if (!kind) return <span className={cn("id-mono", className)}>{id}</span>
  return (
    <button
      type="button"
      data-testid="id-link"
      data-id={id}
      className={cn("id-mono cursor-pointer text-primary hover:underline", className)}
      onClick={(e) => {
        e.stopPropagation()
        openDrawer(kind, id)
      }}
    >
      {id}
    </button>
  )
}

/** Plain text with every REQ-/EPIC-/STORY-/TASK- id turned into an IdLink. */
export function Linkify({ text }: { text: string }) {
  const parts = String(text).split(ID_SPLIT_RE)
  return <>{parts.map((p, i) => (i % 2 ? <IdLink key={i} id={p} /> : p))}</>
}

/** Space-separated id links. */
export function IdList({ ids }: { ids: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-1.5 gap-y-0.5">
      {ids.map((i) => (
        <IdLink key={i} id={i} />
      ))}
    </span>
  )
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full bg-muted px-1.5 py-px text-[11.5px] leading-[18px] whitespace-nowrap text-foreground/80",
        className,
      )}
    >
      {children}
    </span>
  )
}

export function StatCard({
  value,
  label,
  tone,
  onClick,
  title,
  testId,
}: {
  value: ReactNode
  label: ReactNode
  tone?: "ok" | "err" | "warn" | "muted"
  onClick?: () => void
  title?: string
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      title={title}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      className={cn(
        "rounded-lg border bg-card px-3 py-2",
        onClick && "cursor-pointer transition-colors hover:border-primary/60 hover:bg-muted/40",
      )}
    >
      <div
        className={cn(
          "text-[19px] leading-tight font-semibold tabular-nums",
          tone === "ok" && "text-ok",
          tone === "err" && "text-err",
          tone === "warn" && "text-warn",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
      <div className="text-[12px] text-muted-foreground">{label}</div>
    </div>
  )
}

export function Cards({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-3 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2.5", className)}>{children}</div>
}

export function H3({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mt-4 mb-1.5 text-[13px] font-semibold", className)}>{children}</h3>
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mx-1.5 mt-4 mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>
  )
}

export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="text-[12.5px] whitespace-pre-wrap text-err">
      {children}
    </div>
  )
}
