import { X } from "lucide-react"
import { useApp } from "@/state/app"
import { ChevronRight } from "lucide-react"

function Pill({ label, onRemove, ariaLabel }: { label: string; onRemove: () => void; ariaLabel: string }) {
  return (
    <span
      data-testid="filter-pill"
      className="inline-flex items-center gap-0.5 rounded-full bg-muted py-px pr-0.5 pl-2.5 text-[12px]"
    >
      {label}
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onRemove}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

const Sep = () => <ChevronRight className="size-3.5 text-muted-foreground" />

/** All › type › category (› children of X) + removable filter pills + search pill. */
export function Crumbs({ label }: { label: string }) {
  const { view, setFilters, setFilter, setQuery } = useApp()
  const f = view.filters
  const extra = Object.entries(f).filter(([k]) => !["type", "category", "parent"].includes(k))
  return (
    <div data-testid="crumbs" className="mb-2 flex flex-wrap items-center gap-1.5 text-[13px]">
      <button type="button" className="text-primary hover:underline" onClick={() => setFilters({}, "")}>
        All {label}
      </button>
      {f.type && (
        <>
          <Sep />
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setFilters(Object.fromEntries(Object.entries(f).filter(([k]) => k !== "category")))}
          >
            {f.type}
          </button>
        </>
      )}
      {f.category && (
        <>
          <Sep />
          <b className="font-semibold">{f.category}</b>
        </>
      )}
      {f.parent && (
        <>
          <Sep />
          <b className="font-semibold">children of {f.parent}</b>
          <Pill label="parent" ariaLabel="remove parent filter" onRemove={() => setFilter("parent", "")} />
        </>
      )}
      {extra.map(([k, v]) => (
        <Pill key={k} label={`${k}: ${v}`} ariaLabel="remove filter" onRemove={() => setFilter(k, "")} />
      ))}
      {view.q && <Pill label={`“${view.q}”`} ariaLabel="clear search" onRemove={() => setQuery("")} />}
    </div>
  )
}
