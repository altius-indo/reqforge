/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Bot, GitBranch, GitCommitHorizontal, ListPlus, Loader2, Square, Wrench } from "lucide-react"
import { toast } from "sonner"
import { streamAgent } from "@/api/client"
import type { AgentEvent, AgentExitStatus, AgentPlan, CompleteRunLog, RunLog } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Chip, ErrorText, H3 } from "@/components/common"
import { useApp } from "@/state/app"
import { useApi } from "@/state/project"
import { useRuns } from "@/state/queries"
import { shortSha, shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type ResultEvent = Extract<AgentEvent, { type: "result" }>
type RunEvent = Extract<AgentEvent, { type: "run" }>

export interface AgentRunState {
  events: AgentEvent[]
  /** a run is in progress (streamed from here, or started elsewhere and polled) */
  running: boolean
  /** "stream": started in this drawer; "live": watched through agent/live */
  source: "stream" | "live" | null
  run: RunEvent | null
  result: ResultEvent | null
  start: () => void
  cancel: () => void
}

const IDLE_POLL_MS = 4000
const LIVE_POLL_MS = 1500

/**
 * The coding-agent run of one task: streams a run started here (POST tasks/{id}/agent), and otherwise
 * follows the task's live buffer (GET tasks/{id}/agent/live) so runs started elsewhere (the queue, another
 * tab) show their progress too — every 1.5 s while running, every 4 s while idle.
 */
export function useAgentRun(taskId: string | null): AgentRunState {
  const api = useApi()
  const { refreshAll } = useApp()
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const [liveRunning, setLiveRunning] = useState(false)
  const [source, setSource] = useState<"stream" | "live" | null>(null)
  const since = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const wasRunning = useRef(false)

  useEffect(() => () => abort.current?.abort(), [])

  // follow the live buffer while not streaming
  useEffect(() => {
    if (!taskId || streaming) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      let running = false
      try {
        const l = await api.agentLive(taskId, since.current)
        if (stop) return
        if (l.total < since.current) {
          // a new run replaced the buffer: start over
          since.current = 0
          setEvents([])
          timer = setTimeout(tick, 0)
          return
        }
        if (l.events.length) {
          const fresh = since.current === 0
          setEvents((cur) => (fresh ? l.events : [...cur, ...l.events]))
          setSource("live")
        }
        since.current = l.total
        running = l.running
        setLiveRunning(running)
        if (wasRunning.current && !running) refreshAll()
        wasRunning.current = running
      } catch {
        /* transient: try again on the next tick */
      }
      if (!stop) timer = setTimeout(tick, running ? LIVE_POLL_MS : IDLE_POLL_MS)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [api, taskId, streaming, refreshAll])

  const start = useCallback(() => {
    if (!taskId) return
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setEvents([])
    setSource("stream")
    setStreaming(true)
    void (async () => {
      try {
        for await (const ev of streamAgent(api.key, taskId, ctrl.signal)) {
          setEvents((cur) => [...cur, ev])
          if (ev.type === "run") refreshAll() // the task (and its story/epic) just moved to in-progress
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setEvents((cur) => [...cur, { type: "error", text: (e as Error).message }])
      } finally {
        if (!ctrl.signal.aborted) {
          // continue from the end of the live buffer, which holds the events just streamed
          try {
            since.current = (await api.agentLive(taskId, 1e9)).total
          } catch {
            since.current = 0
          }
          wasRunning.current = false
          setStreaming(false)
          refreshAll()
        }
      }
    })()
  }, [api, taskId, refreshAll])

  const cancel = useCallback(() => {
    if (!taskId) return
    api
      .agentCancel(taskId)
      .then((r) => (r.cancelled ? toast.info(`cancelling the agent run of ${taskId}…`) : toast.warning("no agent run is active")))
      .catch((e: Error) => toast.error(e.message))
  }, [api, taskId])

  const run = [...events].reverse().find((e): e is RunEvent => e.type === "run") ?? null
  const result = [...events].reverse().find((e): e is ResultEvent => e.type === "result") ?? null
  // the run is over as soon as its result arrives (the stream closes a moment later)
  const ended = events.length > 0 && events[events.length - 1].type === "result"
  return { events, running: !ended && (streaming || liveRunning), source, run, result, start, cancel }
}

const exitLabel = (x: AgentExitStatus) => (typeof x === "number" ? `exit ${x}` : String(x))
const exitTone = (x: AgentExitStatus) => (x === 0 ? "text-ok" : x === "cancelled" ? "text-warn" : "text-err")

/**
 * Advisory warning (REQ-0051#AC7): other in-progress tasks of the story have unmerged agent branches. The user can
 * add the checked ones to depends_on (PATCH with the loaded version; nothing starts) or start anyway.
 */
// reqforge: implements REQ-0051
function ParallelWarning({
  plan,
  checked,
  onToggle,
}: {
  plan: AgentPlan
  checked: Set<string>
  onToggle: (id: string, on: boolean) => void
}) {
  const par = plan.parallel ?? []
  const n = par.length
  return (
    <Alert data-testid="agent-parallel" className="border-warn/50 bg-warn/5">
      <AlertTriangle className="text-warn" />
      <AlertTitle data-testid="agent-parallel-text" className="text-warn">
        {n} other task{n === 1 ? "" : "s"} of this story {n === 1 ? "has an" : "have"} unmerged agent branch{n === 1 ? "" : "es"}; their
        changes may conflict with this run.
      </AlertTitle>
      <AlertDescription>
        <p>Make {plan.task} wait for them (depends_on), or start anyway. This is a warning only.</p>
        <ul className="mt-1 w-full space-y-1">
          {par.map((t) => (
            <li key={t.id} data-testid="agent-parallel-task" data-id={t.id} className="flex items-center gap-2 text-foreground">
              <Checkbox
                id={`par-${t.id}`}
                data-testid="agent-parallel-check"
                aria-label={`add ${t.id} to depends_on`}
                checked={checked.has(t.id)}
                onCheckedChange={(c) => onToggle(t.id, c === true)}
              />
              <label htmlFor={`par-${t.id}`} className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-baseline gap-x-2">
                <span className="id-mono font-medium">{t.id}</span>
                <span className="min-w-0">{t.title}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  {t.branch} · {t.ahead} commit{t.ahead === 1 ? "" : "s"} ahead
                </span>
              </label>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** Confirmation before anything runs: component path, branch, worktree and the full brief. */
// reqforge: implements REQ-0051
export function AgentConfirmDialog({
  open,
  onOpenChange,
  plan,
  onConfirm,
  onAddDepends,
}: {
  open: boolean
  onOpenChange: (b: boolean) => void
  plan: AgentPlan
  onConfirm: () => void
  /** add these task ids to the task's depends_on (does not start); resolves when saved */
  onAddDepends?: (ids: string[]) => Promise<boolean>
}) {
  const parallel = plan.parallel ?? []
  // every listed task starts checked; the dialog remembers only what the user unchecked, until it closes
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const checked = new Set(parallel.map((t) => t.id).filter((id) => !unchecked.has(id)))
  const toggle = (id: string, on: boolean) =>
    setUnchecked((cur) => {
      const next = new Set(cur)
      if (on) next.delete(id)
      else next.add(id)
      return next
    })
  const setOpen = (b: boolean) => {
    if (!b) setUnchecked(new Set())
    onOpenChange(b)
  }
  const row = (label: string, value: string | undefined, testId: string) => (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <code data-testid={testId} className="font-mono text-[12px] break-all">
        {value || "—"}
      </code>
    </div>
  )
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="agent-dialog" className="flex max-h-[90vh] flex-col sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Start {plan.task} with a coding agent?</DialogTitle>
          <DialogDescription>
            Claude Code will work in its own git worktree on a new branch, briefed with the text below. It can edit files only
            inside the worktree, never pushes, and the task is never marked done automatically. Nothing runs until you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-[12.5px]">
          {row("component", `${plan.component}${plan.component_path ? ` · ${plan.component_path}` : ""}`, "agent-dialog-path")}
          {row("branch", plan.branch, "agent-dialog-branch")}
          {row("worktree", plan.worktree, "agent-dialog-worktree")}
        </div>
        {parallel.length > 0 && <ParallelWarning plan={plan} checked={checked} onToggle={toggle} />}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1 text-[12px] font-medium text-muted-foreground">Brief (sent to the agent as its prompt)</div>
          <pre
            data-testid="agent-brief"
            tabIndex={0}
            aria-label="agent brief"
            className="min-h-[160px] flex-1 overflow-auto rounded-md border bg-background p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap"
          >
            {plan.brief}
          </pre>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" data-testid="agent-dialog-cancel" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {parallel.length > 0 && onAddDepends && (
            <Button
              variant="outline"
              size="sm"
              data-testid="agent-add-depends"
              disabled={!checked.size || saving}
              onClick={async () => {
                setSaving(true)
                const done = await onAddDepends(parallel.map((t) => t.id).filter((id) => checked.has(id)))
                setSaving(false)
                if (done) setOpen(false)
              }}
            >
              {saving ? <Loader2 className="animate-spin" /> : <ListPlus />} Add to depends_on
            </Button>
          )}
          <Button
            size="sm"
            data-testid="agent-confirm"
            variant={parallel.length ? "secondary" : "default"}
            disabled={saving}
            onClick={() => {
              setOpen(false)
              onConfirm()
            }}
          >
            <Bot /> {parallel.length ? "Start anyway" : "Confirm and start agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EventLine({ ev }: { ev: AgentEvent }) {
  if (ev.type === "tool")
    return (
      <div data-testid="agent-event" data-type="tool" className={cn("flex gap-1.5", ev.sub && "pl-4 opacity-80")}>
        <Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-semibold">{ev.name}</span>
        {ev.text && ev.text !== ev.name && <span className="min-w-0 break-all text-muted-foreground">{ev.text}</span>}
      </div>
    )
  if (ev.type === "text")
    return (
      <div data-testid="agent-event" data-type="text" className="font-sans text-[12.5px] whitespace-pre-wrap">
        {ev.text}
      </div>
    )
  if (ev.type === "warning")
    return (
      <div data-testid="agent-event" data-type="warning" className="text-warn">
        warning: {ev.text}
      </div>
    )
  if (ev.type === "error")
    return (
      <div data-testid="agent-event" data-type="error" className="whitespace-pre-wrap text-err">
        error: {ev.text}
      </div>
    )
  if (ev.type === "run")
    return (
      <div data-testid="agent-event" data-type="run" className="text-muted-foreground">
        run {ev.run_id} started on {ev.branch} (base {shortSha(ev.base)}){ev.task_started ? " · task moved to in-progress" : ""}
      </div>
    )
  if (ev.type === "done")
    return (
      <div data-testid="agent-event" data-type="done" className="text-muted-foreground">
        agent finished{ev.turns != null ? ` after ${ev.turns} turn(s)` : ""}
        {ev.is_error ? " with an error" : ""}
      </div>
    )
  return null
}

function RunResult({ r }: { r: ResultEvent }) {
  return (
    <div data-testid="agent-result" data-exit={String(r.exit_status)} className="mt-2 rounded-md border bg-card px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <b className={cn("font-semibold", exitTone(r.exit_status))} data-testid="agent-exit">
          {exitLabel(r.exit_status)}
        </b>
        <span className="inline-flex items-center gap-1">
          <GitBranch className="size-3.5 text-muted-foreground" />
          <code data-testid="agent-branch" className="font-mono">
            {r.branch}
          </code>
        </span>
        <span className="text-muted-foreground">
          {r.commits.length} commit{r.commits.length === 1 ? "" : "s"}
        </span>
      </div>
      {r.commits.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {r.commits.map((c) => (
            <li key={c.sha} data-testid="agent-commit" data-sha={c.sha} className="flex gap-1.5">
              <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <code className="font-mono text-primary">{c.sha}</code>
              <span className="min-w-0">{c.message}</span>
            </li>
          ))}
        </ul>
      )}
      {r.violations.length > 0 && (
        <Alert variant="destructive" data-testid="agent-violations" className="mt-2">
          <AlertTriangle />
          <AlertTitle>Sandbox violations — review before using this branch</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {r.violations.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <p data-testid="agent-not-done" className="mt-2 text-muted-foreground">
        The task is not marked done automatically{r.task_status ? ` (status: ${r.task_status})` : ""}. Review the branch, then
        use <b>Complete</b> to land it and mark the task done.
      </p>
    </div>
  )
}

/** Progress of the task's current or last agent run, with Cancel. */
// reqforge: implements REQ-0051
export function AgentRunView({ taskId, agent }: { taskId: string; agent: AgentRunState }) {
  const logRef = useRef<HTMLDivElement>(null)
  const n = agent.events.length
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [n])

  if (!n && !agent.running)
    return (
      <p data-testid="agent-run-empty" className="text-[12.5px] text-muted-foreground">
        No agent run of {taskId} in this server session. Use <b>Start with agent</b> above; runs started by the agent queue show
        up here too.
      </p>
    )
  const shown = agent.events.filter((e) => e.type !== "session" && e.type !== "result")
  return (
    <div data-testid="agent-run" data-running={agent.running ? "true" : "false"} data-source={agent.source ?? ""}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px]">
        {agent.running ? (
          <span data-testid="agent-running" className="inline-flex items-center gap-1 font-medium text-info">
            <Loader2 className="size-3.5 animate-spin" /> Agent running
            {agent.source === "live" ? " (started elsewhere)" : ""}
          </span>
        ) : (
          <span className="font-medium">{agent.result ? "Last run" : "Run ended"}</span>
        )}
        {agent.run && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" title={agent.run.worktree}>
            {agent.run.worktree}
          </span>
        )}
        {agent.running && (
          <Button size="xs" variant="destructive" className="ml-auto" data-testid="agent-cancel" onClick={agent.cancel}>
            <Square /> Cancel run
          </Button>
        )}
      </div>
      <div
        ref={logRef}
        data-testid="agent-log"
        role="log"
        aria-live="polite"
        aria-label={`agent progress for ${taskId}`}
        className="max-h-[300px] min-h-[60px] space-y-1 overflow-y-auto rounded-md border bg-muted/30 px-2.5 py-2 font-mono text-[11.5px]"
      >
        {shown.map((ev, i) => (
          <EventLine key={i} ev={ev} />
        ))}
        {agent.running && !shown.length && <div className="text-muted-foreground">preparing the worktree…</div>}
      </div>
      {agent.result && <RunResult r={agent.result} />}
    </div>
  )
}

const outcomeTone = (o: string) => (o === "completed" ? "text-ok" : o.startsWith("refused") ? "text-warn" : "text-err")

function CompleteRunCells({ r }: { r: CompleteRunLog }) {
  const failed = (r.evals ?? []).filter((e) => e.status === "failed").map((e) => e.id)
  const detail = [
    ...(r.reasons ?? []),
    ...(r.conflicts?.length ? [`conflicts: ${r.conflicts.join(", ")}`] : []),
    ...(failed.length ? [`failed evals: ${failed.join(", ")}`] : []),
    ...(r.violations ?? []),
  ].join("\n")
  return (
    <>
      <td className="px-2 py-1" title={detail || undefined}>
        <span data-testid="run-outcome" className={cn("font-medium whitespace-nowrap", outcomeTone(r.outcome))}>
          {r.outcome}
        </span>
      </td>
      <td className="px-2 py-1 font-mono text-[11.5px]" title={r.merge_commit ? `merge commit ${r.merge_commit}` : undefined}>
        {r.merge_commit ? shortSha(r.merge_commit) : "—"}
      </td>
    </>
  )
}

/** Past agent runs and Complete attempts of the task (logs in agent-runs/, newest first). */
// reqforge: implements REQ-0056
export function RunsList({ taskId }: { taskId: string }) {
  const q = useRuns(taskId)
  return (
    <div data-testid="runs-list">
      <H3>Runs</H3>
      {q.error ? (
        <ErrorText>{(q.error as Error).message}</ErrorText>
      ) : !q.data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !q.data.length ? (
        <p data-testid="runs-empty" className="text-[12.5px] text-muted-foreground">
          No agent runs or Complete attempts yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b text-left text-[12px] text-muted-foreground">
                <th className="px-2 py-1 font-semibold">started</th>
                <th className="px-2 py-1 font-semibold">kind</th>
                <th className="px-2 py-1 font-semibold">by</th>
                <th className="px-2 py-1 font-semibold">result</th>
                <th className="px-2 py-1 font-semibold" title="agent runs: commits; Complete: merge commit">commits</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r: RunLog) => (
                <tr
                  key={r.run_id}
                  data-testid="run-row"
                  data-run={r.run_id}
                  data-kind={r.kind ?? "agent"}
                  data-exit={r.kind === "complete" ? undefined : String(r.exit_status)}
                  data-outcome={r.kind === "complete" ? r.outcome : undefined}
                  title={r.kind === "complete" ? `${r.run_id}: ${r.branch} → ${r.target}` : `${r.run_id} on ${r.branch}`}
                  className="border-b align-top last:border-b-0"
                >
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums" title={`${r.started} → ${r.ended ?? ""}`}>
                    {shortTime(r.started)}
                  </td>
                  <td className="px-2 py-1">
                    <Chip className={r.kind === "complete" ? "text-primary" : undefined}>{r.kind === "complete" ? "complete" : "agent"}</Chip>
                  </td>
                  <td className="px-2 py-1">{r.user}</td>
                  {r.kind === "complete" ? (
                    <CompleteRunCells r={r} />
                  ) : (
                    <>
                      <td className="px-2 py-1">
                        <span className={cn("font-medium", exitTone(r.exit_status))}>{exitLabel(r.exit_status)}</span>
                        {r.violations.length > 0 && (
                          <Chip className="ml-1 bg-err/10 text-err" title={r.violations.join("\n")}>
                            {r.violations.length} violation{r.violations.length === 1 ? "" : "s"}
                          </Chip>
                        )}
                      </td>
                      <td className="px-2 py-1" title={r.commits.map((c) => `${c.sha} ${c.message}`).join("\n")}>
                        {r.commits.length}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
