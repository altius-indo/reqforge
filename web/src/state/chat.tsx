/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { streamChat } from "@/api/client"
import { KINDS, type ChatContextPayload, type HistoryGap, type Kind, type PendingGap } from "@/api/types"
import { ls, pkey } from "@/lib/storage"
import { fmt, randomId } from "@/lib/format"
import { useApp } from "./app"
import { useApi } from "./project"
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

// chat log + session are per project (reqforge.chat.log.<KEY>, reqforge.chat.session.<KEY>);
// whether the panel is open is global
const OPEN_KEY = "reqforge.chat.open"
const MAX_LOG = 200

/** Sent once per session, on New or on closing the panel, after a changeset was applied in it (REQ-0059#AC4). */
export const WRAP_UP_MESSAGE =
  "Before we stop: for each task whose state changed in this session, propose an updated next_action (one concrete step naming a file path, command or record id, at most 280 characters, with next_action_set today). Also propose a snapshot op updating the Next item of state/HOT.md and its Last reconciled date. Put everything in one changeset; simulate it first. If nothing needs to change, say so and propose nothing."

/** Per-session wrap-up flags, persisted with the session (reqforge.chat.wrap.<KEY>). */
interface WrapFlags {
  applied: boolean
  wrapUpAsked: boolean
}
const NO_FLAGS: WrapFlags = { applied: false, wrapUpAsked: false }

function loadWrap(key: string): WrapFlags {
  const raw = ls.get<Partial<WrapFlags> | null>(key, null)
  return { applied: raw?.applied === true, wrapUpAsked: raw?.wrapUpAsked === true }
}

/** Resolves once no turn is streaming (or the provider unmounted). */
async function whenIdle(busy: { current: boolean }, alive: { current: boolean }) {
  while (busy.current && alive.current) await new Promise((r) => setTimeout(r, 100))
}

function loadLog(key: string): ChatEntry[] {
  const raw = ls.get<unknown[]>(key, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && "role" in e)
    .map((e) => ({ ...e, k: typeof e.k === "string" ? e.k : randomId(), ...(e.role === "tools" ? { live: false } : {}) }) as ChatEntry)
}

/** the gap shown at session start: pending until the user records it */
export interface GapPrompt {
  gap: PendingGap
  recorded: HistoryGap | null
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
  /** start a fresh conversation, after the wrap-up turn when one is due */
  reset: () => Promise<void>
  /** New was clicked and the wrap-up turn is running before the fresh session starts */
  wrappingUp: boolean
  /** a changeset was applied while this session was open */
  markApplied: () => void
  /** open the chat with a pre-filled prompt (does not send) */
  ask: (text: string) => void
  markAnswered: (k: string, part: number) => void
  /** a gap of 14 days or more since the last session, shown when a new session starts (REQ-0062#AC4) */
  gap: GapPrompt | null
  recordGap: (reason: string) => Promise<void>
  dismissGap: () => void
}

const Ctx = createContext<ChatCtx | null>(null)

/**
 * Chat for the active project. Mounted under the project-keyed AppProvider, so a switch unmounts
 * it: the in-flight stream is aborted and late events are ignored, never rendered into another
 * project's log.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const app = useApp()
  const api = useApi()
  const project = api.key
  const LOG_KEY = pkey("chat.log", project)
  const SESSION_KEY = pkey("chat.session", project)
  const WRAP_KEY = pkey("chat.wrap", project)
  const qc = useQueryClient()
  const [open, setOpenState] = useState(() => ls.get<boolean>(OPEN_KEY, false))
  const [log, setLog] = useState<ChatEntry[]>(() => loadLog(LOG_KEY))
  const [sessionId, setSessionId] = useState<string | null>(() => ls.get<string | null>(SESSION_KEY, null))
  const aliveRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      abortRef.current?.abort()
    }
  }, [])
  const sessionRef = useRef(sessionId)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const chatIdRef = useRef<string | null>(null)
  const [draft, setDraft] = useState("")
  const [focusNonce, setFocusNonce] = useState(0)
  const [useCtx, setUseCtx] = useState(true)
  const [lastCost, setLastCost] = useState<number | null>(null)
  // REQ-0059#AC4: whether a changeset was applied in this session, and whether the wrap-up was sent
  const [savedWrap] = useState(() => loadWrap(WRAP_KEY))
  const wrapRef = useRef<WrapFlags>(savedWrap)
  const [wrappingUp, setWrappingUp] = useState(false)
  const [gap, setGap] = useState<GapPrompt | null>(null)
  // the gap (by its start) the user closed without recording: the server records it with the session
  const dismissedRef = useRef<string | null>(null)
  const showGap = useCallback((g: PendingGap | null | undefined) => {
    if (!aliveRef.current || !g || dismissedRef.current === g.from) return
    // a gap already recorded stays as recorded; a pending one picks up a pause made since it was shown
    setGap((cur) => (cur?.recorded && cur.gap.from === g.from ? cur : { gap: g, recorded: null }))
  }, [])

  // a new session is about to start: has the project been quiet for 14 days or more?
  useEffect(() => {
    if (!open || sessionId) return
    let live = true
    api
      .pendingGap()
      .then((r) => live && showGap(r.gap))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [open, sessionId, api, showGap])

  useEffect(() => {
    ls.set(LOG_KEY, log.slice(-MAX_LOG))
  }, [log, LOG_KEY])

  const setSession = useCallback(
    (id: string | null) => {
      if (!aliveRef.current) return
      sessionRef.current = id
      setSessionId(id)
      ls.set(SESSION_KEY, id)
    },
    [SESSION_KEY],
  )

  const showPanel = useCallback((b: boolean) => {
    setOpenState(b)
    ls.set(OPEN_KEY, b)
    if (b) setFocusNonce((n) => n + 1)
  }, [])

  const saveWrap = useCallback(
    (f: WrapFlags) => {
      wrapRef.current = f
      ls.set(WRAP_KEY, f)
    },
    [WRAP_KEY],
  )

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
      const ctl = new AbortController()
      abortRef.current = ctl
      setLog((l) => [...l, { k: randomId(), role: "user", text }])
      let toolsKey: string | null = null
      const push = (e: ChatEntry) => {
        if (aliveRef.current) setLog((l) => [...l, e])
      }
      const endTools = () => {
        if (!toolsKey) return
        const k = toolsKey
        toolsKey = null
        setLog((l) => l.map((e) => (e.k === k && e.role === "tools" ? { ...e, live: false } : e)))
      }
      try {
        for await (const ev of streamChat(
          project,
          {
            chat_id: chatId,
            message: text,
            session_id: sessionRef.current,
            context: opts.noCtx ? null : ctxRef.current,
          },
          ctl.signal,
        )) {
          // switched to another project: drop whatever is still arriving
          if (!aliveRef.current) break
          switch (ev.type) {
            case "session":
              setSession(ev.session_id)
              break
            case "gap":
              showGap(ev.gap)
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
              void qc.invalidateQueries({ queryKey: ["p", project, "changesets"] })
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
        if (!ctl.signal.aborted) push({ k: randomId(), role: "error", text: e instanceof Error ? e.message : String(e) })
      } finally {
        if (abortRef.current === ctl) abortRef.current = null
        busyRef.current = false
        if (aliveRef.current) {
          endTools()
          setBusy(false)
        }
        void qc.invalidateQueries({ queryKey: ["p", project, "changesets"] })
      }
    },
    [qc, setSession, showGap, project],
  )

  const stop = useCallback(() => {
    if (chatIdRef.current) api.chatCancel(chatIdRef.current).catch(() => {})
  }, [api])

  const markApplied = useCallback(() => {
    if (sessionRef.current && !wrapRef.current.applied) saveWrap({ ...wrapRef.current, applied: true })
  }, [saveWrap])

  /**
   * Ask the chat agent, once per session, to propose updated next actions and a snapshot Next.
   * Only after a changeset was applied in the session; the flag is set before sending, so closing
   * the panel again (or New) never asks twice. Waits for a turn in progress (the "I applied" follow-up).
   */
  // reqforge: implements REQ-0059
  const wrapUp = useCallback(async () => {
    const f = wrapRef.current
    if (!f.applied || f.wrapUpAsked || !sessionRef.current) return
    saveWrap({ ...f, wrapUpAsked: true })
    await whenIdle(busyRef, aliveRef)
    if (aliveRef.current) await send(WRAP_UP_MESSAGE, { noCtx: true })
  }, [saveWrap, send])

  // closing the panel: the wrap-up turn keeps streaming here; its changeset card waits in the log
  const setOpen = useCallback(
    (b: boolean) => {
      showPanel(b)
      if (!b) void wrapUp()
    },
    [showPanel, wrapUp],
  )

  // New: wrap up the current session first, then end it (its metadata goes to the history) and start a fresh one
  const reset = useCallback(async () => {
    setWrappingUp(true)
    // send() reports its own errors in the log; it never rejects
    await wrapUp()
    if (!aliveRef.current) return
    const sid = sessionRef.current
    if (sid) api.chatEnd(sid).catch(() => {})
    setSession(null)
    setLog([])
    setGap((g) => (g?.recorded ? null : g))
    saveWrap(NO_FLAGS)
    setWrappingUp(false)
  }, [api, setSession, saveWrap, wrapUp])

  // reqforge: implements REQ-0062
  const recordGap = useCallback(
    async (reason: string) => {
      const rec = await api.recordGap(reason)
      if (aliveRef.current) setGap((g) => (g ? { ...g, recorded: rec } : g))
    },
    [api],
  )

  const dismissGap = useCallback(() => {
    setGap((g) => {
      if (g) dismissedRef.current = g.gap.from
      return null
    })
  }, [])

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
      wrappingUp,
      markApplied,
      ask,
      markAnswered,
      gap,
      recordGap,
      dismissGap,
    }),
    [open, setOpen, log, busy, sessionId, draft, focusNonce, useCtx, contextPayload, contextSummary, lastCost, send,
      stop, reset, wrappingUp, markApplied, ask, markAnswered, gap, recordGap, dismissGap],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChat(): ChatCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useChat outside ChatProvider")
  return c
}
