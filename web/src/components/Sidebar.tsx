import type { ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { VERIFICATION_STATUSES, type FacetCounts, type Kind, type TreeNode } from "@/api/types"
import { Progress } from "@/components/ui/progress"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { SectionLabel } from "@/components/common"
import { useApp } from "@/state/app"
import { facetParams, useFacets, useVerification } from "@/state/queries"
import { VERIF } from "@/components/verification"
import { compact, fmt } from "@/lib/format"
import { cn } from "@/lib/utils"

const SIDE_FACETS: Record<Kind, string[]> = {
  requirements: ["status", "priority", "tags"],
  epics: ["status", "tags"],
  stories: ["status", "deliverable", "component", "tags"],
  tasks: ["kind", "status", "tags"],
  components: ["language", "owners", "tags"],
}

function CovBar({ covered, count }: { covered: number; count: number }) {
  const p = count ? Math.round((100 * covered) / count) : 0
  return (
    <span title={`${covered}/${count} linked to stories (${p}%)`} className="flex-none">
      <Progress
        value={p}
        aria-label="story coverage"
        className="h-[5px] w-8 bg-border [&>[data-slot=progress-indicator]]:bg-ok"
      />
    </span>
  )
}

function Health({ errors, warnings }: { errors: number; warnings: number }) {
  return (
    <>
      {!!errors && (
        <span className="text-[11px] text-err tabular-nums" title={`${errors} lint errors`}>
          ●{compact(errors)}
        </span>
      )}
      {!!warnings && (
        <span className="text-[11px] text-warn tabular-nums" title={`${warnings} lint warnings`}>
          ●{compact(warnings)}
        </span>
      )}
    </>
  )
}

function Node({
  on,
  faded,
  indent,
  onClick,
  children,
  title,
  testId,
  data,
}: {
  on?: boolean
  faded?: boolean
  indent?: boolean
  onClick: () => void
  children: ReactNode
  title?: string
  testId?: string
  data?: Record<string, string>
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      data-testid={testId}
      data-active={on ? "true" : undefined}
      {...Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [`data-${k}`, v]))}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[13px] select-none hover:bg-muted",
        indent && "pl-6",
        on && "bg-sel font-semibold hover:bg-sel",
        faded && "opacity-55",
      )}
    >
      {children}
    </div>
  )
}

const Count = ({ n }: { n: number }) => (
  <span className="min-w-[30px] text-right text-[12px] text-muted-foreground tabular-nums">{fmt(n)}</span>
)
const Name = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className="min-w-0 flex-1 truncate" title={title}>
    {children}
  </span>
)

function FacetChips({ facet, counts, active, onToggle }: { facet: string; counts: FacetCounts; active: string[]; onToggle: (v: string) => void }) {
  const vals = Object.entries(counts).slice(0, facet === "tags" ? 24 : 50)
  if (!vals.length) return null
  return (
    <>
      <SectionLabel>{facet}</SectionLabel>
      <div className="flex flex-wrap gap-1 px-1.5">
        {vals.map(([v, c]) => {
          const on = active.includes(v)
          return (
            <button
              key={v}
              type="button"
              data-testid="facet-chip"
              data-facet={facet}
              data-value={v}
              aria-pressed={on}
              onClick={() => onToggle(v)}
              className={cn(
                "rounded-full border bg-background px-2 py-px text-[12px] transition-colors hover:border-foreground/40",
                on && "border-primary bg-primary text-primary-foreground hover:border-primary",
              )}
            >
              {v}
              <span className="ml-1 opacity-70 tabular-nums">{fmt(c)}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/** "✓3" = verified requirements in the cell (from the verification summary) */
function Verified({ n, of }: { n: number; of: number }) {
  if (!n) return null
  return (
    <span data-testid="tree-verified" className="text-[11px] text-ok tabular-nums" title={`${n}/${of} requirements verified`}>
      ✓{compact(n)}
    </span>
  )
}

function Tree({ tree }: { tree: TreeNode[] }) {
  const { view, setFilters, treeOpen, toggleTree } = useApp()
  const byCat = useVerification().data?.summary.by_category
  const verified = (type: string, cat?: string) => {
    if (!byCat) return [0, 0]
    if (cat) return [byCat[`${type}/${cat}`]?.verified ?? 0, byCat[`${type}/${cat}`]?.requirements ?? 0]
    return Object.entries(byCat)
      .filter(([k]) => k.startsWith(`${type}/`))
      .reduce(([v, r], [, c]) => [v + c.verified, r + c.requirements], [0, 0])
  }
  const f = view.filters
  const total = tree.reduce((a, n) => a + n.count, 0)
  const without = (...keys: string[]) => Object.fromEntries(Object.entries(f).filter(([k]) => !keys.includes(k)))
  return (
    <div data-testid="tree">
      <SectionLabel>Categories</SectionLabel>
      <Node on={!f.type} onClick={() => setFilters(without("type", "category"))} testId="tree-all">
        <span className="w-3.5" />
        <Name>All requirements</Name>
        <Count n={total} />
      </Node>
      {tree.map((n) => {
        const open = treeOpen.has(n.type) || f.type === n.type
        return (
          <div key={n.type}>
            <Node
              on={f.type === n.type && !f.category}
              onClick={() => setFilters({ ...without("category"), type: n.type })}
              testId="tree-type"
              data={{ type: n.type }}
            >
              <button
                type="button"
                aria-label={open ? `collapse ${n.type}` : `expand ${n.type}`}
                className="flex w-3.5 justify-center text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleTree(n.type)
                }}
              >
                {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
              <Name>{n.type}</Name>
              <Health errors={n.errors} warnings={0} />
              <Verified n={verified(n.type)[0]} of={verified(n.type)[1]} />
              <CovBar covered={n.covered} count={n.count} />
              <Count n={n.count} />
            </Node>
            {open &&
              n.categories.map((c) => {
                const gap = !c.count && !c.waived
                return (
                  <Node
                    key={c.category}
                    indent
                    on={f.type === n.type && f.category === c.category}
                    faded={!!c.waived && !c.count}
                    title={c.waived ? `waived: ${c.waived}` : gap ? "coverage gap: no requirement and no waiver" : undefined}
                    onClick={() => setFilters({ ...f, type: n.type, category: c.category })}
                    testId="tree-cat"
                    data={{ type: n.type, category: c.category }}
                  >
                    <Name>{c.category}</Name>
                    {gap ? (
                      <span className="text-[11px] font-medium text-warn">gap</span>
                    ) : c.waived && !c.count ? (
                      <span className="text-[11px] text-muted-foreground">waived</span>
                    ) : null}
                    <Health errors={c.errors} warnings={c.warnings} />
                    <Verified n={verified(n.type, c.category)[0]} of={verified(n.type, c.category)[1]} />
                    {c.count ? <CovBar covered={c.covered} count={c.count} /> : null}
                    <Count n={c.count} />
                  </Node>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

function SidebarBody() {
  const { view, listKind, setFilter, toggleFacet } = useApp()
  const isLint = view.tab === "lint"
  const params = isLint ? {} : facetParams(view.q, view.filters)
  const facetsQ = useFacets(listKind, params)
  const F = facetsQ.data

  if (view.tab === "trace")
    return (
      <>
        <SectionLabel>Traceability</SectionLabel>
        <p className="px-1.5 text-[12.5px] text-muted-foreground">
          Requirement → story → task → eval gate, the same check CI runs.
        </p>
      </>
    )
  if (view.tab === "verification")
    return (
      <>
        <SectionLabel>Verification</SectionLabel>
        <p className="px-1.5 text-[12.5px] text-muted-foreground">
          Requirement → acceptance criterion → tagged test or eval → CI result → implementing code. A criterion is
          verified when its latest result passed and the code it vouched for has not changed since.
        </p>
        <SectionLabel>Statuses</SectionLabel>
        <ul className="space-y-1 px-1.5 text-[12.5px]">
          {VERIFICATION_STATUSES.map((s) => (
            <li key={s} className="flex gap-1.5">
              <span aria-hidden className={cn("mt-1.5 size-1.5 flex-none rounded-full", VERIF[s].dot)} />
              <span>
                <b className="font-semibold">{VERIF[s].label}</b>{" "}
                <span className="text-muted-foreground">{VERIF[s].help}</span>
              </span>
            </li>
          ))}
        </ul>
      </>
    )
  if (view.tab === "changes")
    return (
      <>
        <SectionLabel>Changesets</SectionLabel>
        <p className="px-1.5 text-[12.5px] text-muted-foreground">
          Everything Claude proposes lands here for review. Applying writes it atomically as one git commit; records
          edited since the proposal make it stale.
        </p>
      </>
    )
  if (!listKind || !F) return <p className="px-1.5 py-2 text-[12.5px] text-muted-foreground">Loading…</p>

  const counts = (f: string) => (F[f] as FacetCounts | undefined) || {}
  return (
    <>
      {listKind === "requirements" && F._tree && <Tree tree={F._tree} />}
      {view.tab === "requirements" && (
        <>
          <SectionLabel>Traceability</SectionLabel>
          <div className="flex flex-wrap gap-1 px-1.5">
            {(
              [
                ["no", "Not linked to a story"],
                ["yes", "Linked"],
              ] as const
            ).map(([v, l]) => {
              const on = view.filters.covered === v
              return (
                <button
                  key={v}
                  type="button"
                  data-testid={`covered-${v}`}
                  aria-pressed={on}
                  onClick={() => setFilter("covered", on ? "" : v)}
                  className={cn(
                    "rounded-full border bg-background px-2 py-px text-[12px] hover:border-foreground/40",
                    on && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {l}
                </button>
              )
            })}
          </div>
          {F._verification && (
            <>
              <SectionLabel>Verification</SectionLabel>
              <div data-testid="verif-facets" className="flex flex-wrap gap-1 px-1.5">
                {VERIFICATION_STATUSES.map((s) => {
                  const n = (F._verification as FacetCounts)[s] ?? 0
                  const on = (view.filters.verification || "").split("|").includes(s)
                  return (
                    <button
                      key={s}
                      type="button"
                      data-testid="verif-chip"
                      data-value={s}
                      data-count={n}
                      aria-pressed={on}
                      title={VERIF[s].help}
                      disabled={!n && !on}
                      onClick={() => toggleFacet("verification", s)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border bg-background px-2 py-px text-[12px] transition-colors hover:border-foreground/40 disabled:cursor-default disabled:opacity-45 disabled:hover:border-border",
                        on && "border-primary bg-primary text-primary-foreground hover:border-primary",
                      )}
                    >
                      <span aria-hidden className={cn("size-1.5 rounded-full", VERIF[s].dot, on && "ring-1 ring-primary-foreground")} />
                      {VERIF[s].label}
                      <span className="opacity-70 tabular-nums">{fmt(n)}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
      {view.tab === "stories" && F.epic && (
        <>
          <SectionLabel>Epics</SectionLabel>
          <Node on={!view.filters.epic} onClick={() => setFilter("epic", "")} testId="epic-all">
            <Name>All epics</Name>
          </Node>
          {Object.entries(counts("epic")).map(([e, c]) => (
            <Node
              key={e}
              on={view.filters.epic === e}
              onClick={() => setFilter("epic", e)}
              testId="epic-node"
              data={{ epic: e }}
            >
              <Name title={F._epic_titles?.[e] || ""}>
                <span className="id-mono text-muted-foreground">{e}</span> {F._epic_titles?.[e] || ""}
              </Name>
              <Count n={c} />
            </Node>
          ))}
        </>
      )}
      {!isLint &&
        SIDE_FACETS[listKind].map((f) => (
          <FacetChips
            key={f}
            facet={f}
            counts={counts(f)}
            active={(view.filters[f] || "").split("|")}
            onToggle={(v) => toggleFacet(f, v)}
          />
        ))}
    </>
  )
}

// reqforge: implements REQ-0030
export function Sidebar() {
  const { sideOpen, setSideOpen } = useApp()
  return (
    <>
      <aside data-testid="sidebar" className="hidden min-h-0 overflow-y-auto border-r bg-card px-2 pt-1 pb-6 lg:block">
        <SidebarBody />
      </aside>
      <Sheet open={sideOpen} onOpenChange={setSideOpen}>
        <SheetContent side="left" className="w-[290px] gap-0 overflow-y-auto p-2 lg:hidden">
          <SheetHeader className="p-2">
            <SheetTitle>Browse</SheetTitle>
            <SheetDescription className="sr-only">Categories and filters</SheetDescription>
          </SheetHeader>
          <SidebarBody />
        </SheetContent>
      </Sheet>
    </>
  )
}
