import { Scale } from "lucide-react"
import type { DecisionExercised } from "@/api/types"
import { Cards, Chip, ErrorText, IdLink, IdList, StatCard } from "@/components/common"
import { useApp } from "@/state/app"
import { useDecisions } from "@/state/queries"
import { cn } from "@/lib/utils"

const decisionStatusClass = (s: string) =>
  s === "accepted" ? "text-ok" : s === "superseded" ? "text-muted-foreground line-through" : "text-info"

/** "yes" / "no" with the reason as its tooltip. */
export function ExercisedFlag({ d, className }: { d: Pick<DecisionExercised, "exercised" | "reason">; className?: string }) {
  return (
    <span
      data-testid="decision-exercised"
      data-exercised={d.exercised ? "yes" : "no"}
      title={d.exercised ? "code relies on it and every tagged test passes" : d.reason}
      className={cn("font-semibold", d.exercised ? "text-ok" : "text-warn", className)}
    >
      {d.exercised ? "yes" : "no"}
    </span>
  )
}

/**
 * Decisions tab (REQ-0061#AC4): every decision with its status, whether tested code relies on it (exercised) and the
 * requirements it is linked to. A row opens the decision in the drawer on its Exercised tab (tagged locations).
 */
// reqforge: implements REQ-0061
export function DecisionsView() {
  const { openDrawer } = useApp()
  const q = useDecisions()
  if (q.error) return <ErrorText testId="decisions-error">{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const list = Object.values(q.data.decisions).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!list.length)
    return (
      <div data-testid="decisions-empty" className="mx-auto mt-10 max-w-[560px] text-center text-[13.5px] text-muted-foreground">
        <Scale className="mx-auto mb-2 size-8 opacity-50" />
        <p className="font-medium text-foreground">No decisions yet.</p>
        <p className="mt-1">
          Decisions (DEC-NNNN) are created through changesets: ask Claude in the chat to record one, then apply the
          changeset on the Changes tab.
        </p>
      </div>
    )
  const { exercised } = q.data.summary
  const unexercisedAccepted = list.filter((d) => d.status === "accepted" && !d.exercised).length
  return (
    <div data-testid="decisions-view">
      <Cards className="max-w-[640px]">
        <StatCard testId="decisions-count" value={list.length} label="decisions" />
        <StatCard testId="decisions-exercised-count" value={exercised} label="exercised" tone={exercised ? "ok" : "muted"} />
        <StatCard
          testId="decisions-unexercised-accepted"
          value={unexercisedAccepted}
          label="accepted, not exercised"
          tone={unexercisedAccepted ? "warn" : "muted"}
        />
      </Cards>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table data-testid="decisions-table" className="w-full text-[13px]">
          <thead className="border-b bg-muted/40 text-left text-[12px] text-muted-foreground">
            <tr>
              <th className="px-2.5 py-1.5 font-medium">id</th>
              <th className="px-2.5 py-1.5 font-medium">title</th>
              <th className="px-2.5 py-1.5 font-medium">status</th>
              <th className="px-2.5 py-1.5 font-medium">exercised</th>
              <th className="px-2.5 py-1.5 font-medium">requirements</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.map((d) => (
              <tr
                key={d.id}
                data-testid="decision-row"
                data-id={d.id}
                className="cursor-pointer align-top hover:bg-muted/40"
                onClick={() => openDrawer("decisions", d.id, "exercised")}
              >
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <IdLink id={d.id} />
                </td>
                <td className="px-2.5 py-1.5">{d.title}</td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <Chip className={decisionStatusClass(d.status)}>
                    <span data-testid="decision-status">{d.status}</span>
                  </Chip>
                  {d.superseded_by && (
                    <span className="ml-1 text-[12px] text-muted-foreground" onClick={(e) => e.stopPropagation()}>
                      by <IdLink id={d.superseded_by} />
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-1.5">
                  <ExercisedFlag d={d} />
                  {!d.exercised && (
                    <div data-testid="decision-reason" className="max-w-[320px] text-[12px] text-muted-foreground">
                      {d.reason}
                    </div>
                  )}
                </td>
                <td data-testid="decision-reqs" className="px-2.5 py-1.5" onClick={(e) => e.stopPropagation()}>
                  {d.requirements.length ? <IdList ids={d.requirements} /> : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
