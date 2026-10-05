import { useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, MessageSquare, Plus, Upload } from "lucide-react"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import { useApi } from "@/state/project"
import type { Kind, ListRow } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Chip, ErrorText } from "@/components/common"
import { Crumbs } from "@/components/Crumbs"
import { VerifBadge } from "@/components/verification"
import { StartButton } from "@/components/TaskStart"
import { AgentQueuePanel } from "@/components/AgentQueuePanel"
import { PAGE_SIZE_OPTIONS, useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useListPage } from "@/state/queries"
import { fmt, viewPrompt } from "@/lib/format"
import { cn } from "@/lib/utils"

const COLS: Record<Kind, string[]> = {
  requirements: ["title", "category", "priority", "status", "_verification", "_stories", "_children", "tags"],
  epics: ["title", "requirements", "status", "tags"],
  stories: ["title", "epic", "requirements", "component", "_evals", "_tasks", "status"],
  tasks: ["title", "story", "kind", "status", "depends_on", "estimate", "_start"],
  components: ["key", "title", "language", "path", "owners"],
  decisions: ["title", "status", "requirements", "superseded_by"],
}
const LABEL: Record<string, string> = {
  _stories: "stories",
  _children: "children",
  _evals: "evals",
  _tasks: "tasks",
  _verification: "verification",
  _start: "",
  depends_on: "depends on",
}
/** columns the server cannot sort by */
const NO_SORT = ["_verification", "_start"]
const HIDE_MOBILE = ["depends_on", "tags", "requirements", "story", "epic", "component", "_children", "path", "owners"]
const NUMERIC = ["_stories", "_children", "_evals", "_tasks"]

function Cell({ kind, row, field }: { kind: Kind; row: ListRow; field: string }) {
  const { setFilters } = useApp()
  const v = row[field]
  if (field === "title")
    return (
      <>
        <div className="font-medium">{String(v ?? "")}</div>
        {kind === "requirements" && row.statement ? (
          <div className="line-clamp-2 mt-0.5 text-[12px] text-muted-foreground">{String(row.statement)}</div>
        ) : null}
      </>
    )
  if (field === "category")
    return (
      <>
        <Chip>{String(row.type ?? "")}</Chip>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{String(v ?? "")}</div>
      </>
    )
  if (field === "_stories")
    return (
      <span className={cn("tabular-nums", !v && "font-semibold text-err")} title={v ? "" : "not realised by any story"}>
        {String(v || 0)}
      </span>
    )
  if (field === "_children")
    return v ? (
      <button
        type="button"
        data-testid="children-link"
        className="text-primary tabular-nums hover:underline"
        onClick={(e) => {
          e.stopPropagation()
          setFilters({ parent: row.id })
        }}
      >
        ▸ {String(v)}
      </button>
    ) : null
  if (field === "_verification") return <VerifBadge status={row._verification} />
  if (field === "_start")
    return (
      <StartButton
        id={row.id}
        version={row.version}
        status={row.status}
        checkDeps={Array.isArray(row.depends_on) && row.depends_on.length > 0}
      />
    )
  if (field === "key") return <span className="id-mono font-medium">{String(v ?? "")}</span>
  if (field === "path")
    return <span className="id-mono text-[12px] break-all text-muted-foreground">{String(v ?? "")}</span>
  if (field === "_evals")
    return <span className={cn("tabular-nums", !v && row.deliverable === "code" && "text-err")}>{String(v || 0)}</span>
  if (Array.isArray(v))
    return (
      <span className="inline-flex flex-wrap gap-0.5">
        {v.slice(0, 4).map((x, i) => (
          <Chip key={i}>{typeof x === "string" ? x : ((x as { id?: string }).id ?? "…")}</Chip>
        ))}
        {v.length > 4 && <span className="text-[12px] text-muted-foreground">+{v.length - 4}</span>}
      </span>
    )
  if (field === "epic" || field === "story") return <span className="id-mono">{String(v ?? "")}</span>
  return <>{v == null ? "" : String(v)}</>
}

function Pager({ total, testId }: { total: number; testId: string }) {
  const { view, setOffset, setLimit } = useApp()
  const from = total ? view.offset + 1 : 0
  const to = Math.min(view.offset + view.limit, total)
  const scrollTop = () => document.getElementById("main")?.scrollTo({ top: 0 })
  return (
    <div data-testid={testId} className="my-2 flex items-center justify-end gap-2 text-[12.5px] text-muted-foreground">
      <span data-testid="pager-range" className="tabular-nums">
        {fmt(from)}–{fmt(to)} of {fmt(total)}
      </span>
      <NativeSelect
        size="sm"
        aria-label="page size"
        data-testid="page-size"
        value={view.limit}
        onChange={(e) => setLimit(Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <NativeSelectOption key={n} value={n}>
            {n} / page
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        variant="outline"
        size="xs"
        disabled={view.offset === 0}
        onClick={() => {
          setOffset(view.offset - view.limit)
          scrollTop()
        }}
      >
        <ChevronLeft /> Prev
      </Button>
      <Button
        variant="outline"
        size="xs"
        data-testid="next-page"
        disabled={to >= total}
        onClick={() => {
          setOffset(view.offset + view.limit)
          scrollTop()
        }}
      >
        Next <ChevronRight />
      </Button>
    </div>
  )
}

function BulkBar({ kind, allOnPage, total }: { kind: Kind; allOnPage: boolean; total: number }) {
  const { meta, view, sel, selAll, setSelAll, clearSel, refreshAll } = useApp()
  const api = useApi()
  const chat = useChat()
  const schema = meta!.schemas[kind]
  const fields = Object.entries(schema).filter(([, s]) => !["objlist", "text"].includes(s.type))
  const [field, setField] = useState(fields[0]?.[0] ?? "")
  const [mode, setMode] = useState<"set" | "add" | "remove">("set")
  const [rawValue, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const s = schema[field]
  const isList = !!s && s.type.includes("list")
  // enum fields always carry one of their values
  const value = s?.values && !s.values.includes(rawValue) ? s.values[0] : rawValue
  const n = selAll ? total : sel.size

  const changeField = (f: string) => {
    setField(f)
    const fs = schema[f]
    setValue(fs?.values?.[0] ?? "")
    if (!fs?.type.includes("list")) setMode("set")
  }

  const go = async (dry: boolean) => {
    const v: unknown = isList
      ? value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : value
    const body: Parameters<typeof api.bulk>[1] = { dry_run: dry, [mode]: { [field]: v } }
    if (selAll) {
      if (view.filters.covered || view.filters.verification) {
        toast.error("bulk-by-filter can't use the story-link or verification filter; select rows instead")
        return
      }
      body.q = view.q
      body.where = { ...view.filters }
    } else body.ids = [...sel]
    setBusy(true)
    try {
      const r = await api.bulk(kind, body)
      toast.success(`${dry ? "would change" : "changed"} ${fmt(r.changed.length)} record(s)`)
      if (!dry) {
        clearSel()
        refreshAll()
      }
    } catch (e) {
      const d = e instanceof ApiError && e.details.length ? ` (${e.details.length} invalid)` : ""
      toast.error((e as Error).message + d)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="bulk-bar"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-sel px-2.5 py-1.5 text-[13px]"
    >
      <b data-testid="bulk-count" className="font-semibold tabular-nums">
        {fmt(n)} selected
      </b>
      {allOnPage && !selAll && total > sel.size && (
        <button
          type="button"
          data-testid="bulk-select-all"
          className="text-primary hover:underline"
          onClick={() => setSelAll(true)}
        >
          Select all {fmt(total)} matching
        </button>
      )}
      <NativeSelect size="sm" aria-label="field" data-testid="bulk-field" value={field} onChange={(e) => changeField(e.target.value)}>
        {fields.map(([f]) => (
          <NativeSelectOption key={f} value={f}>
            {f}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <NativeSelect
        size="sm"
        aria-label="mode"
        data-testid="bulk-mode"
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
      >
        <NativeSelectOption value="set">set to</NativeSelectOption>
        <NativeSelectOption value="add" disabled={!isList}>
          add to list
        </NativeSelectOption>
        <NativeSelectOption value="remove" disabled={!isList}>
          remove from list
        </NativeSelectOption>
      </NativeSelect>
      {s?.values ? (
        <NativeSelect size="sm" aria-label="value" data-testid="bulk-value" value={value} onChange={(e) => setValue(e.target.value)}>
          {s.values.map((x) => (
            <NativeSelectOption key={x} value={x}>
              {x}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <Input
          aria-label="value"
          data-testid="bulk-value"
          className="h-7 w-44 bg-background text-[13px]"
          placeholder={isList ? "comma, separated" : "value"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <Button size="xs" variant="outline" disabled={busy} onClick={() => go(true)} data-testid="bulk-dry">
        Dry run
      </Button>
      <Button size="xs" disabled={busy} onClick={() => go(false)} data-testid="bulk-apply">
        Apply
      </Button>
      <Button
        size="xs"
        variant="outline"
        data-testid="bulk-ask"
        onClick={() =>
          chat.ask(
            selAll
              ? viewPrompt(view.filters, view.q)
              : `Review the selected ${kind} (${[...sel].slice(0, 60).join(", ")}) and propose improvements as a changeset.`,
          )
        }
      >
        <MessageSquare /> Ask Claude
      </Button>
      <Button size="xs" variant="ghost" onClick={clearSel} data-testid="bulk-clear">
        Clear
      </Button>
    </div>
  )
}

function Th({ col, children, className }: { col?: string; children: ReactNode; className?: string }) {
  const { view, toggleSort } = useApp()
  const sorted = col && view.sort === col
  return (
    <th
      data-testid={col ? `sort-${col}` : undefined}
      onClick={col ? () => toggleSort(col) : undefined}
      aria-sort={sorted ? (view.order === "asc" ? "ascending" : "descending") : undefined}
      className={cn(
        "sticky top-0 z-[1] h-8 border-b bg-card px-2 text-left text-[12px] font-semibold whitespace-nowrap text-muted-foreground",
        col && "cursor-pointer select-none hover:text-foreground",
        NUMERIC.includes(col || "") && "text-right",
        className,
      )}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {sorted && (view.order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </span>
    </th>
  )
}

// reqforge: implements REQ-0030
export function ListView({ kind }: { kind: Kind }) {
  const app = useApp()
  const { view, sel, selAll, selectPage, toggleSel, setQuery, openDrawer, refreshAll } = app
  const api = useApi()
  const chat = useChat()
  const page = useListPage(kind, view)
  const [search, setSearch] = useState(view.q)
  const [prevQ, setPrevQ] = useState(view.q)
  if (prevQ !== view.q) {
    // the query changed elsewhere (pill removed, crumbs reset): mirror it in the box
    setPrevQ(view.q)
    setSearch(view.q)
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const total = page.data?.total ?? 0

  const rows = page.data?.items ?? []
  const pageIds = rows.map((r) => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => sel.has(id))
  const cols = COLS[kind]

  const importCsv = async (file: File) => {
    try {
      const r = await api.importCsv(kind, await file.text())
      toast.success(`imported: ${r.created.length} created, ${r.updated.length} updated`)
      refreshAll()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div data-testid="list-view" data-kind={kind}>
      <Crumbs label={kind} />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="search"
          data-testid="search"
          className="h-8 min-w-[300px] flex-1 basis-[300px] bg-card text-[13px]"
          placeholder="Search text or field:value — e.g. tags:pci status:draft|proposed parent:REQ-0012"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setQuery(search.trim())
          }}
        />
        <Button size="sm" className="h-8" onClick={() => openDrawer(kind, null)} data-testid="new-record">
          <Plus /> New
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          data-testid="export-csv"
          onClick={() => {
            window.location.href = api.exportUrl(kind, { q: view.q, ...view.filters })
          }}
        >
          <Download /> Export CSV
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => fileRef.current?.click()} data-testid="import-csv">
          <Upload /> Import CSV
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ""
            if (f) void importCsv(f)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          data-testid="ask-view"
          onClick={() => chat.ask(viewPrompt(view.filters, view.q))}
        >
          <MessageSquare /> Ask Claude about this view
        </Button>
      </div>
      {kind === "tasks" && <AgentQueuePanel />}
      {(sel.size > 0 || selAll) && <BulkBar key={kind} kind={kind} allOnPage={allOnPage} total={total} />}
      {page.error ? (
        <ErrorText testId="list-error">{(page.error as Error).message}</ErrorText>
      ) : (
        <>
          <Pager total={total} testId="pager" />
          <div className={cn("overflow-x-auto rounded-lg border bg-card", page.isFetching && "opacity-80")}>
            <table data-testid="list-table" className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th className="w-8">
                    <Checkbox
                      aria-label="select page"
                      data-testid="select-page"
                      checked={allOnPage || selAll}
                      onCheckedChange={(c) => selectPage(pageIds, c === true)}
                    />
                  </Th>
                  <Th col="id">id</Th>
                  {cols.map((c) => (
                    <Th key={c} col={NO_SORT.includes(c) ? undefined : c} className={HIDE_MOBILE.includes(c) ? "hidden md:table-cell" : undefined}>
                      {c in LABEL ? LABEL[c] : c}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const checked = sel.has(r.id) || selAll
                  return (
                    <tr
                      key={r.id}
                      data-testid="row"
                      data-id={r.id}
                      data-version={r.version}
                      data-selected={checked ? "true" : undefined}
                      onClick={() => openDrawer(kind, r.id)}
                      className={cn(
                        "cursor-pointer border-b last:border-b-0 hover:bg-muted/60",
                        checked && "bg-sel hover:bg-sel",
                      )}
                    >
                      <td className="px-2 py-1.5 align-top" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`select ${r.id}`}
                          data-testid="row-check"
                          checked={checked}
                          onCheckedChange={(c) => toggleSel(r.id, c === true)}
                        />
                      </td>
                      <td className="id-mono px-2 py-1.5 align-top">{r.id}</td>
                      {cols.map((c) => (
                        <td
                          key={c}
                          data-col={c}
                          className={cn(
                            "px-2 py-1.5 align-top",
                            HIDE_MOBILE.includes(c) && "hidden md:table-cell",
                            NUMERIC.includes(c) && "text-right",
                            c === "title" && "min-w-[200px]",
                          )}
                        >
                          <Cell kind={kind} row={r} field={c} />
                        </td>
                      ))}
                    </tr>
                  )
                })}
                {!rows.length && !page.isLoading && (
                  <tr>
                    <td colSpan={cols.length + 2} className="px-2 py-6 text-center text-muted-foreground">
                      No {kind} match this view.
                    </td>
                  </tr>
                )}
                {page.isLoading && (
                  <tr>
                    <td colSpan={cols.length + 2} className="px-2 py-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > view.limit && <Pager total={total} testId="pager-bottom" />}
        </>
      )}
    </div>
  )
}
