import { useEffect, useMemo, useState } from "react"
import { MessageSquare, X } from "lucide-react"
import { toast } from "sonner"
import { api, ApiError } from "@/api/client"
import type { FieldSchema, Kind, Meta, RecordBase, RecordContext, Requirement } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Cards, Chip, ErrorText, H3, IdLink, IdList, StatCard } from "@/components/common"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useRecord, useRecordContext } from "@/state/queries"
import { severityClass, singular } from "@/lib/format"
import { cn } from "@/lib/utils"

type FormValues = Record<string, string>

function toForm(schema: Record<string, FieldSchema>, rec: RecordBase | null): FormValues {
  const out: FormValues = {}
  for (const [f, s] of Object.entries(schema)) {
    const v = rec ? rec[f] : s.default
    if (s.type === "objlist") out[f] = JSON.stringify(v || [], null, 2)
    else if (s.type === "list" || s.type === "reflist") out[f] = Array.isArray(v) ? v.join(", ") : ""
    else out[f] = v == null ? "" : String(v)
  }
  return out
}

function fromForm(schema: Record<string, FieldSchema>, values: FormValues, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [f, s] of Object.entries(schema)) {
    const raw = values[f] ?? ""
    let v: unknown
    if (s.type === "objlist") {
      try {
        v = JSON.parse(raw || "[]")
      } catch {
        throw new Error(`${f}: invalid JSON`)
      }
    } else if (s.type === "list" || s.type === "reflist")
      v = raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    else if (s.type === "int") v = raw === "" ? null : parseInt(raw, 10)
    else v = raw === "" ? null : raw
    if (creating && v == null) continue
    out[f] = v
  }
  return out
}

function Field({
  kind,
  name,
  s,
  value,
  onChange,
  meta,
  values,
}: {
  kind: Kind
  name: string
  s: FieldSchema
  value: string
  onChange: (v: string) => void
  meta: Meta
  values: FormValues
}) {
  const id = `f_${name}`
  const hint =
    s.type === "objlist"
      ? ` (JSON list: ${(s.keys || []).join(", ")}${name === "evals" ? ", covers[], required" : ""})`
      : s.type.includes("list")
        ? " (comma-separated)"
        : ""
  let input
  if (s.values)
    input = (
      <NativeSelect id={id} data-testid={id} className="w-full" size="sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">—</NativeSelectOption>
        {s.values.map((x) => (
          <NativeSelectOption key={x} value={x}>
            {x}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    )
  else if (kind === "requirements" && name === "category") {
    const cats = Object.keys(meta.taxonomy[values.type]?.categories || {})
    input = (
      <>
        <Input id={id} data-testid={id} className="h-8 text-[13px]" list="catlist" value={value} onChange={(e) => onChange(e.target.value)} />
        <datalist id="catlist">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </>
    )
  } else if (s.type === "text")
    input = <Textarea id={id} data-testid={id} className="min-h-16 text-[13px]" value={value} onChange={(e) => onChange(e.target.value)} />
  else if (s.type === "objlist")
    input = (
      <Textarea
        id={id}
        data-testid={id}
        className="min-h-28 font-mono text-[12px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  else
    input = (
      <Input
        id={id}
        data-testid={id}
        className="h-8 text-[13px]"
        type={s.type === "int" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  return (
    <div className="mb-2.5">
      <Label htmlFor={id} className="mb-1 text-[12px] font-normal text-muted-foreground">
        {name}
        {s.required ? " *" : ""}
        {hint}
      </Label>
      {input}
    </div>
  )
}

function DetailsForm({ kind, rec, meta }: { kind: Kind; rec: RecordBase | null; meta: Meta }) {
  const { closeDrawer, refreshAll } = useApp()
  const schema = meta.schemas[kind]
  const [values, setValues] = useState<FormValues>(() => toForm(schema, rec))
  const [err, setErr] = useState("")
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const showErr = (e: unknown) => {
    const details = e instanceof ApiError ? e.details : []
    const msg =
      e instanceof ApiError && e.status === 409 && rec && !details.length
        ? `${e.message}\nThis record changed since you opened it (conflict); reopen it to load the latest version.`
        : (e as Error).message
    setErr([msg, ...details.map((d) => "• " + (typeof d === "string" ? d : JSON.stringify(d)))].join("\n"))
  }

  const save = async () => {
    setBusy(true)
    setErr("")
    try {
      const out = fromForm(schema, values, !rec)
      const r = rec ? await api.update(kind, rec.id, out, rec.version) : await api.create(kind, out)
      toast.success(`${r.id} saved (v${r.version})`)
      closeDrawer()
      refreshAll()
    } catch (e) {
      toast.error((e as Error).message)
      showErr(e)
    } finally {
      setBusy(false)
    }
  }

  const del = async () => {
    if (!rec) return
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    try {
      await api.remove(kind, rec.id)
      toast.success(`${rec.id} deleted`)
      closeDrawer()
      refreshAll()
    } catch (e) {
      showErr(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3" data-testid="details-form">
        {Object.entries(schema).map(([f, s]) => (
          <Field
            key={f}
            kind={kind}
            name={f}
            s={s}
            meta={meta}
            values={values}
            value={values[f] ?? ""}
            onChange={(v) => setValues((cur) => ({ ...cur, [f]: v }))}
          />
        ))}
        {rec && (
          <p className="text-[12px] text-muted-foreground">
            created {rec.created} · updated {rec.updated}
          </p>
        )}
        {err && (
          <div className="mt-2">
            <ErrorText testId="drawer-error">{err}</ErrorText>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t px-4 py-2.5">
        <Button size="sm" onClick={save} disabled={busy} data-testid="drawer-save">
          {rec ? "Save" : "Create"}
        </Button>
        {rec && (
          <Button size="sm" variant="destructive" onClick={del} disabled={busy} data-testid="drawer-delete">
            {armed ? "Click again to delete" : "Delete"}
          </Button>
        )}
      </div>
    </div>
  )
}

function LinksPanel({ kind, ctx, meta }: { kind: Kind; ctx: RecordContext; meta: Meta }) {
  const r = ctx.record as Requirement
  if (kind === "requirements" && ctx.impact) {
    const im = ctx.impact
    const acs = r.acceptance_criteria || []
    const lint = ctx.lint || []
    return (
      <div data-testid="links-panel" className="text-[13px]">
        <Cards className="grid-cols-4">
          {(
            [
              ["stories", im.stories.length],
              ["tasks", im.tasks.length],
              ["evals", im.evals.length],
              ["components", im.components.length],
            ] as const
          ).map(([l, n]) => (
            <StatCard key={l} value={n} label={l} tone={n || l === "components" ? undefined : "err"} />
          ))}
        </Cards>
        {ctx.parent && (
          <>
            <H3>Parent</H3>
            <IdLink id={ctx.parent} />
          </>
        )}
        {!!ctx.children?.length && (
          <>
            <H3>Children ({ctx.children.length})</H3>
            <ul className="list-disc space-y-0.5 pl-5">
              {ctx.children.map((x) => (
                <li key={x.id}>
                  <IdLink id={x.id} /> {x.title}
                </li>
              ))}
            </ul>
          </>
        )}
        <H3>Realised by stories</H3>
        {im.stories.length ? (
          <ul className="list-disc space-y-0.5 pl-5">
            {im.stories.map((s) => (
              <li key={s.id}>
                <IdLink id={s.id} /> {s.title} <Chip>{s.status}</Chip> {s.component && <Chip>{s.component}</Chip>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-err">No story realises this requirement.</p>
        )}
        {!!im.tasks.length && (
          <>
            <H3>Tasks</H3>
            <ul className="list-disc space-y-0.5 pl-5">
              {im.tasks.map((t) => (
                <li key={t.id}>
                  <IdLink id={t.id} /> <Chip>{t.kind}</Chip> {t.title} <span className="text-muted-foreground">{t.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <H3>Acceptance criteria → evals</H3>
        {acs.length ? (
          <ul data-testid="ac-list" className="list-disc space-y-1 pl-5">
            {acs.map((a) => {
              const evs = im.evals.filter((e) => (e.covers || []).includes(`${r.id}#${a.id}`))
              return (
                <li key={a.id}>
                  <b className="font-semibold">{a.id}</b> {a.text}
                  <div className="text-[12px]">
                    {evs.length ? (
                      evs.map((e) => (
                        <div key={`${e.story}/${e.id}`} className="flex flex-wrap items-center gap-1">
                          <Chip>{e.kind}</Chip>
                          <IdLink id={e.story} />
                          <span className="id-mono">/{e.id}</span>
                          <span className="id-mono text-muted-foreground">{e.command || "(no command)"}</span>
                        </div>
                      ))
                    ) : (
                      <span className="text-err">not covered by any eval</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-warn">No acceptance criteria.</p>
        )}
        <H3>Lint</H3>
        {lint.length ? (
          <ul className="list-disc space-y-0.5 pl-5">
            {lint.map((f, i) => (
              <li key={i} className={severityClass(f.severity)}>
                {f.rule}: {f.message} <IdList ids={f.ids.filter((x) => x !== r.id)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ok">Clean.</p>
        )}
      </div>
    )
  }
  const refs = Object.entries(meta.schemas[kind])
    .filter(([, s]) => s.type === "ref" || s.type === "reflist")
    .flatMap(([f]) => ([] as unknown[]).concat(r[f] || []).map((v) => [f, String(v)] as const))
  return (
    <div data-testid="links-panel" className="text-[13px]">
      <H3>Referenced by</H3>
      {ctx.referenced_by.length ? <IdList ids={ctx.referenced_by} /> : <p className="text-muted-foreground">Nothing references this record.</p>}
      {!!refs.length && (
        <>
          <H3>References</H3>
          <ul className="list-disc space-y-0.5 pl-5">
            {refs.map(([f, v], i) => (
              <li key={i}>
                {f}: <IdLink id={v} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function LinksTab({ kind, id, meta }: { kind: Kind; id: string; meta: Meta }) {
  const q = useRecordContext(id, true)
  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  return <LinksPanel kind={kind} ctx={q.data} meta={meta} />
}

function DrawerBody() {
  const { drawer, meta, closeDrawer } = useApp()
  const chat = useChat()
  const { kind, id } = drawer
  const recQ = useRecord(kind, id)
  const [tab, setTab] = useState("details")
  const rec = id ? (recQ.data ?? null) : null

  useEffect(() => {
    if (recQ.error) toast.error((recQ.error as Error).message)
  }, [recQ.error])

  const title = id ? (rec ? `${rec.id} · v${rec.version}` : id) : `New ${singular(kind)}`
  const formKey = useMemo(() => `${kind}-${id}-${rec?.version ?? "new"}-${drawer.nonce}`, [kind, id, rec?.version, drawer.nonce])

  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <SheetTitle data-testid="drawer-title" className="min-w-0 flex-1 truncate text-[14px] font-semibold">
          {title}
          {rec?.title ? <span className="ml-2 font-normal text-muted-foreground">{String(rec.title)}</span> : null}
        </SheetTitle>
        <SheetDescription className="sr-only">Record details and links</SheetDescription>
        {rec && (
          <Button
            size="xs"
            variant="outline"
            data-testid="drawer-ask"
            onClick={() =>
              chat.ask(
                `Review ${rec.id} (“${rec.title}”): is it MECE with its siblings, measurable, correctly classified, and properly traced to stories and evals? Propose a changeset if anything should change.`,
              )
            }
          >
            <MessageSquare /> Ask Claude
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="close" data-testid="drawer-close" onClick={closeDrawer}>
          <X />
        </Button>
      </div>
      {!meta || (id && !rec) ? (
        <div className="p-4">
          {recQ.error ? <ErrorText>{(recQ.error as Error).message}</ErrorText> : <p className="text-muted-foreground">Loading…</p>}
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="px-4 pt-2">
            <TabsList className="h-8">
              <TabsTrigger value="details" data-testid="drawer-tab-details" className="text-[13px]">
                Details
              </TabsTrigger>
              {rec && (
                <TabsTrigger value="links" data-testid="drawer-tab-links" className="text-[13px]">
                  Links &amp; impact
                </TabsTrigger>
              )}
            </TabsList>
          </div>
          <TabsContent value="details" className="flex min-h-0 flex-1 flex-col">
            <DetailsForm key={formKey} kind={kind} rec={rec} meta={meta} />
          </TabsContent>
          {rec && (
            <TabsContent value="links" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <LinksTab kind={kind} id={rec.id} meta={meta} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </>
  )
}

export function RecordDrawer() {
  const { drawer, closeDrawer } = useApp()
  return (
    <Sheet open={drawer.open} onOpenChange={(o) => !o && closeDrawer()} modal={false}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="drawer"
        className={cn("w-[min(600px,100vw)] gap-0 p-0 sm:max-w-[600px]")}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DrawerBody key={`${drawer.kind}-${drawer.id}-${drawer.nonce}`} />
      </SheetContent>
    </Sheet>
  )
}
