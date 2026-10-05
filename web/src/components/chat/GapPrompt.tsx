import { useState } from "react"
import { CalendarClock, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useChat } from "@/state/chat"

/** local calendar date, YYYY-MM-DD */
const day = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA")
}

/**
 * At the start of a chat session after 14 or more quiet days: the gap, whether it counts as deliberate (the project
 * was paused with a reason) or unexplained, and a field to say what happened. Closing it leaves the gap to be recorded
 * without a reason when the session is logged.
 */
// reqforge: implements REQ-0062
export function GapPrompt() {
  const chat = useChat()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const p = chat.gap
  if (!p) return null
  const { gap, recorded } = p

  const save = async () => {
    setBusy(true)
    setErr("")
    try {
      await chat.recordGap(reason.trim())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="gap-prompt"
      data-gap={gap.gap}
      data-recorded={recorded ? "true" : "false"}
      className="rounded-lg border border-warn/40 bg-warn/5 p-2.5 text-[12.5px]"
    >
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <b data-testid="gap-days" className="font-semibold">
              {gap.days} days
            </b>
            <span>since the last session</span>
            <Badge data-testid="gap-kind" variant={gap.gap === "deliberate" ? "secondary" : "outline"}>
              {gap.gap}
            </Badge>
          </div>
          <div data-testid="gap-range" className="text-muted-foreground">
            {day(gap.from)} – {day(gap.to)}
            {gap.pause_reason && <> · paused: <span data-testid="gap-pause-reason">{gap.pause_reason}</span></>}
          </div>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="close the gap note" onClick={chat.dismissGap} data-testid="gap-dismiss">
          <X />
        </Button>
      </div>
      {recorded ? (
        <p data-testid="gap-recorded" className="mt-1.5 text-muted-foreground">
          Recorded as a {recorded.gap} gap{recorded.reason ? <> · {recorded.reason}</> : " without a reason"}.
        </p>
      ) : (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input
            data-testid="gap-reason"
            aria-label="reason for the gap"
            value={reason}
            maxLength={280}
            placeholder="What happened? (optional)"
            onChange={(e) => setReason(e.target.value)}
            className="h-7 bg-background text-[12.5px]"
          />
          <Button type="submit" size="sm" variant="outline" className="h-7" disabled={busy} data-testid="gap-save">
            Record
          </Button>
        </form>
      )}
      {err && <p className="mt-1 text-err">{err}</p>}
    </div>
  )
}
