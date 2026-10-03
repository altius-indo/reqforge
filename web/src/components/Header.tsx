import { useEffect, useState } from "react"
import { GitBranch, Menu, MessageSquare, X } from "lucide-react"
import { toast } from "sonner"
import { api, getToken, onUnauthorized, setToken } from "@/api/client"
import type { Tab } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { usePendingCount } from "@/state/queries"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"

const TAB_LABELS: [Tab, string][] = [
  ["requirements", "Requirements"],
  ["epics", "Epics"],
  ["stories", "Stories"],
  ["tasks", "Tasks"],
  ["trace", "Traceability"],
  ["lint", "Lint"],
  ["changes", "Changes"],
]

export function Header() {
  const { meta, view, setTab, setSideOpen, showToken, setShowToken, listKind } = useApp()
  const chat = useChat()
  const pending = usePendingCount()
  const qc = useQueryClient()
  const [token, setTokenDraft] = useState(getToken)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => onUnauthorized(() => setShowToken(true)), [setShowToken])

  const sync = async () => {
    setSyncing(true)
    try {
      const r = await api.sync()
      if (r.ok) toast.success(r.pushed ? "pushed to the remote" : r.note || "committed")
      else toast.error(`sync failed: ${r.error}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const saveToken = () => {
    setToken(token)
    setShowToken(false)
    void qc.invalidateQueries()
  }

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card px-3 py-2">
      {listKind || view.tab === "trace" || view.tab === "changes" ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="open sidebar"
          onClick={() => setSideOpen(true)}
        >
          <Menu />
        </Button>
      ) : null}
      <div className="flex items-baseline gap-2">
        <h1 className="text-[15px] font-bold tracking-tight">reqforge</h1>
        {meta && (
          <span data-testid="project" className="hidden text-[13px] text-muted-foreground sm:inline">
            {meta.config.name} <span className="id-mono">({meta.config.key})</span>
          </span>
        )}
      </div>
      <nav data-testid="tabs" className="flex flex-wrap gap-0.5">
        {TAB_LABELS.map(([t, label]) => (
          <button
            key={t}
            type="button"
            data-testid={`tab-${t}`}
            aria-current={view.tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              view.tab === t && "bg-muted font-semibold text-foreground",
            )}
          >
            {label}
            {t === "changes" && !!pending.data && (
              <span
                data-testid="pending-badge"
                className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10.5px] font-semibold text-primary-foreground"
              >
                {pending.data}
              </span>
            )}
          </button>
        ))}
      </nav>
      <span className="flex-1" />
      {showToken && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            saveToken()
          }}
        >
          <Input
            data-testid="token-input"
            type="password"
            placeholder="API token"
            value={token}
            onChange={(e) => setTokenDraft(e.target.value)}
            className="h-7 w-36 text-[13px]"
            autoFocus
          />
          <Button type="submit" size="xs" variant="outline">
            Save
          </Button>
        </form>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-7"
        title="commit, pull --rebase, push"
        onClick={sync}
        disabled={syncing}
        data-testid="sync"
      >
        <GitBranch /> Sync
      </Button>
      <Button
        size="sm"
        className="h-7"
        variant={chat.open ? "secondary" : "default"}
        onClick={() => chat.setOpen(!chat.open)}
        data-testid="chat-toggle"
      >
        {chat.open ? <X /> : <MessageSquare />} Chat with Claude
      </Button>
    </header>
  )
}
