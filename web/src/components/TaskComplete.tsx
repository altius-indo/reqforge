/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleCheckBig,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { ApiError, type ProjectApi } from "@/api/client"
import type { BranchReview, CompleteRefusal, CompleteResult, FailedEval, RecordBase } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Chip, IdLink } from "@/components/common"
import { shortSha, shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------------ attempt state (survives closing the drawer)
/**
 * One Complete attempt of a task. It lives outside the drawer: Complete can take minutes (the story's evals run),
 * and closing or switching the drawer must neither lose its progress nor its outcome.
 */
export interface CompleteAttempt {
  running: boolean
  startedAt: number
  endedAt?: number
  result?: CompleteResult
  refusal?: CompleteRefusal
  /** any other failure (stale version, 500 after landing, network) */
  error?: { message: string; status: number; mergeCommit?: string }
}

const attempts = new Map<string, CompleteAttempt>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const attemptKey = (project: string, task: string) => `${project}/${task}`

export function useCompleteAttempt(project: string, task: string | null): CompleteAttempt | undefined {
  return useSyncExternalStore(subscribe, () => (task ? attempts.get(attemptKey(project, task)) : undefined))
}

export function dismissAttempt(project: string, task: string) {
  attempts.delete(attemptKey(project, task))
  emit()
}

/**
 * POST tasks/{id}/complete. The server does everything (merge, evals, land, status cascade, cleanup); the UI
 * never marks anything done itself, it only refreshes what the server changed.
 */
export async function runComplete(api: ProjectApi, task: string, version: number, refreshAll: () => void) {
  const k = attemptKey(api.key, task)
  if (attempts.get(k)?.running) return
  attempts.set(k, { running: true, startedAt: Date.now() })
  emit()
  let next: CompleteAttempt
  const startedAt = attempts.get(k)!.startedAt
  try {
    const r = await api.complete(task, version)
    next = { running: false, startedAt, endedAt: Date.now(), result: r }
    toast.success(`${task} completed · merged as ${shortSha(r.merge_commit)}`, {
      description: `Done: ${r.changed.join(", ")}${r.cleanup_warnings.length ? ` · ${r.cleanup_warnings.length} cleanup warning(s)` : ""}`,
    })
  } catch (e) {
    const d = e instanceof ApiError ? (e.details[0] as Record<string, unknown> | undefined) : undefined
    if (e instanceof ApiError && e.status === 409 && d && typeof d.step === "string") {
      next = { running: false, startedAt, endedAt: Date.now(), refusal: d as unknown as CompleteRefusal }
      toast.error(`Complete of ${task} refused at ${d.step}`, { description: String(d.reason ?? "") })
    } else {
      const status = e instanceof ApiError ? e.status : 0
      const mergeCommit = d && typeof d.merge_commit === "string" ? d.merge_commit : undefined
      const stale = status === 409 && !d
      const message = stale
        ? `${(e as Error).message} — ${task} changed since the drawer loaded it; it has been reloaded, try again.`
        : (e as Error).message
      next = { running: false, startedAt, endedAt: Date.now(), error: { message, status, mergeCommit } }
      toast.error(`Complete of ${task} failed`, { description: message })
    }
  }
  attempts.set(k, next)
  emit()
  refreshAll()
}

// ------------------------------------------------------------------ small pieces
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** mm:ss since `from`, ticking every second */
export function Elapsed({ from, testId }: { from: number; testId?: string }) {
  const now = useNow(true)
  return (
    <span data-testid={testId} className="tabular-nums">
      {fmtElapsed(now - from)}
    </span>
  )
}

const STATUS_TONE: Record<string, string> = {
  A: "bg-ok/12 text-ok",
  M: "bg-info/12 text-info",
  D: "bg-err/12 text-err",
  R: "bg-warn/15 text-warn",
  C: "bg-warn/15 text-warn",
}
const STATUS_LABEL: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" }

function FileStatus({ status }: { status: string }) {
  const s = status.charAt(0)
  return (
    <span
      title={STATUS_LABEL[s] ?? status}
      className={cn("inline-flex w-5 shrink-0 justify-center rounded-sm font-mono text-[11px] font-semibold", STATUS_TONE[s] ?? "bg-muted")}
    >
      {s}
    </span>
  )
}

// ------------------------------------------------------------------ diff
interface FileDiffPart {
  path: string
  lines: string[]
  add: number
  del: number
}

/** split `git diff` output into one part per file */
export function splitDiff(diff: string): FileDiffPart[] {
  const out: FileDiffPart[] = []
  let cur: FileDiffPart | null = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      cur = { path: m ? m[2] : line.slice(11), lines: [line], add: 0, del: 0 }
      out.push(cur)
      continue
    }
    if (!cur) continue
    cur.lines.push(line)
    if (line.startsWith("+") && !line.startsWith("+++")) cur.add++
    else if (line.startsWith("-") && !line.startsWith("---")) cur.del++
  }
  // a cut diff (truncated) or a trailing newline leaves an empty last line
  for (const p of out) while (p.lines.length > 1 && p.lines[p.lines.length - 1] === "") p.lines.pop()
  return out
}

/** git's per-file header lines; the file's row already names it (mode/rename/binary notes stay visible) */
const HEADER_RE = /^(diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ )/

/** drop the header lines (only before the first hunk: a removed "-- comment" line looks like a header) */
const visibleLines = (lines: string[]) => {
  const h = lines.findIndex((l) => l.startsWith("@@"))
  const head = h < 0 ? lines : lines.slice(0, h)
  return [...head.filter((l) => !HEADER_RE.test(l)), ...(h < 0 ? [] : lines.slice(h))]
}

const lineClass = (l: string) =>
  /^(new file|deleted file|old mode|new mode|similarity|rename |copy |Binary files)/.test(l)
    ? "text-muted-foreground italic"
    : l.startsWith("@@")
      ? "bg-info/10 text-info"
      : l.startsWith("+")
        ? "bg-ok/12"
        : l.startsWith("-")
          ? "bg-err/12"
          : ""

function DiffFile({ part, defaultOpen }: { part: FileDiffPart; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="branch-diff-file" data-path={part.path} data-open={open ? "true" : "false"}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          id={`diff-${part.path}`}
          className="flex w-full cursor-pointer items-center gap-1.5 border-b bg-muted/50 px-2 py-1 text-left font-mono text-[11.5px] hover:bg-muted"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 truncate" title={part.path}>
            {part.path}
          </span>
          <span className="shrink-0 tabular-nums text-ok">+{part.add}</span>
          <span className="shrink-0 tabular-nums text-err">−{part.del}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="overflow-x-auto border-b bg-background py-1 font-mono text-[11.5px] leading-[1.45]">
          {visibleLines(part.lines).map((l, i) => (
            <div key={i} className={cn("min-w-max px-2 whitespace-pre", lineClass(l))}>
              {l || " "}
            </div>
          ))}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ------------------------------------------------------------------ review section (REQ-0056#AC1)
/** The agent branch of a task: target, ahead/behind, commits, changed files and the diff against the merge base. */
// reqforge: implements REQ-0056
export function BranchReviewPanel({ review }: { review: BranchReview }) {
  const parts = useMemo(() => splitDiff(review.diff), [review.diff])
  const totalLines = parts.reduce((a, p) => a + p.lines.length, 0)
  // small diffs open, big ones start collapsed (each file opens on demand)
  const openAll = totalLines <= 600
  return (
    <section data-testid="branch-review" className="text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1">
          <GitBranch className="size-3.5 text-muted-foreground" />
          <code data-testid="branch-name" className="font-mono">
            {review.branch}
          </code>
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">target</span>
          <code data-testid="branch-target" className="rounded-sm bg-muted px-1 font-mono">
            {review.target}
          </code>
        </span>
        <span data-testid="branch-ahead-behind" className="text-muted-foreground tabular-nums">
          <b className="font-semibold text-foreground">{review.ahead}</b> ahead ·{" "}
          <b className={cn("font-semibold", review.behind ? "text-warn" : "text-foreground")}>{review.behind}</b> behind
        </span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={review.worktree}>
        base {shortSha(review.base)} · {review.worktree}
      </div>

      <h4 className="mt-3 mb-1 text-[12px] font-semibold text-muted-foreground">
        Commits <span className="font-normal">({review.commits.length})</span>
      </h4>
      {review.commits.length ? (
        <ul className="space-y-0.5">
          {review.commits.map((c) => (
            <li key={c.sha} data-testid="branch-commit" data-sha={c.sha} className="flex items-baseline gap-1.5">
              <GitCommitHorizontal className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
              <code className="shrink-0 font-mono text-primary">{c.sha}</code>
              <span className="min-w-0 flex-1">{c.message}</span>
              <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground" title={c.at}>
                {c.author} · {shortTime(c.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No commits ahead of the merge base.</p>
      )}

      <h4 className="mt-3 mb-1 text-[12px] font-semibold text-muted-foreground">
        Changed files <span className="font-normal">({review.files.length})</span>
      </h4>
      {review.files.length ? (
        <ul className="space-y-0.5">
          {review.files.map((f) => (
            <li key={f.path} data-testid="branch-file" data-status={f.status} data-path={f.path} className="flex items-center gap-1.5">
              <FileStatus status={f.status} />
              <span className="min-w-0 font-mono text-[11.5px] break-all">{f.path.replace("\t", " → ")}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No changed files.</p>
      )}

      <h4 className="mt-3 mb-1 flex items-center gap-1 text-[12px] font-semibold text-muted-foreground">
        <FileDiff className="size-3.5" /> Diff against the merge base
      </h4>
      {review.truncated && (
        <p data-testid="branch-truncated" className="mb-1 text-[12px] text-warn">
          The diff is larger than 512 KiB and is cut off; run <code className="font-mono">git diff {shortSha(review.base)}...{review.branch}</code>{" "}
          in the checkout for the rest.
        </p>
      )}
      {parts.length ? (
        <div data-testid="branch-diff" className="overflow-hidden rounded-md border">
          {parts.map((p, i) => (
            <DiffFile key={`${p.path}-${i}`} part={p} defaultOpen={openAll} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">Empty diff.</p>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ Complete: button + confirmation (REQ-0056#AC5)
/** Complete button for the task drawer, with its confirmation naming the target branch. */
// reqforge: implements REQ-0056
export function CompleteButton({
  rec,
  review,
  attempt,
  onStart,
}: {
  rec: RecordBase
  review: BranchReview
  attempt: CompleteAttempt | undefined
  onStart: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const running = !!attempt?.running
  const ready = review.complete.ready && !running
  const reasons = review.complete.reasons
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button
        size="xs"
        data-testid="task-complete"
        data-ready={review.complete.ready ? "true" : "false"}
        disabled={!ready}
        title={running ? "Complete is running" : reasons.length ? `Unavailable: ${reasons.join("; ")}` : `Merge ${review.branch} into ${review.target} and mark ${rec.id} done`}
        onClick={() => setConfirm(true)}
      >
        {running ? <Loader2 className="animate-spin" /> : <GitMerge />}
        {running ? (
          <>
            Completing… <Elapsed from={attempt!.startedAt} />
          </>
        ) : (
          "Complete"
        )}
      </Button>
      <CompleteDialog open={confirm} onOpenChange={setConfirm} rec={rec} review={review} onConfirm={onStart} />
    </span>
  )
}

function CompleteDialog({
  open,
  onOpenChange,
  rec,
  review,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (b: boolean) => void
  rec: RecordBase
  review: BranchReview
  onConfirm: () => void
}) {
  const story = typeof rec.story === "string" ? rec.story : "the story"
  const code = (s: string) => <code className="rounded-sm bg-muted px-1 font-mono text-[12px]">{s}</code>
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="complete-dialog" className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            Complete {rec.id} into <span data-testid="complete-dialog-target" className="font-mono">{review.target}</span>?
          </DialogTitle>
          <DialogDescription>
            One action, run by the server. If any step before landing fails, nothing changes on {review.target} and the
            task stays in progress.
          </DialogDescription>
        </DialogHeader>
        <ol data-testid="complete-steps" className="list-decimal space-y-1.5 pl-5 text-[13px]">
          <li>
            Merge {code(review.target)} into {code(review.branch)} in the task worktree (stops on a conflict, leaving both
            branches unchanged).
          </li>
          <li>
            Run the evals of {story} on the merged tree. This can take minutes; every eval with a command must pass.
          </li>
          <li>
            Land the branch on {code(review.target)} with {code("git merge --no-ff")} ({review.ahead} commit
            {review.ahead === 1 ? "" : "s"}, {review.files.length} file{review.files.length === 1 ? "" : "s"}).
          </li>
          <li>Mark {rec.id} done, and its story and epic when all their work is done.</li>
          <li>Remove the worktree and delete {code(review.branch)}.</li>
        </ol>
        <DialogFooter>
          <Button variant="outline" size="sm" data-testid="complete-dialog-cancel" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="complete-confirm"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            <GitMerge /> Complete into {review.target}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------ outcome: progress, refusal, success
const STEP_TITLE: Record<string, string> = {
  preconditions: "Complete is not possible yet",
  merge: "Merging the target into the task branch conflicts",
  evals: "The story's evals failed on the merged tree",
  sandbox: "An eval broke the sandbox",
  "target-moved": "The target branch moved while the evals ran",
  land: "Landing on the target failed",
}

function TailBlock({ ev }: { ev: FailedEval }) {
  const lines = ev.output_tail.replace(/\n+$/, "").split("\n")
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(-40)
  // the failure is usually at the end: show the bottom of the tail first
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [all])
  return (
    <li data-testid="complete-failed-eval" data-eval={ev.id} className="rounded-md border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-2 border-b px-2 py-1">
        <b className="font-semibold text-err">{ev.id}</b>
        <span className="font-medium">{ev.name}</span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{ev.seconds.toFixed(1)} s</span>
        <code className="w-full font-mono text-[11px] break-all text-muted-foreground">$ {ev.command}</code>
      </div>
      <pre
        ref={pre}
        data-testid="complete-eval-tail"
        tabIndex={0}
        aria-label={`output of ${ev.id}`}
        className="max-h-[260px] overflow-auto px-2 py-1.5 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap"
      >
        {shown.join("\n") || "(no output)"}
      </pre>
      {lines.length > 40 && (
        <button
          type="button"
          data-testid="complete-eval-tail-toggle"
          className="w-full border-t px-2 py-1 text-left text-[11.5px] text-primary hover:bg-muted/60"
          onClick={() => setAll(!all)}
        >
          {all ? "Show the last 40 lines" : `Show all ${lines.length} lines of the tail`}
        </button>
      )}
    </li>
  )
}

function RefusalView({ r, onRetry }: { r: CompleteRefusal; onRetry: () => void }) {
  const title = STEP_TITLE[r.step] ?? `Refused at ${r.step}`
  if (r.step === "sandbox")
    return (
      <Alert variant="destructive" data-testid="complete-refusal" data-step={r.step}>
        <ShieldAlert />
        <AlertTitle>Sandbox violation in eval {r.eval}: Complete refused</AlertTitle>
        <AlertDescription>
          <p>The eval changed things outside the task worktree. Nothing was landed; inspect the branch before trying again.</p>
          <ul data-testid="complete-violations" className="mt-1 list-disc pl-4 font-medium">
            {r.violations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    )
  return (
    <div data-testid="complete-refusal" data-step={r.step} className="rounded-md border border-err/40 bg-err/5 px-3 py-2">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-err" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-err">{title}</div>
          <div className="text-[11px] text-muted-foreground">
            step <code className="font-mono">{r.step}</code> · the task is still in progress and the target is unchanged
          </div>
        </div>
        {r.step === "target-moved" && (
          <Button size="xs" variant="outline" data-testid="complete-retry" onClick={onRetry}>
            <RotateCw /> Retry
          </Button>
        )}
      </div>
      {r.step === "preconditions" && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          {(r.reasons?.length ? r.reasons : [r.reason]).map((x, i) => (
            <li key={i} data-testid="complete-refusal-reason">
              {x}
            </li>
          ))}
        </ul>
      )}
      {r.step === "merge" && (
        <>
          <p className="mt-1.5">Resolve these conflicts on the task branch (or ask the agent to), then Complete again:</p>
          <ul className="mt-1 space-y-0.5">
            {r.conflicts.map((f) => (
              <li key={f} data-testid="complete-conflict" className="font-mono text-[11.5px]">
                {f}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {r.task_head_restored ? "The merge was aborted; the task branch is back where it was." : "Warning: the task branch head could not be verified after aborting the merge."}
          </p>
        </>
      )}
      {r.step === "evals" && (
        <>
          <p className="mt-1.5">
            {r.failed.length} eval{r.failed.length === 1 ? "" : "s"} failed. The merge of the target stays on the task branch, so a
            fix builds on the integrated tree.
          </p>
          <ul className="mt-1.5 space-y-2">
            {r.failed.map((ev) => (
              <TailBlock key={ev.id} ev={ev} />
            ))}
          </ul>
        </>
      )}
      {r.step === "target-moved" && <p className="mt-1.5">{r.reason}. The evals did not test that tree; Retry runs them again.</p>}
      {r.step === "land" && <p className="mt-1.5 font-mono text-[11.5px] whitespace-pre-wrap">{r.reason}</p>}
    </div>
  )
}

/** Progress and outcome of the task's last Complete attempt. */
// reqforge: implements REQ-0056
export function CompleteOutcome({
  task,
  project,
  attempt,
  onRetry,
}: {
  task: string
  project: string
  attempt: CompleteAttempt
  onRetry: () => void
}) {
  const dismiss = () => dismissAttempt(project, task)
  if (attempt.running)
    return (
      <div data-testid="complete-progress" role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border border-info/40 bg-info/5 px-3 py-2 text-[12.5px]">
        <Loader2 className="size-4 animate-spin text-info" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            Completing {task}… <Elapsed from={attempt.startedAt} testId="complete-elapsed" />
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            Merging the target, running the story's evals and landing. This can take minutes; you can keep using the drawer or close it.
          </div>
        </div>
      </div>
    )
  const ms = attempt.endedAt ? attempt.endedAt - attempt.startedAt : 0
  const took = !ms ? "" : ms < 60_000 ? ` in ${(ms / 1000).toFixed(1)} s` : ` in ${fmtElapsed(ms)}`
  const close = (
    <Button size="icon-xs" variant="ghost" aria-label="dismiss" data-testid="complete-dismiss" onClick={dismiss}>
      <X />
    </Button>
  )
  if (attempt.result) {
    const r = attempt.result
    return (
      <div data-testid="complete-result" className="rounded-md border border-ok/40 bg-ok/5 px-3 py-2 text-[12.5px]">
        <div className="flex items-start gap-1.5">
          <CircleCheckBig className="mt-0.5 size-4 shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ok">
              {task} completed{took}
            </div>
            <div className="mt-0.5">
              merge commit <code data-testid="complete-merge-commit" className="font-mono text-primary">{shortSha(r.merge_commit)}</code>
            </div>
            <div data-testid="complete-changed" className="mt-0.5 flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">now done:</span>
              {r.changed.map((id) => (
                <IdLink key={id} id={id} />
              ))}
            </div>
            {r.evals.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r.evals.map((e) => (
                  <Chip key={e.id} className={e.status === "passed" ? "text-ok" : "text-muted-foreground"} title={e.command}>
                    {e.status === "passed" && <CheckCircle2 className="mr-0.5 inline size-3" />}
                    {e.id} {e.status}
                    {e.seconds != null ? ` · ${e.seconds.toFixed(1)} s` : ""}
                  </Chip>
                ))}
              </div>
            )}
            {r.cleanup_warnings.length > 0 && (
              <div data-testid="complete-cleanup" className="mt-1.5 text-warn">
                Cleanup did not finish; run it by hand:
                <ul className="list-disc pl-4 font-mono text-[11.5px]">
                  {r.cleanup_warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {close}
        </div>
      </div>
    )
  }
  if (attempt.refusal)
    return (
      <div className="relative">
        <RefusalView r={attempt.refusal} onRetry={onRetry} />
        <div className="absolute top-1 right-1">{attempt.refusal.step !== "target-moved" && close}</div>
      </div>
    )
  if (attempt.error)
    return (
      <div data-testid="complete-error" className="flex items-start gap-1.5 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12.5px]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-err" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap">
          <div className="font-semibold text-err">Complete failed{attempt.error.status ? ` (${attempt.error.status})` : ""}</div>
          {attempt.error.message}
          {attempt.error.mergeCommit && (
            <div className="mt-1">
              The code landed as <code className="font-mono">{shortSha(attempt.error.mergeCommit)}</code>; run Complete again to finish
              the status change.
            </div>
          )}
        </div>
        {close}
      </div>
    )
  return null
}
