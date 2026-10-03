import { useState } from "react"
import { ChangesetCard } from "@/components/ChangesetCard"
import { ErrorText } from "@/components/common"
import { statusTone } from "@/lib/format"
import { useChangesets } from "@/state/queries"
import { cn } from "@/lib/utils"

export function ChangesView() {
  const q = useChangesets()
  const [open, setOpen] = useState<string | null>(null)
  if (q.error) return <ErrorText>{(q.error as Error).message}</ErrorText>
  if (!q.data) return <p className="text-muted-foreground">Loading…</p>
  const list = q.data
  return (
    <div data-testid="changes-view">
      {list.length ? (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table data-testid="changes-table" className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b text-left text-[12px] text-muted-foreground">
                {["id", "title", "ops", "status", "created"].map((t) => (
                  <th key={t} className="h-8 px-2 font-semibold">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr
                  key={c.id}
                  data-testid="changeset-row"
                  data-id={c.id}
                  onClick={() => setOpen(c.id)}
                  className={cn("cursor-pointer border-b last:border-b-0 hover:bg-muted/60", open === c.id && "bg-sel")}
                >
                  <td className="id-mono px-2 py-1.5">{c.id}</td>
                  <td className="px-2 py-1.5">{c.title}</td>
                  <td className="px-2 py-1.5 tabular-nums">{c.ops}</td>
                  <td className={cn("px-2 py-1.5 font-medium", statusTone(c.status))}>{c.status}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">
                    {(c.created || "").slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground">No changesets yet. Ask Claude in the chat to add or refine requirements.</p>
      )}
      {open && (
        <div className="mt-3 max-w-[780px]">
          <ChangesetCard key={open} id={open} />
        </div>
      )}
    </div>
  )
}
