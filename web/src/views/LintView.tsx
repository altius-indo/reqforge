import { ChevronLeft, ChevronRight, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Cards, ErrorText, IdList, StatCard } from "@/components/common"
import { Crumbs } from "@/components/Crumbs"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useLintPage } from "@/state/queries"
import { fmt, severityClass } from "@/lib/format"
import { cn } from "@/lib/utils"

const LIMIT = 100

export function LintView() {
  const { view, setLint } = useApp()
  const chat = useChat()
  const L = view.lint
  const params = {
    rule: L.rule,
    severity: L.severity,
    type: view.filters.type,
    category: view.filters.category,
    q: view.q,
    offset: L.offset,
    limit: LIMIT,
  }
  const q = useLintPage(params)
  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const r = q.data
  const scope = view.filters.category ? `${view.filters.type} › ${view.filters.category}` : view.filters.type || "all categories"

  return (
    <div data-testid="lint-view">
      <Crumbs label="requirement findings" />
      <Cards>
        <StatCard value={r.ok ? "OK" : "ERRORS"} tone={r.ok ? "ok" : "err"} label={`${fmt(r.requirements)} requirements`} />
        {(["error", "warning", "info"] as const).map((k) => (
          <StatCard
            key={k}
            value={fmt(r.counts[k])}
            tone={k === "error" ? "err" : k === "warning" ? "warn" : "muted"}
            label={`${k}s (repository)`}
          />
        ))}
        <StatCard value={r.coverage.gaps.length} label={`taxonomy gaps / ${r.coverage.cells} cells`} />
      </Cards>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <b className="mr-1 text-[13px] font-semibold">Rules:</b>
        {Object.entries(r.by_rule).map(([rule, c]) => {
          const on = L.rule === rule
          return (
            <button
              key={rule}
              type="button"
              data-testid="rule-chip"
              data-rule={rule}
              aria-pressed={on}
              onClick={() => setLint({ rule: on ? "" : rule, offset: 0 })}
              className={cn(
                "rounded-full border bg-background px-2 py-px text-[12px] hover:border-foreground/40",
                on && "border-primary bg-primary text-primary-foreground",
              )}
            >
              {rule}
              <span className="ml-1.5 opacity-75">
                {[c.error ? `${fmt(c.error)} err` : "", c.warning ? `${fmt(c.warning)} warn` : "", c.info ? `${fmt(c.info)} info` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          )
        })}
        <NativeSelect
          size="sm"
          aria-label="severity"
          data-testid="severity"
          value={L.severity}
          onChange={(e) => setLint({ severity: e.target.value, offset: 0 })}
        >
          {["", "error", "warning", "info"].map((s) => (
            <NativeSelectOption key={s} value={s}>
              {s ? `${s} only` : "all severities"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          data-testid="lint-ask"
          onClick={() =>
            chat.ask(
              `Review the ${L.rule || "lint"} findings in ${scope} (${fmt(r.total)} in my view). Group them by root cause, then propose a changeset fixing the highest-value ones: merge or generalise duplicates into parents, make statements measurable, and remap the affected stories and evals.`,
            )
          }
        >
          <MessageSquare /> Ask Claude to fix these
        </Button>
      </div>
      <p data-testid="lint-summary" className="mb-2 text-[12.5px] text-muted-foreground">
        {fmt(r.total)} findings in {scope}
        {r.total ? ` · showing ${fmt(r.offset + 1)}–${fmt(Math.min(r.offset + r.limit, r.total))}` : ""}
      </p>
      <div className={cn("overflow-x-auto rounded-lg border bg-card", q.isFetching && "opacity-80")}>
        <table data-testid="lint-table" className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b text-left text-[12px] text-muted-foreground">
              {["severity", "rule", "records", "message"].map((t) => (
                <th key={t} className="h-8 px-2 font-semibold">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.items.map((f, i) => (
              <tr key={i} data-testid="lint-row" className="border-b last:border-b-0">
                <td className={cn("px-2 py-1.5 align-top font-medium", severityClass(f.severity))}>{f.severity}</td>
                <td className="px-2 py-1.5 align-top whitespace-nowrap">{f.rule}</td>
                <td className="px-2 py-1.5 align-top">
                  <IdList ids={f.ids} />
                </td>
                <td className="px-2 py-1.5 align-top">{f.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="my-2 flex items-center justify-end gap-2">
        <Button variant="outline" size="xs" disabled={r.offset === 0} onClick={() => setLint({ offset: Math.max(0, L.offset - LIMIT) })}>
          <ChevronLeft /> Prev
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={r.offset + r.limit >= r.total}
          onClick={() => setLint({ offset: L.offset + LIMIT })}
        >
          Next <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
