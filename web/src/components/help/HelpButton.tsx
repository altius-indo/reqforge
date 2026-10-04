import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { preloadGuides } from "@/components/help/load"
import { useHelp } from "@/state/help"

/** Header button that opens the help panel on the section for `context` (the active tab, or `projects`). */
// reqforge: implements REQ-0048
export function HelpButton({ context }: { context: string }) {
  const help = useHelp()
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7"
      data-testid="help-button"
      aria-haspopup="dialog"
      aria-expanded={help.open}
      title="How-to guides for this view"
      onPointerEnter={preloadGuides}
      onFocus={preloadGuides}
      onClick={(e) => help.openHelp(context, e.currentTarget)}
    >
      <CircleHelp /> Help
    </Button>
  )
}
