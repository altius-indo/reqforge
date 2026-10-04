import { useQuery } from "@tanstack/react-query"
import { ExternalLink, MessageSquare } from "lucide-react"
import type { CriterionVerification, Requirement, ReqVerification } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Chip, ErrorText, H3, IdLink } from "@/components/common"
import { CodeLoc, TagHelp, VERIF, VerifBadge } from "@/components/verification"
import { useChat } from "@/state/chat"
import { useApi } from "@/state/project"
import { useCode, useRecordContext } from "@/state/queries"
import { shortSha, shortTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Component } from "@/api/types"

/** "test:web:tests/x.py::test_y" -> ["test", "web", "tests/x.py::test_y"]; "eval:STORY-1/E1" -> ["eval", "", "STORY-1/E1"] */
function splitSource(src: string): [string, string, string] {
  const [kind, ...rest] = src.split(":")
  if (kind === "test" && rest.length >= 2) return ["test", rest[0], rest.slice(1).join(":")]
  return [kind, "", rest.join(":")]
}

function EvidenceTable({ rows }: { rows: CriterionVerification["evidence"] }) {
  return (
    <ul className="divide-y rounded-md border text-[12px]">
      {rows.map((e, i) => {
        const [kind, comp, what] = splitSource(e.source)
        return (
          <li key={i} data-testid="evidence-row" data-status={e.status} className="px-2 py-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <b
                data-testid="evidence-status"
                className={cn("font-semibold", e.status === "passed" ? "text-ok" : e.status === "failed" ? "text-err" : "")}
              >
                {e.status}
              </b>
              <span className="text-muted-foreground">
                {kind}
                {comp && ` · ${comp}`}
              </span>
              {e.commit && (
                <span className="text-muted-foreground">
                  @{" "}
                  <span data-testid="evidence-commit" className="id-mono text-foreground" title={e.commit}>
                    {shortSha(e.commit)}
                  </span>
                </span>
              )}
              {e.run && /^https?:\/\//.test(e.run) ? (
                <a
                  data-testid="run-link"
                  href={e.run}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  title={e.run}
                >
                  CI run <ExternalLink className="size-3" />
                </a>
              ) : e.run ? (
                <span className="text-muted-foreground">{e.run}</span>
              ) : null}
              <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">{shortTime(e.at)}</span>
            </div>
            <div className="id-mono mt-0.5 break-all whitespace-normal text-foreground/80">{what}</div>
          </li>
        )
      })}
    </ul>
  )
}

function Criterion({
  reqId,
  acId,
  text,
  v,
  components,
}: {
  reqId: string
  acId: string
  text?: string
  v: CriterionVerification | undefined
  components: Component[] | undefined
}) {
  const status = v?.status ?? "untested"
  return (
    <li data-testid="ac-verif" data-ac={acId} data-status={status} className="rounded-lg border bg-card px-3 py-2">
      <div className="flex items-start gap-2">
        <b className="font-semibold">{acId}</b>
        <span className="min-w-0 flex-1">{text ?? <span className="text-muted-foreground">(criterion not in the record)</span>}</span>
        <VerifBadge status={status} testId="ac-status" />
      </div>
      <div className="mt-1.5 space-y-1.5 text-[12.5px]">
        {!!v?.tests.length && (
          <div>
            <div className="text-[11.5px] font-medium text-muted-foreground">Tagged tests</div>
            <ul className="space-y-0.5">
              {v.tests.map((t, i) => (
                <li key={i} data-testid="test-loc">
                  <CodeLoc loc={t} components={components} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!v?.evals.length && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11.5px] font-medium text-muted-foreground">Covering evals</span>
            {v.evals.map((e) => {
              const [story, ev] = e.split("/")
              return (
                <span key={e} data-testid="ac-eval" className="inline-flex items-center">
                  <IdLink id={story} />
                  <span className="id-mono">/{ev}</span>
                </span>
              )
            })}
          </div>
        )}
        {!!v?.evidence.length && (
          <div>
            <div className="mb-0.5 text-[11.5px] font-medium text-muted-foreground">Latest evidence</div>
            <EvidenceTable rows={v.evidence} />
          </div>
        )}
        {status === "suspect" && !!v?.changed.length && (
          <div data-testid="suspect-files" className="rounded-md border border-warn/40 bg-warn/5 px-2 py-1">
            <span className="text-warn">Changed since the evidence was recorded — re-run to re-verify:</span>
            <ul className="mt-0.5 space-y-0.5">
              {v.changed.map((c) => {
                const i = c.indexOf(":")
                const comp = i > 0 ? c.slice(0, i) : ""
                const file = i > 0 ? c.slice(i + 1) : c
                return (
                  <li key={c} data-testid="changed-file" data-file={file} className="flex items-baseline gap-1.5">
                    {comp && <span className="rounded bg-muted px-1 text-[11px] text-muted-foreground">{comp}</span>}
                    <span className="id-mono break-all whitespace-normal">{file}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {status === "pending" && !v?.evidence.length && (
          <p className="text-muted-foreground">No result yet: ingest the CI run (JUnit XML or eval report) on the Verification tab.</p>
        )}
        {!v?.tests.length && !v?.evals.length && <TagHelp id={reqId} ac={acId} implementation={false} />}
      </div>
    </li>
  )
}

export function CodeEvidencePanel({ rec }: { rec: Requirement }) {
  const api = useApi()
  const chat = useChat()
  const ctxQ = useRecordContext(rec.id, true)
  const code = useCode()
  // older servers: no `code` in the context payload -> ask /verification?req=
  const needOwn = !!ctxQ.data && !ctxQ.data.code
  const ownQ = useQuery({
    queryKey: ["p", api.key, "verification", "req", rec.id],
    queryFn: () => api.reqVerification(rec.id),
    enabled: needOwn,
  })
  const v: ReqVerification | undefined = ctxQ.data?.code ?? ownQ.data
  const err = ctxQ.error || ownQ.error
  if (err) return <ErrorText>{(err as Error).message}</ErrorText>
  if (!v) return <p className="text-muted-foreground">Loading…</p>

  const comps = code.data?.components
  const acs = rec.acceptance_criteria || []
  const acIds = [...acs.map((a) => a.id), ...Object.keys(v.acs).filter((k) => !acs.some((a) => a.id === k))]
  const weak = acIds.filter((a) => ["untested", "failing", "suspect"].includes(v.acs[a]?.status ?? "untested"))

  return (
    <div data-testid="code-panel" data-status={v.status} className="text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Overall</span>
        <VerifBadge status={v.status} testId="code-status" className="text-[12.5px]" />
        <span className="text-[12px] text-muted-foreground">{VERIF[v.status]?.help}</span>
        <span className="flex-1" />
        {!!weak.length && (
          <Button
            size="xs"
            variant="outline"
            data-testid="code-ask"
            onClick={() =>
              chat.ask(
                `For ${rec.id} (“${rec.title}”), criteria ${weak.join(", ")} are ${weak.map((a) => v.acs[a]?.status ?? "untested").join("/")}. Find the implementing code and tests in the component checkouts, propose the reqforge trace tags to add (\`# reqforge: implements ${rec.id}\`, \`${rec.id}#AC…\` on tests), and say which tests need to be re-run or fixed.`,
              )
            }
          >
            <MessageSquare /> Ask Claude
          </Button>
        )}
      </div>
      {!v.active && (
        <p className="mt-1 text-[12px] text-muted-foreground">This requirement is not active (deprecated or rejected); it is not gated.</p>
      )}

      <H3>Implemented by</H3>
      {v.implements.length ? (
        <ul data-testid="impl-list" className="space-y-0.5">
          {v.implements.map((l, i) => (
            <li key={i} data-testid="impl-loc">
              <CodeLoc loc={l} components={comps} />
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="impl-empty">
          <p className="mb-1.5 text-muted-foreground">
            {comps && !comps.length ? (
              <>
                No code components in this project yet. Add one on the <b>Components</b> tab (key, local checkout path,
                repository URL), then tag its code.
              </>
            ) : (
              <>No code is tagged as implementing {rec.id}.</>
            )}
          </p>
          <TagHelp id={rec.id} tests={false} />
        </div>
      )}

      <H3>Acceptance criteria</H3>
      {acIds.length ? (
        <ul data-testid="ac-verif-list" className="space-y-2">
          {acIds.map((a) => (
            <Criterion
              key={a}
              reqId={rec.id}
              acId={a}
              text={acs.find((x) => x.id === a)?.text}
              v={v.acs[a]}
              components={comps}
            />
          ))}
        </ul>
      ) : (
        <p className="text-warn">No acceptance criteria: add them on the Details tab so tests can verify them.</p>
      )}
      {comps && comps.length > 0 && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Components: {comps.map((c) => <Chip key={c.key} className="mr-1">{c.key}</Chip>)}
        </p>
      )}
    </div>
  )
}
