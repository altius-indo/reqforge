import { lazy, Suspense, useEffect, type CSSProperties, type ReactNode } from "react"
import { Header, ProjectsHeader } from "@/components/Header"
import { RecordDrawer } from "@/components/RecordDrawer"
import { Sidebar } from "@/components/Sidebar"
import { ChatPanel } from "@/components/chat/ChatPanel"
import { ErrorText } from "@/components/common"
import { AppProvider, useApp } from "@/state/app"
import { ChatProvider, useChat } from "@/state/chat"
import { HelpProvider } from "@/state/help"
import { PanelsProvider, usePanels } from "@/state/panels"
import { useProjects } from "@/state/project"
import { ChangesView } from "@/views/ChangesView"
import { DecisionsView } from "@/views/DecisionsView"
import { DesignView } from "@/views/DesignView"
import { LintView } from "@/views/LintView"
import { ListView } from "@/views/ListView"
import { TraceView } from "@/views/TraceView"
import { KINDS, type Kind } from "@/api/types"
import { cn } from "@/lib/utils"

function MainView() {
  const { view, meta, metaError } = useApp()
  if (metaError) return <ErrorText testId="meta-error">{metaError.message}</ErrorText>
  if (!meta) return <p className="text-muted-foreground">Loading…</p>
  if (view.tab === "trace") return <TraceView />
  if (view.tab === "verification")
    return (
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <VerificationView />
      </Suspense>
    )
  if (view.tab === "lint") return <LintView />
  if (view.tab === "changes") return <ChangesView />
  if (view.tab === "design") return <DesignView />
  if (view.tab === "decisions") return <DecisionsView />
  if ((KINDS as string[]).includes(view.tab)) return <ListView key={view.tab} kind={view.tab as Kind} />
  return null
}

// the verification dashboard (scan, ingest, impact) is code-split too
const VerificationView = lazy(() => import("@/views/VerificationView").then((m) => ({ default: m.VerificationView })))

// project management UI is code-split: it is not needed to work inside a project
const ProjectsView = lazy(() => import("@/views/ProjectsView").then((m) => ({ default: m.ProjectsView })))
const Onboarding = lazy(() => import("@/views/ProjectsView").then((m) => ({ default: m.Onboarding })))
const CreateProjectDialog = lazy(() =>
  import("@/components/ProjectDialogs").then((m) => ({ default: m.CreateProjectDialog })),
)

// reqforge: implements REQ-0064
function ProjectApp() {
  const { closeDrawer } = useApp()
  const chat = useChat()
  const panels = usePanels()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [closeDrawer])

  return (
    <div className="flex h-full flex-col">
      <Header />
      {/* column widths on lg come from the panel layout (state/panels.tsx); below lg the panels are overlays */}
      <div
        data-testid="app-grid"
        data-chat={chat.open ? "open" : "closed"}
        data-sidebar={panels.sideCollapsed ? "collapsed" : "open"}
        style={{ "--side-w": `${panels.sideWidth}px`, "--chat-w": `${panels.chatWidth}px` } as CSSProperties}
        className={cn(
          "relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]",
          chat.open ? "lg:grid-cols-[var(--side-w)_minmax(0,1fr)_var(--chat-w)]" : "lg:grid-cols-[var(--side-w)_minmax(0,1fr)]",
        )}
      >
        <Sidebar />
        <main id="main" data-testid="main" className="min-w-0 overflow-auto px-4 py-3">
          <MainView />
        </main>
        {chat.open && <ChatPanel />}
      </div>
      <RecordDrawer />
    </div>
  )
}

/** Pages without an active project's app: the projects page, onboarding, load errors. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <ProjectsHeader />
      <main id="main" data-testid="main" className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>{children}</Suspense>
      </main>
    </div>
  )
}

export default function App() {
  const p = useProjects()
  let body: ReactNode
  if (!p.list)
    body = (
      <Shell>
        {p.error ? (
          <ErrorText testId="projects-error">{p.error.message}</ErrorText>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </Shell>
    )
  else if (p.route === "projects") body = <Shell><ProjectsView /></Shell>
  else if (!p.active) body = <Shell><Onboarding /></Shell>
  else
    // keyed by project: switching remounts view state, chat and drawer from scratch
    body = (
      <AppProvider key={p.active}>
        <ChatProvider>
          <PanelsProvider>
            <ProjectApp />
          </PanelsProvider>
        </ChatProvider>
      </AppProvider>
    )
  return (
    <HelpProvider>
      {body}
      {p.createMode && (
        <Suspense fallback={null}>
          <CreateProjectDialog />
        </Suspense>
      )}
    </HelpProvider>
  )
}
