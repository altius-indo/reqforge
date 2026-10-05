/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { useChat } from "@/state/chat"
import { loadPanels, savePanels, type PanelLayout } from "@/lib/storage"

/**
 * Widths and collapsed state of the sidebar and the chat panel on wide screens (REQ-0064). The stored widths are
 * what the user chose; the effective widths shrink (chat first, then sidebar) when the window is too narrow to keep
 * the main area at MAIN_MIN. Below the lg breakpoint none of this applies: the sidebar is a sheet, the chat full-screen.
 */
export const SIDE = { min: 200, max: 480, def: 270 }
export const CHAT = { min: 320, max: 720, def: 410 }
export const MAIN_MIN = 480
/** width of the collapsed sidebar rail */
export const RAIL = 40
export const STEP = 16

const DEFAULTS: PanelLayout = { side: SIDE.def, chat: CHAT.def, sideCollapsed: false }
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)))

const subscribe = (cb: () => void) => {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}
const viewportWidth = () => document.documentElement.clientWidth

interface PanelsCtx {
  /** effective widths in px (the sidebar's is RAIL when collapsed, the chat's 0 when closed) */
  sideWidth: number
  chatWidth: number
  /** the largest width each panel can take now without squeezing the main area below MAIN_MIN */
  sideMax: number
  chatMax: number
  sideCollapsed: boolean
  setSideWidth: (w: number) => void
  setChatWidth: (w: number) => void
  setSideCollapsed: (b: boolean) => void
  resetSide: () => void
  resetChat: () => void
}

const Ctx = createContext<PanelsCtx | null>(null)

// reqforge: implements REQ-0064
export function PanelsProvider({ children }: { children: ReactNode }) {
  const chat = useChat()
  const vw = useSyncExternalStore(subscribe, viewportWidth)
  const [layout, setLayout] = useState<PanelLayout>(() => loadPanels(DEFAULTS))

  useEffect(() => savePanels(layout), [layout])

  const avail = vw - MAIN_MIN
  let side = layout.sideCollapsed ? RAIL : clamp(layout.side, SIDE.min, SIDE.max)
  let chatW = chat.open ? clamp(layout.chat, CHAT.min, CHAT.max) : 0
  if (chat.open && side + chatW > avail) chatW = Math.max(CHAT.min, avail - side)
  if (!layout.sideCollapsed && side + chatW > avail) side = Math.max(SIDE.min, avail - chatW)
  const sideMax = clamp(avail - chatW, SIDE.min, SIDE.max)
  const chatMax = clamp(avail - side, CHAT.min, CHAT.max)

  const setSideWidth = useCallback((w: number) => setLayout((l) => ({ ...l, side: clamp(w, SIDE.min, sideMax) })), [sideMax])
  const setChatWidth = useCallback((w: number) => setLayout((l) => ({ ...l, chat: clamp(w, CHAT.min, chatMax) })), [chatMax])
  const setSideCollapsed = useCallback((b: boolean) => setLayout((l) => ({ ...l, sideCollapsed: b })), [])
  const resetSide = useCallback(() => setLayout((l) => ({ ...l, side: SIDE.def })), [])
  const resetChat = useCallback(() => setLayout((l) => ({ ...l, chat: CHAT.def })), [])

  const value = useMemo<PanelsCtx>(
    () => ({ sideWidth: side, chatWidth: chatW, sideMax, chatMax, sideCollapsed: layout.sideCollapsed,
      setSideWidth, setChatWidth, setSideCollapsed, resetSide, resetChat }),
    [side, chatW, sideMax, chatMax, layout.sideCollapsed, setSideWidth, setChatWidth, setSideCollapsed, resetSide, resetChat],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePanels() {
  const c = useContext(Ctx)
  if (!c) throw new Error("usePanels outside PanelsProvider")
  return c
}
