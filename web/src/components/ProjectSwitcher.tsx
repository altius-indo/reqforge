import { Check, ChevronsUpDown, FolderCog, Plus, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useProjects } from "@/state/project"
import { fmt } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Header dropdown: current project, every project with its requirement count, and project actions. */
export function ProjectSwitcher() {
  const { projects, activeProject, active, single, open, openCreate, showProjects, refresh, list } = useProjects()
  if (!list) return null

  return (
    <DropdownMenu
      onOpenChange={(o) => {
        // refresh the counts each time the menu opens
        if (o) void refresh()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-[300px] gap-1.5 px-2 text-[13px] font-normal"
          data-testid="project-switcher"
          aria-label="switch project"
        >
          {activeProject ? (
            <span data-testid="project" className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-foreground">{activeProject.name}</span>
              <span className="id-mono text-muted-foreground">{activeProject.key}</span>
            </span>
          ) : (
            <span data-testid="project" className="text-muted-foreground">
              {projects.length ? "Choose a project" : "No projects"}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[340px]" data-testid="switcher-menu">
        <DropdownMenuLabel className="text-[12px] text-muted-foreground">
          {single ? "Project (single-repository server)" : `Projects · ${projects.length}`}
        </DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem
            key={p.key}
            data-testid="switcher-item"
            data-key={p.key}
            data-active={p.key === active}
            onSelect={() => open(p.key)}
            className="gap-2"
          >
            <Check className={cn("size-4", p.key !== active && "invisible")} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-baseline gap-1.5">
                <span className="id-mono text-[12px] font-semibold">{p.key}</span>
                {p.default && (
                  <span
                    data-testid="switcher-default"
                    className="rounded bg-muted px-1 text-[10.5px] leading-4 text-muted-foreground"
                  >
                    default
                  </span>
                )}
                {!p.available && <TriangleAlert className="size-3.5 text-warn" aria-label="unavailable" />}
              </span>
              <span className="truncate text-[12.5px] text-muted-foreground">{p.name}</span>
            </span>
            <span data-testid="switcher-count" className="text-[12px] text-muted-foreground tabular-nums">
              {fmt(p.artifacts.requirements)} req
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {!single && (
          <DropdownMenuItem data-testid="switcher-new" onSelect={() => openCreate("create")}>
            <Plus /> New project…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem data-testid="switcher-manage" onSelect={showProjects}>
          <FolderCog /> Manage projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
