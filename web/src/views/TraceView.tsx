import { MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Cards, ErrorText, Linkify, StatCard } from "@/components/common"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useTrace } from "@/state/queries"
import { fmt, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ChevronRight } from "lucide-react"

export function TraceView() {
  const { goto } = useApp()
  const chat = useChat()
  const q = useTrace()
  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const r = q.data
  const x = r.metrics
  return (
    <div data-testid="trace-view">
      <Cards>
        <StatCard
          testId="trace-verdict"
          value={r.ok ? "PASS" : "FAIL"}
          tone={r.ok ? "ok" : "err"}
          label={`CI gate · score ${pct(r.score)}`}
        />
        <StatCard
          testId="trace-req-coverage"
          value={pct(x.requirement_coverage)}
          label="requirements → stories ›"
          title="show requirements without a story"
          onClick={() => goto("requirements", { covered: "no" })}
        />
        <StatCard value={pct(x.criteria_coverage)} label="criteria → evals" />
        {(["requirements", "stories", "tasks", "evals"] as const).map((k) => (
          <StatCard key={k} value={fmt(x[k])} label={k} />
        ))}
      </Cards>
      <div className="mb-3">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          data-testid="trace-ask"
          onClick={() =>
            chat.ask(
              "Run the traceability evaluation, explain the biggest risks, and propose a changeset that remaps or fills the most important gaps.",
            )
          }
        >
          <MessageSquare /> Ask Claude to fix gaps
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table data-testid="trace-checks" className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b text-left text-[12px] text-muted-foreground">
              <th className="h-8 px-2 font-semibold">check</th>
              <th className="px-2 font-semibold">result</th>
              <th className="px-2 font-semibold">failures</th>
            </tr>
          </thead>
          <tbody>
            {r.checks.map((c) => (
              <tr key={c.id} className="border-b last:border-b-0">
                <td className="px-2 py-1.5 align-top">
                  {c.name}
                  <div className="id-mono text-[11px] text-muted-foreground">{c.id}</div>
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 align-top font-medium",
                    c.passed ? "text-ok" : c.severity === "error" ? "text-err" : "text-warn",
                  )}
                >
                  {c.passed ? "pass" : c.severity}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {c.failures.length ? (
                    <Collapsible>
                      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-primary hover:underline">
                        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                        {fmt(c.failures.length)}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px]">
                          {c.failures.slice(0, 200).map((f, i) => (
                            <li key={i}>
                              <Linkify text={f} />
                            </li>
                          ))}
                        </ul>
                        {c.failures.length > 200 && (
                          <p className="mt-1 text-[12px] text-muted-foreground">…and {fmt(c.failures.length - 200)} more</p>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
