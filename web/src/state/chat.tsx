/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api, streamChat } from "@/api/client"
import { KINDS, type ChatContextPayload, type Kind } from "@/api/types"
import { ls } from "@/lib/storage"
import { fmt, randomId } from "@/lib/format"
import { useApp } from "./app"
import { useListPage } from "./queries"

export interface ToolItem {
  text: string
  sub: boolean
}

export type ChatEntry =
  | { k: string; role: "user" | "sys" | "error"; text: string }
  | { k: string; role: "asst"; text: string; answered?: number[] }
  | { k: string; role: "tools"; items: ToolItem[]; live: boolean }
  | { k: string; role: "changeset"; id: string }

const LOG_KEY = "reqforge.chat.log"
const SESSION_KEY = "reqforge.chat.session"
const OPEN_KEY = "reqforge.chat.open"
const MAX_LOG = 200

function loadLog(): ChatEntry[] {
  const raw = ls.get<unknown[]>(LOG_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && "role" in e)
    .map((e) => ({ ...e, k: typeof e.k === "string" ? e.k : randomId(), ...(e.role === "tools" ? { live: false } : {}) }) as ChatEntry)
}

interface SendOpts {
  noCtx?: boolean
}

interface ChatCtx {
  open: boolean
  setOpen: (b: boolean) => void
  log: ChatEntry[]
  busy: boolean
  sessionId: string | null
  draft: string
  setDraft: (s: string) => void
  focusNonce: number
  useCtx: boolean
  setUseCtx: (b: boolean) => void
  contextPayload: ChatContextPayload | null
  contextSummary: string
  lastCost: number | null
  send: (text: string, opts?: SendOpts) => Promise<void>
  stop: () => void
  reset: () => void
  /** open the chat with a pre-filled prompt (does not send) */
  ask: (text: string) => void
  markAnswered: (k: string, part: number) => void
}

const Ctx = createContext<ChatCtx | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const app = useApp()
  const qc = useQueryClient()
  const [open, setOpenState] = useState(() => ls.get<boolean>(OPEN_KEY, false))
  const [log, setLog] = useState<ChatEntry[]>(loadLog)
  const [sessionId, setSessionId] = useState<string | null>(() => ls.get<string | null>(SESSION_KEY, null))
  const sessionRef = useRef(sessionId)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const chatIdRef = useRef<string | null>(null)
  const [draft, setDraft] = useState("")
  const [focusNonce, setFocusNonce] = useState(0)
  const [useCtx, setUseCtx] = useState(true)
  const [lastCost, setLastCost] = useState<number | null>(null)

  useEffect(() => {
    ls.set(LOG_KEY, log.slice(-MAX_LOG))
  }, [log])

  const setSession = useCallback((id: string | null) => {
    sessionRef.current = id
    setSessionId(id)
    ls.set(SESSION_KEY, id)
  }, [])

  const setOpen = useCallback((b: boolean) => {
    setOpenState(b)
    ls.set(OPEN_KEY, b)
    if (b) setFocusNonce((n) => n + 1)
  }, [])

  const { view, sel, selAll } = app
  // same query key as the list view, so this reads the cached page rather than refetching
  const listKind = (KINDS as string[]).includes(view.tab) ? (view.tab as Kind) : null
  const total = useListPage(listKind, view).data?.total ?? 0
  const contextPayload = useMemo<ChatContextPayload | null>(() => {
    if (!useCtx) return null
    const v: Record<string, string> = { tab: view.tab, ...view.filters }
    if (view.q) v.query = view.q
    return { view: v, selected: [...sel].slice(0, 200), selected_total: selAll ? total : sel.size }
  }, [useCtx, view.tab, view.filters, view.q, sel, selAll, total])

  const contextSummary = contextPayload
    ? ([contextPayload.view.type, contextPayload.view.category].filter(Boolean).join(" › ") || contextPayload.view.tab) +
      (contextPayload.selected_total ? ` · ${fmt(contextPayload.selected_total)} selected` : "")
    : ""
  const ctxRef = useRef(contextPayload)
  useEffect(() => {
    ctxRef.current = contextPayload
  }, [contextPayload])

  const send = useCallback(
    async (raw: string, opts: SendOpts = {}) => {
      const text = (raw || "").trim()
      if (!text || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setDraft("")
      const chatId = randomId()
      chatIdRef.current = chatId
      setLog((l) => [...l, { k: randomId(), role: "user", text }])
      let toolsKey: string | null = null
      const push = (e: ChatEntry) => setLog((l) => [...l, e])
      const endTools = () => {
        if (!toolsKey) return
        const k = toolsKey
        toolsKey = null
        setLog((l) => l.map((e) => (e.k === k && e.role === "tools" ? { ...e, live: false } : e)))
      }
      try {
        for await (const ev of streamChat({
          chat_id: chatId,
          message: text,
          session_id: sessionRef.current,
          context: opts.noCtx ? null : ctxRef.current,
        })) {
          switch (ev.type) {
            case "session":
              setSession(ev.session_id)
              break
            case "tool": {
              const item = { text: ev.text, sub: !!ev.sub }
              if (!toolsKey) {
                toolsKey = randomId()
                push({ k: toolsKey, role: "tools", items: [item], live: true })
              } else {
                const k = toolsKey
                setLog((l) => l.map((e) => (e.k === k && e.role === "tools" ? { ...e, items: [...e.items, item] } : e)))
              }
              break
            }
            case "text":
              endTools()
              push({ k: randomId(), role: "asst", text: ev.text })
              break
            case "changeset":
              endTools()
              push({ k: randomId(), role: "changeset", id: ev.id })
              void qc.invalidateQueries({ queryKey: ["changesets"] })
              break
            case "warning":
              push({ k: randomId(), role: "sys", text: ev.text })
              break
            case "error":
              endTools()
              push({ k: randomId(), role: "error", text: ev.text })
              break
            case "done":
              if (ev.session_id) setSession(ev.session_id)
              if (ev.is_error && ev.result) push({ k: randomId(), role: "error", text: ev.result })
              setLastCost(ev.cost ?? null)
              break
          }
        }
      } catch (e) {
        push({ k: randomId(), role: "error", text: e instanceof Error ? e.message : String(e) })
      } finally {
        endTools()
        busyRef.current = false
        setBusy(false)
        void qc.invalidateQueries({ queryKey: ["changesets"] })
      }
    },
    [qc, setSession],
  )

  const stop = useCallback(() => {
    if (chatIdRef.current) api.chatCancel(chatIdRef.current).catch(() => {})
  }, [])

  const reset = useCallback(() => {
    setSession(null)
    setLog([])
  }, [setSession])

  const ask = useCallback(
    (text: string) => {
      setDraft(text)
      setOpen(true)
    },
    [setOpen],
  )

  const markAnswered = useCallback((k: string, part: number) => {
    setLog((l) => l.map((e) => (e.k === k && e.role === "asst" ? { ...e, answered: [...(e.answered || []), part] } : e)))
  }, [])

  const value = useMemo<ChatCtx>(
    () => ({
      open,
      setOpen,
      log,
      busy,
      sessionId,
      draft,
      setDraft,
      focusNonce,
      useCtx,
      setUseCtx,
      contextPayload,
      contextSummary,
      lastCost,
      send,
      stop,
      reset,
      ask,
      markAnswered,
    }),
    [open, setOpen, log, busy, sessionId, draft, focusNonce, useCtx, contextPayload, contextSummary, lastCost, send,
      stop, reset, ask, markAnswered],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChat(): ChatCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useChat outside ChatProvider")
  return c
}
