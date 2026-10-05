import { useEffect, useRef } from "react"
import { CircleHelp, FileText, RotateCcw, Send, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { useChat } from "@/state/chat"
import { useHelp } from "@/state/help"
import { useChatStatus, useSnapshot } from "@/state/queries"
import { cn } from "@/lib/utils"
import { ChatMessage } from "./ChatMessage"
import { GapPrompt } from "./GapPrompt"

/** What "Ask Claude to draft one" puts in the chat input. */
export const DRAFT_SNAPSHOT_PROMPT =
  "Draft a project snapshot (state/HOT.md) from the current requirements, stories and tasks: " +
  "## Now, ## Next (exactly one item) and ## Watch, plus 'Last reconciled: <today>'. Propose it as a changeset with a snapshot op."

/** Shown while the project has no state/HOT.md; sessions still start normally (REQ-0058#AC4). */
// reqforge: implements REQ-0058
function NoSnapshot({ onDraft }: { onDraft: () => void }) {
  return (
    <div
      data-testid="chat-no-snapshot"
      role="status"
      className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[12px] text-muted-foreground"
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">No project snapshot</span>
      <Button size="xs" variant="outline" onClick={onDraft} data-testid="chat-draft-snapshot">
        Ask Claude to draft one
      </Button>
    </div>
  )
}

// reqforge: implements REQ-0032
export function ChatPanel() {
  const chat = useChat()
  const help = useHelp()
  const status = useChatStatus()
  const snapshot = useSnapshot()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // keep the newest message in view
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.log, chat.open])

  useEffect(() => {
    if (chat.focusNonce && inputRef.current) {
      const el = inputRef.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [chat.focusNonce])

  const ok = status.data?.available
  const statusTitle = status.data
    ? ok
      ? `claude: ${status.data.claude}`
      : "claude CLI not found on the server's PATH"
    : "checking…"

  return (
    <section
      data-testid="chat-panel"
      className="fixed inset-0 z-40 flex min-h-0 flex-col bg-card lg:static lg:z-auto lg:border-l"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          data-testid="chat-status"
          title={statusTitle}
          className={cn("size-2 rounded-full bg-muted-foreground", status.data && (ok ? "bg-ok" : "bg-err"))}
        />
        <b className="font-semibold">Claude</b>
        {chat.lastCost != null && (
          <span className="text-[12px] text-muted-foreground">· ${chat.lastCost.toFixed(3)} last turn</span>
        )}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="help on chat and changesets"
          title="Help: chat and changesets"
          onClick={(e) => help.openHelp("chat", e.currentTarget)}
          data-testid="chat-help"
        >
          <CircleHelp />
        </Button>
        <Button size="xs" variant="outline" title="start a fresh conversation" onClick={chat.reset} data-testid="chat-new">
          <RotateCcw /> New
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="close chat" onClick={() => chat.setOpen(false)} data-testid="chat-close">
          <X />
        </Button>
      </div>
      {snapshot.data && !snapshot.data.exists && <NoSnapshot onDraft={() => chat.ask(DRAFT_SNAPSHOT_PROMPT)} />}
      <div ref={listRef} data-testid="chat-messages" className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <GapPrompt />
        {chat.log.length ? (
          chat.log.map((e) => <ChatMessage key={e.k} e={e} />)
        ) : (
          <div className="px-2 pt-6 text-center text-[12.5px] text-muted-foreground">
            Ask Claude to add, refine, merge or remove requirements. It reviews what exists, loops on MECE and traceability
            checks, assesses impact on stories, evals and code components, then proposes a changeset for you to apply.
          </div>
        )}
      </div>
      <form
        className="flex flex-col gap-1.5 border-t px-2.5 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void chat.send(chat.draft)
        }}
      >
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Checkbox
            data-testid="chat-use-ctx"
            checked={chat.useCtx}
            onCheckedChange={(c) => chat.setUseCtx(c === true)}
            className="size-3.5"
          />
          include view &amp; selection
          {chat.contextSummary && (
            <span data-testid="chat-ctx" className="truncate">
              · {chat.contextSummary}
            </span>
          )}
        </label>
        <Textarea
          ref={inputRef}
          data-testid="chat-input"
          value={chat.draft}
          onChange={(e) => chat.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void chat.send(chat.draft)
            }
          }}
          placeholder="Ask about, add, refine or remove requirements…  (Enter to send, Shift+Enter for a new line)"
          className="max-h-[200px] min-h-[58px] resize-y bg-background text-[13px]"
        />
        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground">Changes arrive as changesets you review and apply.</span>
          <span className="flex-1" />
          {chat.busy && (
            <Button type="button" size="sm" variant="outline" className="h-7" onClick={chat.stop} data-testid="chat-stop">
              <Square /> Stop
            </Button>
          )}
          <Button type="submit" size="sm" className="h-7" disabled={chat.busy} data-testid="chat-send">
            <Send /> Send
          </Button>
        </div>
      </form>
    </section>
  )
}
