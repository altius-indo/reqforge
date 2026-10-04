import { useState, type ReactNode } from "react"
import { ArrowLeft, GitBranch, Menu, MessageSquare, X } from "lucide-react"
import { toast } from "sonner"
import { getToken, setToken } from "@/api/client"
import type { Tab } from "@/api/types"
import { ProjectSwitcher } from "@/components/ProjectSwitcher"
import { HelpButton } from "@/components/help/HelpButton"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { useApi, useProjects } from "@/state/project"
import { usePendingCount } from "@/state/queries"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"

const TAB_LABELS: [Tab, string][] = [
  ["requirements", "Requirements"],
  ["epics", "Epics"],
  ["stories", "Stories"],
  ["tasks", "Tasks"],
  ["components", "Components"],
  ["trace", "Traceability"],
  ["verification", "Verification"],
  ["lint", "Lint"],
  ["changes", "Changes"],
  ["design", "Design"],
]

/** API token input, shown after a 401. */
function TokenForm() {
  const { showToken, setShowToken } = useProjects()
  const qc = useQueryClient()
  const [token, setTokenDraft] = useState(getToken)
  if (!showToken) return null
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        setToken(token)
        setShowToken(false)
        void qc.invalidateQueries()
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
  )
}

/**
 * Brand + project switcher + Help; the app header and the project-less pages share it, so the
 * Help button is on every view. `helpContext` picks the help section (the active tab, or `projects`).
 */
export function TopBar({ leading, children, helpContext }: { leading?: ReactNode; children?: ReactNode; helpContext: string }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card px-3 py-2">
      {leading}
      <div className="flex items-center gap-1.5">
        <h1 className="text-[15px] font-bold tracking-tight">reqforge</h1>
        <ProjectSwitcher />
      </div>
      {children}
      <HelpButton context={helpContext} />
    </header>
  )
}

/** Header of the projects page and of the onboarding screen. */
export function ProjectsHeader() {
  const { activeProject, open, route } = useProjects()
  return (
    <TopBar helpContext="projects">
      <span className="flex-1" />
      <TokenForm />
      {activeProject && route === "projects" && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => open(activeProject.key)}
          data-testid="back-to-project"
        >
          <ArrowLeft /> Back to {activeProject.key}
        </Button>
      )}
    </TopBar>
  )
}

export function Header() {
  const { view, setTab, setSideOpen, listKind } = useApp()
  const api = useApi()
  const chat = useChat()
  const pending = usePendingCount()
  const [syncing, setSyncing] = useState(false)

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

  return (
    <TopBar
      helpContext={view.tab}
      leading={
        listKind || view.tab === "trace" || view.tab === "verification" || view.tab === "changes" || view.tab === "design" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="open sidebar"
            onClick={() => setSideOpen(true)}
          >
            <Menu />
          </Button>
        ) : null
      }
    >
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
      <TokenForm />
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
    </TopBar>
  )
}
