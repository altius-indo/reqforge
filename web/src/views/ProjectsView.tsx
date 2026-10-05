import { useState } from "react"
import { ExternalLink, FolderOpen, FolderPlus, Import, Pause, Pencil, Star, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { projectsApi } from "@/api/client"
import type { DeleteProjectResult, Project } from "@/api/types"
import { DeleteProjectDialog, PauseProjectDialog, RenameProjectDialog } from "@/components/ProjectDialogs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useProjects } from "@/state/project"
import { describeCounts, fmt } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Empty state when the workspace has no projects. */
export function Onboarding() {
  const { openCreate } = useProjects()
  return (
    <div data-testid="onboarding" className="mx-auto mt-[8vh] max-w-xl rounded-xl border bg-card p-8 shadow-xs">
      <FolderPlus className="mb-3 size-8 text-muted-foreground" />
      <h2 className="mb-2 text-lg font-semibold">Create your first project</h2>
      <p className="mb-2 text-[13.5px] text-muted-foreground">
        A project is a git repository that holds one product's requirements, the epics, stories and tasks that realise
        them, the changesets Claude proposes, and session notes. Each project has a short key such as{" "}
        <span className="id-mono">SHOP</span> that identifies it in links and on the command line.
      </p>
      <p className="mb-5 text-[13.5px] text-muted-foreground">
        Start a new project, optionally with a GitHub repository, or register a reqforge repository that already exists
        on this machine.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => openCreate("create")} data-testid="onboarding-create">
          <FolderPlus /> Create project
        </Button>
        <Button variant="outline" onClick={() => openCreate("import")} data-testid="onboarding-import">
          <Import /> Import existing repository
        </Button>
      </div>
    </div>
  )
}

const COUNT_COLS: [keyof Project["artifacts"], string][] = [
  ["requirements", "Requirements"],
  ["epics", "Epics"],
  ["stories", "Stories"],
  ["tasks", "Tasks"],
  ["changesets", "Changesets"],
  ["sessions", "Sessions"],
]

/** local calendar date, YYYY-MM-DD */
const day = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA")
}

export function ProjectsView() {
  const { list, projects, single, active, open, openCreate, refresh, forget } = useProjects()
  const [renaming, setRenaming] = useState<Project | null>(null)
  const [pausing, setPausing] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  if (!list) return null
  if (!projects.length) return <Onboarding />

  const makeDefault = async (p: Project) => {
    setBusyKey(p.key)
    try {
      await projectsApi.makeDefault(p.key)
      toast.success(`${p.key} is now the default project`)
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyKey(null)
    }
  }

  const onDeleted = async (r: DeleteProjectResult) => {
    forget(r.deleted, r.default)
    const remote =
      r.remote_deleted && typeof r.remote_deleted === "object" && (r.remote_deleted as { deleted?: boolean }).deleted
        ? " and the GitHub repository"
        : ""
    toast.success(`Deleted ${r.deleted}${remote}`, {
      description: `Removed ${describeCounts(r.removed)} and the git history.`,
    })
    setDeleting(null)
    await refresh()
  }

  return (
    <div data-testid="projects-view" className="mx-auto max-w-[1400px]">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold">Projects</h2>
          <p className="text-[12.5px] text-muted-foreground">
            {single ? "Repository" : "Workspace"}{" "}
            <code data-testid="workspace-path" className="font-mono">
              {list.workspace}
            </code>
          </p>
        </div>
        <span className="flex-1" />
        {!single && (
          <>
            <Button size="sm" variant="outline" onClick={() => openCreate("import")} data-testid="projects-import">
              <Import /> Import
            </Button>
            <Button size="sm" onClick={() => openCreate("create")} data-testid="projects-new">
              <FolderPlus /> New project
            </Button>
          </>
        )}
      </div>
      {single && (
        <Alert className="mb-3" data-testid="single-note">
          <AlertTitle>Single-repository mode</AlertTitle>
          <AlertDescription>
            This server was started with <code className="font-mono">--repo</code> and serves one repository, so projects
            cannot be created, imported, renamed or deleted here. Start it with{" "}
            <code className="font-mono">--workspace</code> to manage several projects.
          </AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-[13px]" data-testid="projects-table">
          <thead>
            <tr className="border-b text-left text-[12px] text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Project</th>
              <th className="px-3 py-2 font-semibold">Location</th>
              {COUNT_COLS.map(([k, label]) => (
                <th key={k} className="px-2 py-2 text-right font-semibold">
                  {label}
                </th>
              ))}
              <th className="px-3 py-2 font-semibold">Created</th>
              <th className="px-3 py-2 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr
                key={p.key}
                data-testid="project-row"
                data-key={p.key}
                data-active={p.key === active}
                className={cn("border-b align-top last:border-0", p.key === active && "bg-muted/40")}
              >
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="id-mono font-semibold">{p.key}</span>
                    {p.default && (
                      <Badge variant="secondary" data-testid="default-badge">
                        default
                      </Badge>
                    )}
                    {p.key === active && <Badge variant="outline">active</Badge>}
                    {!p.available && (
                      <Badge variant="destructive" data-testid="unavailable-badge" title="the project directory is missing or unreadable">
                        <TriangleAlert /> unavailable
                      </Badge>
                    )}
                  </div>
                  <div data-testid="project-name" className="mt-0.5 max-w-[280px] text-muted-foreground">
                    {p.name}
                  </div>
                </td>
                <td className="max-w-[340px] px-3 py-2.5">
                  {/* ellipsis at the start, so the meaningful end of the path stays visible */}
                  <div className="truncate text-left font-mono text-[12px] [direction:rtl]" title={p.path}>
                    <span dir="ltr">{p.path}</span>
                  </div>
                  {p.github ? (
                    <a
                      href={`https://github.com/${p.github}`}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="project-github"
                      className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
                    >
                      github.com/{p.github} <ExternalLink className="size-3" />
                    </a>
                  ) : p.remote ? (
                    <div className="mt-0.5 truncate text-[12px] text-muted-foreground" title={p.remote}>
                      {p.remote}
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[12px] text-muted-foreground">local only</div>
                  )}
                </td>
                {COUNT_COLS.map(([k]) => (
                  <td key={k} data-col={k} className="px-2 py-2.5 text-right tabular-nums">
                    {fmt(p.artifacts[k])}
                  </td>
                ))}
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{day(p.created)}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="xs"
                      variant={p.key === active ? "secondary" : "outline"}
                      disabled={!p.available}
                      onClick={() => open(p.key)}
                      data-testid="project-open"
                    >
                      <FolderOpen /> Open
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!p.available}
                      title="pause the project with a reason: the next long gap is recorded as deliberate"
                      onClick={() => setPausing(p)}
                      data-testid="project-pause"
                    >
                      <Pause /> Pause
                    </Button>
                    {!single && (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => setRenaming(p)} data-testid="project-rename">
                          <Pencil /> Rename
                        </Button>
                        {p.default ? (
                          // keeps the action columns aligned across rows
                          <span aria-hidden className="invisible inline-flex h-6 items-center gap-1 px-2 text-xs">
                            <Star className="size-3" /> Make default
                          </span>
                        ) : (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busyKey === p.key}
                            onClick={() => void makeDefault(p)}
                            data-testid="project-default"
                          >
                            <Star /> Make default
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-err hover:bg-destructive/10 hover:text-err"
                          onClick={() => setDeleting(p)}
                          data-testid="project-delete"
                        >
                          <Trash2 /> Delete
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
      <PauseProjectDialog project={pausing} onClose={() => setPausing(null)} />
      <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} onDeleted={(r) => void onDeleted(r)} />
    </div>
  )
}
