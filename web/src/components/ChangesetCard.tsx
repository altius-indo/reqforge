import { useState, type ReactNode } from "react"
import { Check, ChevronRight, X } from "lucide-react"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import { useApi } from "@/state/project"
import type { Changeset, ImpactEval, ImpactStory, ImpactTask, ResolvedOp, SnapshotDiffLine } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ErrorText, H3, IdLink } from "@/components/common"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useChangeset } from "@/state/queries"
import { asText, short, statusTone } from "@/lib/format"
import { cn } from "@/lib/utils"

const OP_STYLE: Record<string, string> = {
  create: "bg-ok/15 text-ok",
  update: "bg-primary/12 text-primary",
  delete: "bg-err/12 text-err",
  snapshot: "bg-warn/15 text-warn",
}

const DIFF_STYLE: Record<SnapshotDiffLine["t"], string> = {
  "+": "bg-ok/12 text-ok",
  "-": "bg-err/10 text-err",
  " ": "text-muted-foreground",
}

/** Line diff of the project snapshot (state/HOT.md), old -> new. */
// reqforge: implements REQ-0057
function SnapshotDiff({ o }: { o: ResolvedOp }) {
  const diff = o.diff || []
  const added = diff.filter((d) => d.t === "+").length
  const removed = diff.filter((d) => d.t === "-").length
  return (
    <div className="mt-0.5">
      <div data-testid="cs-snapshot-meta" className="text-[12px] text-muted-foreground">
        project snapshot{o.base_version === "absent" ? " (new file)" : ""} · <span className="text-ok">+{added}</span>{" "}
        <span className="text-err">−{removed}</span> lines · {o.bytes ?? 0} bytes
        {o.last_reconciled ? ` · last reconciled ${o.last_reconciled}` : ""}
      </div>
      <pre
        data-testid="cs-snapshot-diff"
        className="mt-1 max-h-[320px] overflow-auto rounded border bg-muted/40 py-1 font-mono text-[11.5px] leading-[17px]"
      >
        {diff.map((d, i) => (
          <div key={i} data-testid="cs-diff-line" data-t={d.t} className={cn("px-2 whitespace-pre-wrap", DIFF_STYLE[d.t])}>
            <span className="inline-block w-3 select-none">{d.t === "-" ? "−" : d.t}</span>
            {d.line}
          </div>
        ))}
      </pre>
    </div>
  )
}

function Verdict({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", ok ? "text-ok" : "text-err")}>
      {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {ok ? yes : no}
    </span>
  )
}

function DiffLine({ field, pair }: { field: string; pair: [unknown, unknown] }) {
  const [a, b] = pair
  if (Array.isArray(a) || Array.isArray(b)) {
    const A = ((a as unknown[]) || []).map(asText)
    const B = ((b as unknown[]) || []).map(asText)
    const add = B.filter((x) => !A.includes(x))
    const rem = A.filter((x) => !B.includes(x))
    return (
      <div className="mt-0.5 text-[12px] [overflow-wrap:anywhere] text-muted-foreground">
        <b className="font-semibold text-foreground/80">{field}: </b>
        {add.map((x) => (
          <span key={`+${x}`} className="mr-1 text-ok">
            +{x}
          </span>
        ))}
        {rem.map((x) => (
          <del key={`-${x}`} className="mr-1 text-err">
            −{x}
          </del>
        ))}
        {!add.length && !rem.length && "(contents edited)"}
      </div>
    )
  }
  return (
    <div className="mt-0.5 text-[12px] [overflow-wrap:anywhere] text-muted-foreground">
      <b className="font-semibold text-foreground/80">{field}: </b>
      <del className="text-err">{short(a)}</del> → <span className="text-ok">{short(b)}</span>
    </div>
  )
}

function Op({ o, cs, included, onToggle }: { o: ResolvedOp; cs: Changeset; included: boolean; onToggle: (b: boolean) => void }) {
  return (
    <div data-testid="cs-op" data-op={o.op} className="flex items-start gap-2 border-t py-1.5 text-[12.5px]">
      {cs.status === "pending" && (
        <Checkbox
          className="mt-0.5"
          aria-label="include op"
          title="include this operation"
          data-testid="op-include"
          checked={included}
          onCheckedChange={(c) => onToggle(c === true)}
        />
      )}
      <span className={cn("rounded px-1.5 text-[11px] leading-[18px] font-semibold", OP_STYLE[o.op])}>{o.op}</span>
      <div className="min-w-0 flex-1">
        {o.op !== "snapshot" && (cs.status === "applied" || o.op !== "create") ? (
          <IdLink id={o.id} />
        ) : (
          <span className="id-mono">{o.id}</span>
        )}
        {o.ref && <span className="text-muted-foreground"> (${o.ref})</span>} <span>{o.title || ""}</span>
        {o.reason && <div className="text-[12px] text-muted-foreground">{o.reason}</div>}
        {o.op === "create" && typeof o.data?.statement === "string" && (
          <div className="mt-0.5 text-[12px] text-muted-foreground">{o.data.statement}</div>
        )}
        {o.op === "snapshot" && <SnapshotDiff o={o} />}
        {Object.entries(o.changes || {}).map(([f, d]) => (
          <DiffLine key={f} field={f} pair={d} />
        ))}
      </div>
    </div>
  )
}

function Fold({ summary, children, className, testId }: { summary: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <Collapsible data-testid={testId} className="mt-1.5">
      <CollapsibleTrigger className={cn("group inline-flex items-center gap-1 text-[12.5px] hover:underline", className)}>
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pl-4 text-[12.5px]">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// reqforge: implements REQ-0032
export function ChangesetCard({ id }: { id: string }) {
  const q = useChangeset(id)
  const api = useApi()
  const { refreshAll } = useApp()
  const chat = useChat()
  const [excl, setExcl] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <div className="text-[12.5px] text-muted-foreground">loading {id}…</div>
  const cs = q.data
  const a = cs.analysis || ({} as Changeset["analysis"])
  const L = a.lint || ({} as Changeset["analysis"]["lint"])
  const T = a.trace || ({} as Changeset["analysis"]["trace"])
  const im = a.impact || ({} as Changeset["analysis"]["impact"])
  const notes = cs.impact_notes || {}
  const ops = a.ops || []
  const newLint = L.new || []
  const delta = T.delta || []

  const imp: [string, (ImpactStory | ImpactTask | ImpactEval)[], (x: ImpactStory | ImpactTask | ImpactEval) => ReactNode][] = (
    [
      ["stories", im.stories, (x) => <IdLink id={x.id} />],
      ["tasks", im.tasks, (x) => <IdLink id={x.id} />],
      [
        "evals",
        im.evals,
        (x) => (
          <>
            <IdLink id={(x as ImpactEval).story} />
            <span className="id-mono">/{x.id}</span>
          </>
        ),
      ],
    ] as [string, (ImpactStory | ImpactTask | ImpactEval)[] | undefined, (x: ImpactStory | ImpactTask | ImpactEval) => ReactNode][]
  ).filter((e): e is [string, (ImpactStory | ImpactTask | ImpactEval)[], (x: ImpactStory | ImpactTask | ImpactEval) => ReactNode] => !!e[1]?.length)

  const apply = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.apply(cs.id, [...excl])
      toast.success(`${cs.id} applied`)
      refreshAll()
      if (chat.sessionId) {
        chat.markApplied()
        const result = {
          assigned_ids: res.assigned_ids,
          lint: res.lint,
          trace_ok: res.trace_ok,
          failing_checks: res.failing_checks.map((c) => ({ check: c.check, count: c.failures.length, sample: c.failures.slice(0, 5) })),
        }
        void chat.send(
          `I applied ${cs.id}${excl.size ? ` (excluding ops ${[...excl].join(", ")})` : ""}. Result: ${JSON.stringify(result)}. Verify traceability on the new state and propose any follow-up remapping.`,
          { noCtx: true },
        )
      }
    } catch (e) {
      toast.error((e as Error).message)
      const details = e instanceof ApiError ? e.details.map(String) : []
      setErr([(e as Error).message, ...details].join("\n"))
      refreshAll()
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    setBusy(true)
    try {
      await api.reject(cs.id, "rejected in UI")
      toast.success(`${cs.id} rejected`)
      refreshAll()
      if (chat.sessionId) void chat.send(`I rejected ${cs.id}.`, { noCtx: true })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="changeset-card"
      data-id={cs.id}
      data-status={cs.status}
      className="rounded-xl border border-primary/50 bg-card px-3 py-2.5 text-[13px] shadow-xs"
    >
      <div className="flex items-center gap-2">
        <span className="id-mono text-muted-foreground">{cs.id}</span>
        <span className="min-w-0 flex-1 font-semibold">{cs.title}</span>
        <span
          data-testid="cs-status"
          className={cn("rounded-full bg-muted px-2 text-[11.5px] leading-5 font-medium", statusTone(cs.status))}
        >
          {cs.status}
        </span>
      </div>
      {cs.summary && <p className="my-1.5">{cs.summary}</p>}
      <div data-testid="cs-verdicts" className="my-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <Verdict ok={!!a.valid} yes="valid" no="invalid" />
        <Verdict ok={!!L.mece_ok} yes="MECE holds" no={`MECE: ${newLint.length} new findings`} />
        <span className={T.ok_after ? "text-ok" : "text-warn"}>
          trace {T.ok_before ? "pass" : "fail"} → {T.ok_after ? "pass" : "fail"}
        </span>
        <span className="text-muted-foreground">
          gaps {L.gaps_before} → {L.gaps_after}
        </span>
        <span className="text-muted-foreground">
          lint errors {L.before?.error} → {L.after?.error}
        </span>
      </div>
      {!!a.errors?.length && (
        <ErrorText>
          {a.errors.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </ErrorText>
      )}
      <H3 className="mt-2">{ops.length} operations</H3>
      {ops.map((o) => (
        <Op
          key={o.i}
          o={o}
          cs={cs}
          included={!excl.has(o.i)}
          onToggle={(on) =>
            setExcl((s) => {
              const n = new Set(s)
              if (on) n.delete(o.i)
              else n.add(o.i)
              return n
            })
          }
        />
      ))}
      {!!newLint.length && (
        <Fold summary={`${newLint.length} new lint findings`} className="text-warn">
          <ul className="list-disc space-y-0.5 pl-4">
            {newLint.slice(0, 50).map((f, i) => (
              <li key={i}>
                {f.rule}:{" "}
                {f.ids.map((x) => (
                  <span key={x} className="mr-1">
                    <IdLink id={x} />
                  </span>
                ))}
                — {f.message}
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {!!L.resolved?.length && <div className="mt-1 text-[12px] text-ok">resolves {L.resolved.length} existing lint findings</div>}
      {!!delta.length && (
        <Fold summary="Traceability changes">
          <ul className="list-disc space-y-0.5 pl-4">
            {delta.map((d) => (
              <li key={d.check}>
                {d.name}:{" "}
                {!!d.new_failures.length && <span className="text-err">+{d.new_failures.length} failing </span>}
                {!!d.fixed.length && <span className="text-ok">{d.fixed.length} fixed</span>}
                {!!d.new_failures.length && (
                  <div className="text-[12px] text-muted-foreground">{d.new_failures.slice(0, 5).join("; ")}</div>
                )}
              </li>
            ))}
          </ul>
        </Fold>
      )}
      <H3 className="mt-2.5">Impact</H3>
      <div data-testid="cs-impact" className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        {imp.map(([k, v]) => (
          <span key={k}>
            {v.length} {k}
          </span>
        ))}
        {!!im.components?.length && <span>components: {im.components.join(", ")}</span>}
        {!!im.in_progress_work?.length && (
          <span className="text-warn">touches in-progress/done work: {im.in_progress_work.slice(0, 10).join(", ")}</span>
        )}
        {!imp.length && !im.components?.length && <span className="text-muted-foreground">no linked stories, tasks or evals</span>}
      </div>
      {!!imp.length && (
        <Fold summary="affected records">
          {imp.map(([k, v, fn]) => (
            <div key={k} className="my-1 text-[12px]">
              <b className="font-semibold">{k}: </b>
              {v.slice(0, 40).map((x, i) => (
                <span key={i} className="mr-1.5">
                  {fn(x)}
                </span>
              ))}
            </div>
          ))}
        </Fold>
      )}
      {(["stories", "code", "evals"] as const)
        .filter((k) => notes[k])
        .map((k) => (
          <div key={k} className="my-1 text-[12.5px]">
            <b className="font-semibold">{k}: </b>
            {notes[k]}
          </div>
        ))}
      {!!notes.risks?.length && (
        <div className="text-[12.5px]">
          <b className="font-semibold">risks: </b>
          <ul className="list-disc pl-5">
            {notes.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {err && (
        <div className="mt-2">
          <ErrorText testId="cs-error">{err}</ErrorText>
        </div>
      )}
      {cs.status === "pending" ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            className="h-7"
            data-testid="cs-apply"
            disabled={!a.valid || busy}
            title={a.valid ? "" : "fix the errors first (ask Claude to revise)"}
            onClick={apply}
          >
            Apply
          </Button>
          <Button size="sm" variant="outline" className="h-7" data-testid="cs-revise" onClick={() => chat.ask(`Revise ${cs.id}: `)}>
            Ask to revise
          </Button>
          <Button size="sm" variant="destructive" className="h-7" data-testid="cs-reject" disabled={busy} onClick={reject}>
            Reject
          </Button>
        </div>
      ) : cs.status === "stale" ? (
        <p className="mt-2 text-[12.5px] text-warn">
          Stale: records changed after this was proposed. {(cs.stale_reasons || []).join("; ")}
        </p>
      ) : null}
    </div>
  )
}
