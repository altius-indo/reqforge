/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { HelpPanel } from "@/components/help/HelpPanel"
import { preloadGuides } from "@/components/help/load"

/**
 * The in-app help panel (REQ-0048). One panel for the whole app, opened from the header's Help
 * button (every view) or the chat panel's help button. Opening it changes no app state: it is a
 * modal sheet over the current view, so the route, filters, selection and drawer stay as they are.
 * The Markdown guides are a separate chunk, prefetched when the app is idle (components/help/load.ts).
 */

interface HelpCtx {
  open: boolean
  /** open the panel on the section for `context` (a tab id, `projects` or `chat`); focus returns to `trigger` */
  openHelp: (context: string, trigger?: HTMLElement | null) => void
}

const Ctx = createContext<HelpCtx | null>(null)

// reqforge: implements REQ-0048
export function HelpProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ open: false, context: "", nonce: 0 })
  const [query, setQuery] = useState("")
  const returnTo = useRef<HTMLElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const openHelp = useCallback((context: string, trigger?: HTMLElement | null) => {
    returnTo.current = trigger ?? (document.activeElement as HTMLElement | null)
    setQuery("")
    setState((s) => ({ open: true, context, nonce: s.nonce + 1 }))
  }, [])
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), [])

  // fetch the guides chunk once the app is idle, so the first open is instant
  useEffect(() => {
    const ric = window.requestIdleCallback
    if (ric) {
      const h = ric(preloadGuides, { timeout: 5000 })
      return () => window.cancelIdleCallback(h)
    }
    const t = window.setTimeout(preloadGuides, 2000)
    return () => window.clearTimeout(t)
  }, [])

  // Esc closes the help panel only. Window capture runs before every document listener: the record
  // drawer's own Esc handling (a Radix layer registered earlier) and App's Esc-closes-drawer listener.
  useEffect(() => {
    if (!state.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return
      e.stopPropagation()
      close()
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [state.open, close])

  const value = useMemo(() => ({ open: state.open, openHelp }), [state.open, openHelp])
  return (
    <Ctx.Provider value={value}>
      {children}
      <Sheet open={state.open} onOpenChange={(o) => !o && close()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          data-testid="help-panel"
          data-context={state.context}
          className="gap-0 p-0 data-[side=right]:w-[min(680px,100vw)] data-[side=right]:sm:max-w-[680px]"
          // a light, unblurred overlay: the view stays readable next to the guide
          overlayClassName="bg-black/10 supports-backdrop-filter:backdrop-blur-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            searchRef.current?.focus()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            const el = returnTo.current
            if (el && el.isConnected) el.focus()
          }}
        >
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <SheetTitle className="text-[14px] font-semibold">Help</SheetTitle>
            <SheetDescription className="sr-only">How-to guides for each area of reqforge</SheetDescription>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                type="search"
                aria-label="search help"
                data-testid="help-search"
                placeholder="Search help…"
                className="h-8 pl-7 text-[13px]"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="close help" data-testid="help-close" onClick={close}>
              <X />
            </Button>
          </div>
          <HelpPanel key={state.nonce} context={state.context} query={query} />
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  )
}

export function useHelp(): HelpCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useHelp outside HelpProvider")
  return c
}
