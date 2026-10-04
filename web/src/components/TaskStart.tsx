import { useState } from "react"
import { Lock, Play } from "lucide-react"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import type { UnfinishedDep } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { IdLink } from "@/components/common"
import { useApp } from "@/state/app"
import { useApi } from "@/state/project"
import { useReadiness } from "@/state/queries"
import { cn } from "@/lib/utils"

const depLabel = (u: UnfinishedDep) => `${u.id} (${u.status})`

/**
 * Start a todo task in one click (POST tasks/{id}/start with the loaded version): the task, and its story
 * and epic when they are todo, move to in-progress in one commit. Rendered only for todo tasks; disabled,
 * with the unfinished dependencies listed, while any `depends_on` task is not done.
 * `checkDeps` = false skips the readiness lookup (a list row whose task has no dependencies).
 */
// reqforge: implements REQ-0050
export function StartButton({
  id,
  version,
  status,
  checkDeps = true,
  layout = "row",
}: {
  id: string
  version: number
  status: string | undefined
  checkDeps?: boolean
  layout?: "row" | "drawer"
}) {
  const api = useApi()
  const { refreshAll } = useApp()
  const todo = status === "todo"
  const rd = useReadiness(id, todo && checkDeps)
  const [busy, setBusy] = useState(false)
  if (!todo) return null

  const unfinished = rd.data?.unfinished ?? []
  // a stale list row (the task moved on since it loaded) is not "blocked": Start then answers 409 and refreshes
  const blocked = unfinished.length > 0
  const checking = checkDeps && rd.isLoading

  const start = async () => {
    setBusy(true)
    try {
      const r = await api.start(id, version)
      const parents = r.changed.filter((x) => x !== id)
      toast.success(
        `${id} started` + (parents.length ? ` · ${parents.join(", ")} also moved to in-progress` : " · story and epic unchanged"),
      )
    } catch (e) {
      const deps = e instanceof ApiError ? (e.details as UnfinishedDep[]).filter((d) => d && d.id) : []
      toast.error(`${(e as Error).message}${deps.length && !(e as Error).message.includes(deps[0].id) ? ` (${deps.map(depLabel).join(", ")})` : ""}`)
    } finally {
      setBusy(false)
      refreshAll()
    }
  }

  const reason = blocked ? `Blocked until done: ${unfinished.map(depLabel).join(", ")}` : `Move ${id} to in-progress`
  const btn = (
    <Button
      size="xs"
      variant={layout === "drawer" ? "default" : "outline"}
      data-testid="start-task"
      data-id={id}
      data-blocked={blocked ? "true" : "false"}
      aria-label={blocked ? `Start ${id} (blocked: ${unfinished.map(depLabel).join(", ")})` : `Start ${id}`}
      disabled={busy || blocked || checking}
      onClick={(e) => {
        e.stopPropagation()
        void start()
      }}
    >
      {blocked ? <Lock /> : <Play />} {busy ? "Starting…" : "Start"}
    </Button>
  )

  return (
    <span className={cn("inline-flex", layout === "drawer" ? "items-center gap-2" : "flex-col items-start gap-0.5")}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* a disabled button gets no pointer events: the wrapper carries the tooltip */}
          <span tabIndex={blocked ? 0 : -1} className="inline-flex" data-testid="start-task-wrap" onClick={(e) => e.stopPropagation()}>
            {btn}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{reason}</TooltipContent>
      </Tooltip>
      {blocked && (
        <span data-testid="start-blocked" data-ids={unfinished.map((u) => u.id).join(",")} className="text-[11.5px] leading-tight text-warn">
          waits for{" "}
          {unfinished.map((u, i) => (
            <span key={u.id}>
              {i > 0 && ", "}
              <IdLink id={u.id} />
              {layout === "drawer" && <span className="text-muted-foreground"> ({u.status})</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
