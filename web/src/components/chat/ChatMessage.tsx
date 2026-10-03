import { useState } from "react"
import { ChevronRight, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChangesetCard } from "@/components/ChangesetCard"
import { type ChatEntry, type ToolItem, useChat } from "@/state/chat"
import { cn } from "@/lib/utils"
import { Markdown } from "./Markdown"

interface Choice {
  question?: string
  options?: string[]
  multi?: boolean
}

type Part = { md: string } | { choice: Choice }

/** Split assistant text into markdown and ```choices JSON blocks. */
function splitChoices(text: string): Part[] {
  const parts: Part[] = []
  const re = /```choices\s*([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(text))) {
    parts.push({ md: text.slice(last, m.index) })
    try {
      parts.push({ choice: JSON.parse(m[1]) as Choice })
    } catch {
      parts.push({ md: m[0] })
    }
    last = re.lastIndex
  }
  parts.push({ md: text.slice(last) })
  return parts
}

function Choices({ c, done, busy, onAnswer }: { c: Choice; done: boolean; busy: boolean; onAnswer: (text: string) => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const q = c.question || "Choose"
  return (
    <div
      data-testid="choices"
      data-done={done ? "true" : undefined}
      className={cn("mt-1.5 rounded-lg border bg-background px-2.5 py-2", done && "pointer-events-none opacity-60")}
    >
      <div className="mb-1.5 font-semibold">{q}</div>
      <div className="flex flex-col gap-1">
        {(c.options || []).map((o) =>
          c.multi ? (
            <label key={o} className="flex cursor-pointer items-center gap-2 text-[13px]">
              <Checkbox
                data-testid="choice-check"
                checked={picked.includes(o)}
                disabled={done || busy}
                onCheckedChange={(on) => setPicked((p) => (on === true ? [...p, o] : p.filter((x) => x !== o)))}
              />
              {o}
            </label>
          ) : (
            <button
              key={o}
              type="button"
              data-testid="choice-option"
              disabled={done || busy}
              onClick={() => onAnswer(`${q} → ${o}`)}
              className="rounded-md border bg-card px-2.5 py-1 text-left text-[13px] transition-colors hover:border-primary hover:bg-sel"
            >
              {o}
            </button>
          ),
        )}
      </div>
      {c.multi && (
        <Button
          size="xs"
          className="mt-1.5"
          data-testid="choice-send"
          disabled={done || busy}
          onClick={() => onAnswer(`${q} → ${picked.join("; ") || "none"}`)}
        >
          Send
        </Button>
      )}
    </div>
  )
}

function ToolGroup({ items, live }: { items: ToolItem[]; live: boolean }) {
  // open while the agent is working; afterwards collapsed unless the user toggles it
  const [manual, setManual] = useState<boolean | null>(null)
  const open = live || (manual ?? false)
  return (
    <Collapsible open={open} onOpenChange={setManual} data-testid="tool-group" className="text-[12px] text-muted-foreground">
      <CollapsibleTrigger className="group inline-flex items-center gap-1 hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        <Settings2 className={cn("size-3.5", live && "animate-spin [animation-duration:2.5s]")} />
        {items.length} tool call{items.length > 1 ? "s" : ""}
        {live ? " …" : ""}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5 border-l pl-2">
          {items.map((i, n) => (
            <div
              key={n}
              title={i.text}
              data-testid="tool-item"
              className={cn("truncate py-px font-mono text-[11.5px]", i.sub && "pl-3 opacity-80")}
            >
              {i.sub ? "↳ " : ""}
              {i.text}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ChatMessage({ e }: { e: ChatEntry }) {
  const chat = useChat()
  switch (e.role) {
    case "user":
      return (
        <div
          data-testid="msg-user"
          className="max-w-[88%] self-end rounded-[12px_12px_2px_12px] bg-primary px-3 py-1.5 whitespace-pre-wrap text-primary-foreground [overflow-wrap:anywhere]"
        >
          {e.text}
        </div>
      )
    case "sys":
      return (
        <div data-testid="msg-sys" className="text-center text-[12px] text-muted-foreground">
          {e.text}
        </div>
      )
    case "error":
      return (
        <div data-testid="msg-error" className="text-[12.5px] whitespace-pre-wrap text-err">
          {e.text}
        </div>
      )
    case "tools":
      return <ToolGroup items={e.items} live={e.live} />
    case "changeset":
      return <ChangesetCard id={e.id} />
    case "asst": {
      const parts = splitChoices(e.text)
      return (
        <div data-testid="msg-asst" className="leading-[1.5]">
          {parts.map((p, pi) =>
            "md" in p ? (
              p.md.trim() ? <Markdown key={pi} text={p.md} /> : null
            ) : (
              <Choices
                key={pi}
                c={p.choice}
                done={(e.answered || []).includes(pi)}
                busy={chat.busy}
                onAnswer={(txt) => {
                  if (chat.busy) return
                  chat.markAnswered(e.k, pi)
                  void chat.send(txt)
                }}
              />
            ),
          )}
        </div>
      )
    }
  }
}
