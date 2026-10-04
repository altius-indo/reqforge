import { useState } from "react"
import { Bot, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ErrorText } from "@/components/common"
import { useApp } from "@/state/app"
import { useApi } from "@/state/project"
import { useAgentQueue, useTaskOptions } from "@/state/queries"
import { shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8]
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

/**
 * The project's agent queue in the Tasks tab: on/off (with a confirmation stating how many tasks are eligible),
 * the concurrency limit, who changed it and when, the running tasks and the waiting eligible tasks in start order.
 * Polls GET agent-queue every 3 s while the page is visible.
 */
// reqforge: implements REQ-0053
export function AgentQueuePanel() {
  const api = useApi()
  const { openDrawer, refreshAll } = useApp()
  const q = useAgentQueue()
  const titles = useTaskOptions()
  const [confirm, setConfirm] = useState<null | boolean>(null)
  const [busy, setBusy] = useState(false)
  const v = q.data
  const title = (id: string) => String(titles.data?.find((t) => t.id === id)?.title ?? "")

  const save = async (body: { enabled?: boolean; limit?: number; confirm?: boolean }, msg: string) => {
    setBusy(true)
    try {
      await api.setAgentQueue(body)
      toast.success(msg)
      refreshAll()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (q.error && !v) return <ErrorText testId="queue-error">agent queue: {(q.error as Error).message}</ErrorText>
  if (!v) return null
  const taskBtn = (id: string, testId: string, extra?: Record<string, string>) => (
    <button
      key={id}
      type="button"
      data-testid={testId}
      data-id={id}
      {...extra}
      title={title(id)}
      onClick={() => openDrawer("tasks", id, "agent")}
      className="inline-flex max-w-[260px] items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[12px] hover:border-primary/60 hover:bg-muted/40"
    >
      {testId === "queue-running-item" && <Loader2 className="size-3 shrink-0 animate-spin text-info" />}
      <span className="id-mono text-primary">{id}</span>
      {title(id) && <span className="truncate text-muted-foreground">{title(id)}</span>}
    </button>
  )

  return (
    <section
      data-testid="queue-panel"
      data-enabled={v.enabled ? "true" : "false"}
      aria-label="Agent queue"
      className={cn("mb-2 rounded-lg border bg-card px-3 py-2 text-[12.5px]", v.enabled && "border-info/40")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <b className="inline-flex items-center gap-1.5 font-semibold">
          <Bot className="size-4 text-muted-foreground" /> Agent queue
        </b>
        <button
          type="button"
          role="switch"
          aria-checked={v.enabled}
          aria-label="agent queue on/off"
          data-testid="queue-toggle"
          disabled={busy}
          onClick={() => setConfirm(!v.enabled)}
          className={cn(
            "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
            v.enabled ? "bg-info" : "bg-input",
          )}
        >
          <span className={cn("size-4 rounded-full bg-background shadow-sm transition-transform", v.enabled && "translate-x-4")} />
        </button>
        <span data-testid="queue-state" className={cn("font-medium", v.enabled ? "text-info" : "text-muted-foreground")}>
          {v.enabled ? "On" : "Off"}
        </span>
        <label className="inline-flex items-center gap-1.5 text-muted-foreground">
          at most
          <NativeSelect
            size="sm"
            aria-label="concurrent agent runs"
            data-testid="queue-limit"
            value={v.limit}
            disabled={busy}
            onChange={(e) => void save({ limit: Number(e.target.value) }, `agent queue limit set to ${e.target.value}`)}
          >
            {LIMITS.map((n) => (
              <NativeSelectOption key={n} value={n}>
                {n}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          at a time
        </label>
        <span data-testid="queue-changed" className="text-muted-foreground">
          {v.changed_by ? `turned ${v.enabled ? "on" : "off"} by ${v.changed_by} · ${shortTime(v.changed_at)}` : "off by default · never changed"}
        </span>
      </div>
      <div className="mt-1.5 grid gap-x-4 gap-y-1 md:grid-cols-[auto_minmax(0,1fr)]">
        <span className="pt-0.5 text-muted-foreground">
          running <b data-testid="queue-running-count" className="font-semibold text-foreground tabular-nums">{v.running.length}</b>
        </span>
        <div data-testid="queue-running" className="flex flex-wrap gap-1">
          {v.running.length ? v.running.map((id) => taskBtn(id, "queue-running-item")) : <span className="pt-0.5 text-muted-foreground">none</span>}
        </div>
        <span className="pt-0.5 text-muted-foreground">
          waiting <b data-testid="queue-waiting-count" className="font-semibold text-foreground tabular-nums">{v.waiting.length}</b>
        </span>
        <ol data-testid="queue-waiting" aria-label="eligible tasks in start order" className="flex flex-wrap gap-1">
          {v.waiting.length ? (
            v.waiting.map((id, i) => (
              <li key={id} className="inline-flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground tabular-nums">{i + 1}.</span>
                {taskBtn(id, "queue-waiting-item", { "data-pos": String(i + 1) })}
              </li>
            ))
          ) : (
            <li className="pt-0.5 text-muted-foreground">no eligible tasks (todo, approved requirements, dependencies done, component path, never run)</li>
          )}
        </ol>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent data-testid="queue-dialog" className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Turn the agent queue {confirm ? "on" : "off"}?</DialogTitle>
            <DialogDescription data-testid="queue-dialog-text" data-eligible={v.waiting.length} data-limit={v.limit}>
              {confirm
                ? `${plural(v.waiting.length, "eligible task")} will start automatically with a coding agent, at most ${v.limit} at a time, in ascending task id order. Runs are authorised by you and work on their own branches; tasks are never marked done automatically.`
                : `No new agent runs will start. ${plural(v.running.length, "active run")} keep${v.running.length === 1 ? "s" : ""} running; ${plural(v.waiting.length, "eligible task")} stay${v.waiting.length === 1 ? "s" : ""} waiting.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" data-testid="queue-cancel" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="queue-confirm"
              disabled={busy}
              onClick={() => {
                const on = !!confirm
                setConfirm(null)
                void save({ enabled: on, confirm: true }, `agent queue turned ${on ? "on" : "off"}`)
              }}
            >
              Turn {confirm ? "on" : "off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
