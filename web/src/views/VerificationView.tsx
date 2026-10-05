import { useRef, useState, type ReactNode } from "react"
import { ChevronRight, FileUp, MessageSquare, Play, RefreshCw, ScanSearch } from "lucide-react"
import { toast } from "sonner"
import { VERIFICATION_STATUSES, type IngestResult } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Cards, ErrorText, H3, IdLink, Linkify, StatCard } from "@/components/common"
import { VERIF, VerifBadge } from "@/components/verification"
import { VerifiedTrend } from "@/components/VerifiedTrend"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useApi } from "@/state/project"
import { useCode, useCodeImpact, useVerification } from "@/state/queries"
import { fmt, pct, shortSha, shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const th = "h-8 px-2 text-left text-[12px] font-semibold text-muted-foreground whitespace-nowrap"
const td = "px-2 py-1.5 align-top"

function Table({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table data-testid={testId} className="w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ ingest dialog
function IngestDialog({ open, onOpenChange, components }: { open: boolean; onOpenChange: (b: boolean) => void; components: string[] }) {
  const api = useApi()
  const { refreshAll } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [component, setComponent] = useState("")
  const [commit, setCommit] = useState("")
  const [run, setRun] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [result, setResult] = useState<IngestResult | null>(null)

  const close = (o: boolean) => {
    onOpenChange(o)
    if (!o) {
      setFiles([])
      setResult(null)
      setErr("")
    }
  }

  const submit = async () => {
    setBusy(true)
    setErr("")
    setResult(null)
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })))
      const r = await api.ingest({
        files: payload,
        component: component || undefined,
        commit: commit.trim() || undefined,
        run: run.trim() || undefined,
      })
      setResult(r)
      toast.success(`ingested ${fmt(r.evidence)} result(s): ${fmt(r.passed)} passed, ${fmt(r.failed)} failed`)
      refreshAll()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="ingest-dialog" className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Ingest test results</DialogTitle>
          <DialogDescription>
            JUnit XML (pytest, Jest, …) or a reqforge eval report (JSON). Test cases are matched to criteria by
            <code className="mx-1">REQ-…#AC…</code>in their names or by the tags on the same test in the scanned code.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div>
            <Label className="mb-1 text-[12px] font-normal text-muted-foreground">Result files (.xml, .json)</Label>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-8" onClick={() => fileRef.current?.click()} data-testid="ingest-pick">
                <FileUp /> Choose files
              </Button>
              <span data-testid="ingest-files" className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
                {files.length ? files.map((f) => f.name).join(", ") : "no file chosen"}
              </span>
            </div>
            <input
              ref={fileRef}
              data-testid="ingest-file"
              type="file"
              multiple
              accept=".xml,.json,application/xml,text/xml,application/json"
              className="hidden"
              onChange={(e) => {
                setFiles([...(e.target.files ?? [])])
                setResult(null)
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="ing-comp" className="mb-1 text-[12px] font-normal text-muted-foreground">
                Component (optional)
              </Label>
              <NativeSelect
                id="ing-comp"
                data-testid="ingest-component"
                size="sm"
                className="w-full"
                value={component}
                onChange={(e) => setComponent(e.target.value)}
              >
                <NativeSelectOption value="">any</NativeSelectOption>
                {components.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="ing-commit" className="mb-1 text-[12px] font-normal text-muted-foreground">
                Commit (default: scanned commit)
              </Label>
              <Input id="ing-commit" data-testid="ingest-commit" className="h-8 text-[13px]" value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="sha" />
            </div>
          </div>
          <div>
            <Label htmlFor="ing-run" className="mb-1 text-[12px] font-normal text-muted-foreground">
              CI run URL (optional)
            </Label>
            <Input id="ing-run" data-testid="ingest-run" className="h-8 text-[13px]" value={run} onChange={(e) => setRun(e.target.value)} placeholder="https://github.com/org/repo/actions/runs/…" />
          </div>
          {err && <ErrorText testId="ingest-error">{err}</ErrorText>}
          {result && (
            <div data-testid="ingest-result" className="rounded-md border bg-muted/40 px-3 py-2 text-[12.5px]">
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                <span>
                  <b data-testid="ingest-cases">{fmt(result.cases)}</b> cases
                </span>
                <span>
                  <b data-testid="ingest-matched">{fmt(result.matched)}</b> matched
                </span>
                <span>
                  <b>{fmt(result.unmatched.length)}</b> unmatched
                </span>
                <span>{fmt(result.skipped)} skipped</span>
                <span className="text-ok">{fmt(result.passed)} passed</span>
                <span className={result.failed ? "text-err" : undefined}>{fmt(result.failed)} failed</span>
                <span>{fmt(result.targets)} criteria</span>
                {result.commit && <span className="id-mono">@ {shortSha(result.commit)}</span>}
              </div>
              {!!result.unmatched.length && (
                <div className="mt-1">
                  <span className="text-warn">Unmatched (no REQ id in the name and no tagged test):</span>
                  <ul className="mt-0.5 list-disc pl-5">
                    {result.unmatched.slice(0, 20).map((u) => (
                      <li key={u} className="id-mono break-all whitespace-normal">
                        {u}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          <Button size="sm" disabled={!files.length || busy} onClick={submit} data-testid="ingest-submit">
            {busy ? "Ingesting…" : "Ingest"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------ impact panel
function ImpactPanel({ components }: { components: string[] }) {
  const chat = useChat()
  const [component, setComponent] = useState(components[0] ?? "")
  const [base, setBase] = useState("main")
  const [req, setReq] = useState<{ component: string; base: string; nonce: number }>({ component: "", base: "", nonce: 0 })
  const q = useCodeImpact(req.component, req.base, req.nonce)
  const r = q.data
  const comp = components.includes(component) ? component : (components[0] ?? "")

  return (
    <section data-testid="impact-panel" className="rounded-lg border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="imp-comp" className="text-[12px] font-normal text-muted-foreground">
            Component
          </Label>
          <NativeSelect id="imp-comp" data-testid="impact-component" className="h-8" value={comp} onChange={(e) => setComponent(e.target.value)} disabled={!components.length}>
            {components.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {c}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="imp-base" className="text-[12px] font-normal text-muted-foreground">
            Base ref
          </Label>
          <Input
            id="imp-base"
            data-testid="impact-base"
            className="h-8 w-40 text-[13px]"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && comp) setReq((x) => ({ component: comp, base: base.trim() || "main", nonce: x.nonce + 1 }))
            }}
          />
        </div>
        <Button
          size="sm"
          className="h-8"
          data-testid="impact-run"
          disabled={!comp || q.isFetching}
          onClick={() => setReq((x) => ({ component: comp, base: base.trim() || "main", nonce: x.nonce + 1 }))}
        >
          <Play /> {q.isFetching ? "Analysing…" : "Analyse changes"}
        </Button>
        <p className="min-w-[220px] flex-1 text-[12px] text-muted-foreground">
          Diffs the component's local checkout (including uncommitted changes) against the base ref and maps the changed
          files to requirements, tests and evals through the trace tags.
        </p>
      </div>
      {!components.length && <p className="mt-2 text-[12.5px] text-muted-foreground">No components to analyse.</p>}
      {q.error && (
        <div data-testid="impact-error" className="mt-2 rounded-md border border-err/40 bg-err/5 px-2.5 py-1.5 text-[12.5px]">
          <b className="font-semibold text-err">Impact analysis failed: </b>
          {(q.error as Error).message}
          <div className="mt-0.5 text-muted-foreground">
            It needs the component's local git checkout (the component's <code>path</code>) and a base ref that exists there.
          </div>
        </div>
      )}
      {r && !q.error && (
        <div data-testid="impact-result" className="mt-3 grid gap-3 text-[13px] md:grid-cols-2">
          <div>
            <H3 className="mt-0">
              Changed files <span className="font-normal text-muted-foreground">({fmt(r.changed_files.length)} vs {r.base})</span>
            </H3>
            {r.changed_files.length ? (
              <ul className="space-y-0.5">
                {r.changed_files.map((f) => (
                  <li key={f} data-testid="impact-file" className="id-mono break-all whitespace-normal">
                    {f}
                    {r.untraced_changes.includes(f) && <span className="ml-1.5 font-sans text-[11px] text-warn">untraced</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No changes against {r.base}.</p>
            )}
          </div>
          <div>
            <H3 className="mt-0">Requirements touched ({fmt(r.requirements.length)})</H3>
            {r.requirements.length ? (
              <ul className="space-y-1">
                {r.requirements.map((x) => (
                  <li key={x.id} data-testid="impact-req" data-id={x.id}>
                    <IdLink id={x.id} /> {x.title}
                    <div className="text-[12px] text-muted-foreground">
                      {x.via.map((v, i) => (
                        <span key={i} className="mr-2">
                          {v.kind} · <span className="id-mono">{v.file}:{v.line}</span>
                          {v.symbol ? ` ${v.symbol}` : ""}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">None.</p>
            )}
          </div>
          <div>
            <H3 className="mt-0">Tests to re-run ({fmt(r.tests.length)})</H3>
            {r.tests.length ? (
              <ul className="space-y-0.5">
                {r.tests.map((t) => (
                  <li key={t.file} data-testid="impact-test" data-file={t.file}>
                    <span className="id-mono break-all whitespace-normal">{t.file}</span>
                    {!!t.symbols.length && <span className="ml-1.5 text-[12px] text-muted-foreground">{t.symbols.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">None.</p>
            )}
            {!!r.evals.length && (
              <>
                <H3>Evals ({fmt(r.evals.length)})</H3>
                <ul className="space-y-0.5">
                  {r.evals.map((e) => (
                    <li key={`${e.story}/${e.id}`} data-testid="impact-eval">
                      <IdLink id={e.story} />
                      <span className="id-mono">/{e.id}</span> {e.kind && <span className="text-muted-foreground">{e.kind}</span>}{" "}
                      {e.command && <code className="text-[12px] text-muted-foreground">{e.command}</code>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div>
            <H3 className="mt-0">Criteria at risk ({fmt(r.criteria_at_risk.length)})</H3>
            {r.criteria_at_risk.length ? (
              <p data-testid="impact-risk" className="flex flex-wrap gap-x-2">
                {r.criteria_at_risk.map((c) => (
                  <span key={c}>
                    <Linkify text={c} />
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-muted-foreground">None.</p>
            )}
            {!!r.untraced_changes.length && (
              <>
                <H3>Untraced changes ({fmt(r.untraced_changes.length)})</H3>
                <ul data-testid="impact-untraced" className="space-y-0.5">
                  {r.untraced_changes.map((f) => (
                    <li key={f} className="id-mono break-all whitespace-normal text-warn">
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-1.5"
                  data-testid="impact-ask"
                  onClick={() =>
                    chat.ask(
                      `These files in component ${r.component} changed against ${r.base} but carry no reqforge trace tags: ${r.untraced_changes.join(", ")}. Which requirements do they implement? Propose the \`# reqforge: implements REQ-…\` tags, and a changeset if a requirement is missing.`,
                    )
                  }
                >
                  <MessageSquare /> Ask Claude to trace these
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ dashboard
// reqforge: implements REQ-0034
export function VerificationView() {
  const { goto, setTab, refreshAll } = useApp()
  const api = useApi()
  const chat = useChat()
  const q = useVerification()
  const code = useCode()
  const [scanning, setScanning] = useState<string | null>(null)
  const [ingestOpen, setIngestOpen] = useState(false)

  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const r = q.data
  const S = r.summary
  const comps = code.data?.components ?? []
  const keys = comps.map((c) => c.key)
  const idx = Object.fromEntries((code.data?.indexes ?? S.components).map((i) => [i.component, i]))

  const scan = async (only?: string) => {
    setScanning(only ?? "*")
    try {
      const res = await api.scan(only ? [only] : undefined)
      const parts = res.scanned.map((s) =>
        s.skipped ? `${s.component}: skipped (${s.skipped})` : `${s.component}: ${fmt(s.tags ?? 0)} tags in ${fmt(s.tagged_files ?? 0)} files`,
      )
      if (res.scanned.some((s) => s.skipped)) toast.warning(parts.join(" · "))
      else toast.success(`scanned ${parts.join(" · ") || "nothing"}`)
      refreshAll()
    } catch (e) {
      toast.error(`scan failed: ${(e as Error).message}`)
    } finally {
      setScanning(null)
    }
  }

  return (
    <div data-testid="verification-view">
      <Cards>
        <StatCard
          testId="verif-gate"
          value={r.ok ? "PASS" : "FAIL"}
          tone={r.ok ? "ok" : "err"}
          label={`verification gate · ${r.checks.filter((c) => !c.passed).length} failing checks`}
        />
        <StatCard testId="verif-ratio" value={pct(S.verified_ratio)} label={`criteria verified (${fmt(S.criteria_total)})`} tone={S.verified_ratio >= 1 ? "ok" : undefined} />
        <StatCard value={fmt(S.implemented)} label="requirements with tagged code" />
        <StatCard value={fmt(S.evidence)} label="evidence results" />
        {S.state && (
          <StatCard
            testId="verif-snapshot-age"
            value={!S.state.snapshot.exists ? "none" : S.state.snapshot.age_days == null ? "undated" : `${fmt(S.state.snapshot.age_days)}d`}
            tone={S.state.snapshot.stale ? "warn" : S.state.snapshot.exists ? "ok" : "muted"}
            label={
              S.state.snapshot.stale
                ? `snapshot stale · ${fmt(S.state.snapshot.days_over)}d over ${S.state.snapshot.limit_days}d limit`
                : `snapshot age (limit ${S.state.snapshot.limit_days}d)`
            }
            title={S.state.snapshot.last_reconciled ? `Last reconciled ${S.state.snapshot.last_reconciled}` : "No project snapshot"}
          />
        )}
        {S.state && (
          <StatCard
            testId="verif-decisions-unexercised"
            value={fmt(S.state.decisions.unexercised)}
            tone={S.state.decisions.overdue ? "warn" : S.state.decisions.unexercised ? undefined : "ok"}
            label={`unexercised decisions of ${fmt(S.state.decisions.accepted)} · ${fmt(S.state.decisions.overdue)} past ${S.state.decisions.grace_days}d`}
            title={S.state.decisions.overdue_ids.join(", ") || undefined}
          />
        )}
      </Cards>
      <div className="mb-3">
        <VerifiedTrend />
      </div>

      <div className="mb-3 grid gap-3 md:grid-cols-2">
        {(
          [
            ["criteria", "Acceptance criteria", S.criteria],
            ["requirements", "Requirements", S.requirements],
          ] as const
        ).map(([k, label, counts]) => (
          <div key={k} data-testid={`verif-${k}`} className="rounded-lg border bg-card px-3 py-2">
            <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
              <b className="font-semibold">{label}</b>
              <span className="text-muted-foreground">click a status to list the requirements</span>
            </div>
            <StatusBar counts={counts} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {VERIFICATION_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid="verif-count"
                  data-kind={k}
                  data-status={s}
                  data-count={counts[s] ?? 0}
                  title={`show requirements whose status is ${s}`}
                  onClick={() => goto("requirements", { verification: s })}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[12.5px] transition-colors hover:border-primary/60 hover:bg-muted/40"
                >
                  <VerifBadge status={s} testId="verif-count-badge" />
                  <b className="font-semibold tabular-nums">{fmt(counts[s] ?? 0)}</b>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" className="h-8" onClick={() => scan()} disabled={!!scanning || !comps.length} data-testid="scan-all">
          <ScanSearch /> {scanning === "*" ? "Scanning…" : "Scan now"}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setIngestOpen(true)} data-testid="ingest-open">
          <FileUp /> Ingest results
        </Button>
        {(S.criteria.untested ?? 0) > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            data-testid="verif-ask-untested"
            onClick={() =>
              chat.ask(
                `${fmt(S.criteria.untested)} acceptance criteria have no tagged test or covering eval. Look at the component checkouts, find the tests that already verify them and propose the \`REQ-…#AC…\` tags to add; for the rest, propose tests or evals (as a changeset on the stories).`,
              )
            }
          >
            <MessageSquare /> Ask Claude to tag the untested criteria
          </Button>
        )}
        {(S.criteria.failing ?? 0) + (S.criteria.suspect ?? 0) > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            data-testid="verif-ask-failing"
            onClick={() =>
              chat.ask(
                `Explain the failing and suspect criteria in the verification report: what broke, which code changed, which tests to re-run, and what to fix first.`,
              )
            }
          >
            <MessageSquare /> Ask Claude about failing &amp; suspect
          </Button>
        )}
      </div>

      <H3>Components</H3>
      {comps.length ? (
        <Table testId="comp-table">
          <thead>
            <tr className="border-b">
              {["component", "commit", "scanned", "tagged files", "implements", "verifies", "requirements", ""].map((h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comps.map((c) => {
              const i = idx[c.key]
              return (
                <tr key={c.key} data-testid="comp-row" data-key={c.key} className="border-b last:border-b-0">
                  <td className={td}>
                    <b className="id-mono font-semibold">{c.key}</b> <span className="text-muted-foreground">{c.title}</span>
                    <div className="id-mono text-[11.5px] break-all whitespace-normal text-muted-foreground">{c.path || "(no path)"}</div>
                  </td>
                  <td className={cn(td, "id-mono")} title={i?.commit ?? ""}>
                    {i?.commit ? shortSha(i.commit) : "—"}
                  </td>
                  <td className={cn(td, "whitespace-nowrap tabular-nums")} data-testid="comp-scanned" data-at={i?.scanned_at ?? ""}>
                    {i ? shortTime(i.scanned_at) : <span className="text-warn">never</span>}
                  </td>
                  <td className={cn(td, "tabular-nums")}>
                    {i ? (
                      <>
                        {fmt(i.tagged_files)} <span className="text-muted-foreground">/ {fmt(i.files_scanned)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={cn(td, "tabular-nums")} data-testid="comp-implements">{i ? fmt(i.implements) : "—"}</td>
                  <td className={cn(td, "tabular-nums")} data-testid="comp-verifies">{i ? fmt(i.verifies) : "—"}</td>
                  <td className={cn(td, "tabular-nums")}>{i ? fmt(i.requirements) : "—"}</td>
                  <td className={cn(td, "text-right")}>
                    <Button size="xs" variant="outline" disabled={!!scanning} onClick={() => scan(c.key)} data-testid="comp-scan">
                      <RefreshCw className={cn(scanning === c.key && "animate-spin")} /> Scan
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      ) : (
        <div data-testid="no-components" className="rounded-lg border border-dashed bg-card px-3 py-3 text-[13px]">
          <p className="text-muted-foreground">
            No code components yet. A component is a code checkout (key, local path, repository URL) whose files carry
            <code className="mx-1">reqforge: implements REQ-…</code> and <code className="mx-1">REQ-…#AC…</code> tags.
            Until one is scanned and CI results are ingested, criteria stay <VerifBadge status="untested" /> or{" "}
            <VerifBadge status="pending" /> (an eval covers them but no result exists).
          </p>
          <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => setTab("components")} data-testid="goto-components">
            Add a component
          </Button>
        </div>
      )}

      <H3>Impact of a code change</H3>
      <ImpactPanel key={keys.join(",")} components={keys} />

      <H3>Gate checks</H3>
      <Table testId="verif-checks">
        <thead>
          <tr className="border-b">
            <th className={th}>check</th>
            <th className={th}>result</th>
            <th className={th}>findings</th>
          </tr>
        </thead>
        <tbody>
          {r.checks.map((c) => (
            <tr key={c.id} data-testid="verif-check" data-id={c.id} data-passed={c.passed ? "true" : "false"} className="border-b last:border-b-0">
              <td className={td}>
                {c.name}
                <div className="id-mono text-[11px] text-muted-foreground">{c.id}</div>
              </td>
              <td className={cn(td, "font-medium", c.passed ? "text-ok" : c.severity === "error" ? "text-err" : "text-warn")}>
                {c.passed ? "pass" : c.severity}
              </td>
              <td className={td}>
                {c.failures.length ? (
                  <Collapsible defaultOpen={c.failures.length <= 5}>
                    <CollapsibleTrigger data-testid="check-toggle" className="group inline-flex items-center gap-1 text-primary hover:underline">
                      <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
                      {fmt(c.failures.length)}
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px]">
                        {c.failures.slice(0, 200).map((f, i) => (
                          <li key={i} data-testid="check-failure" className="break-all">
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
      </Table>

      <IngestDialog open={ingestOpen} onOpenChange={setIngestOpen} components={keys} />
    </div>
  )
}

/** Stacked bar of status counts (labels are in the buttons below it). */
function StatusBar({ counts }: { counts: Record<string, number> }) {
  const total = VERIFICATION_STATUSES.reduce((a, s) => a + (counts[s] ?? 0), 0)
  if (!total) return <div className="h-2 rounded-full bg-muted" />
  return (
    <div className="flex h-2 gap-px overflow-hidden rounded-full bg-muted" role="img" aria-label={VERIFICATION_STATUSES.map((s) => `${s} ${counts[s] ?? 0}`).join(", ")}>
      {VERIFICATION_STATUSES.map((s) =>
        counts[s] ? (
          <span key={s} className={VERIF[s].dot} style={{ width: `${(100 * counts[s]) / total}%` }} title={`${s}: ${counts[s]}`} />
        ) : null,
      )}
    </div>
  )
}
