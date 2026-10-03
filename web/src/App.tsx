import { useEffect } from "react"
import { Header } from "@/components/Header"
import { RecordDrawer } from "@/components/RecordDrawer"
import { Sidebar } from "@/components/Sidebar"
import { ChatPanel } from "@/components/chat/ChatPanel"
import { ErrorText } from "@/components/common"
import { useApp } from "@/state/app"
import { useChat } from "@/state/chat"
import { ChangesView } from "@/views/ChangesView"
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
  if (view.tab === "lint") return <LintView />
  if (view.tab === "changes") return <ChangesView />
  if ((KINDS as string[]).includes(view.tab)) return <ListView key={view.tab} kind={view.tab as Kind} />
  return null
}

export default function App() {
  const { closeDrawer } = useApp()
  const chat = useChat()

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
      <div
        data-testid="app-grid"
        data-chat={chat.open ? "open" : "closed"}
        className={cn(
          "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)]",
          chat.open ? "lg:grid-cols-[270px_minmax(0,1fr)_410px]" : "lg:grid-cols-[270px_minmax(0,1fr)]",
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
