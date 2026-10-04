import { useRef, useState, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { projectsApi } from "@/api/client"
import type { DeleteProjectResult, Project } from "@/api/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { KEY_RE, useProjects } from "@/state/project"
import { describeCounts } from "@/lib/format"
import { cn } from "@/lib/utils"

const GITHUB_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function FieldHint({ error, children, testId }: { error?: boolean; children: ReactNode; testId?: string }) {
  return (
    <p data-testid={testId} data-error={error ? "true" : "false"} className={cn("text-[12px]", error ? "text-err" : "text-muted-foreground")}>
      {children}
    </p>
  )
}

// ------------------------------------------------------------------ create / import

// reqforge: implements REQ-0033
export function CreateProjectDialog() {
  const { createMode, closeCreate, openCreate, projects, refresh, open } = useProjects()
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [github, setGithub] = useState("")
  const [priv, setPriv] = useState(true)
  const [path, setPath] = useState("")
  const [importKey, setImportKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const reset = () => {
    setKey("")
    setName("")
    setGithub("")
    setPriv(true)
    setPath("")
    setImportKey("")
    setErr("")
  }

  const keyTaken = projects.some((p) => p.key === key)
  const keyValid = KEY_RE.test(key)
  const ghValid = !github.trim() || GITHUB_RE.test(github.trim())
  const canCreate = keyValid && !keyTaken && !!name.trim() && ghValid && !busy
  const importKeyValid = !importKey || KEY_RE.test(importKey)
  const canImport = path.trim().startsWith("/") && importKeyValid && !busy

  const done = async (p: Project, verb: string) => {
    toast.success(`${verb} project ${p.key}`)
    await refresh()
    closeCreate()
    reset()
    open(p.key)
  }

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setErr("")
    try {
      const gh = github.trim()
      const p = await projectsApi.create({ key, name: name.trim(), ...(gh ? { github: gh, private: priv } : {}) })
      await done(p, "created")
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doImport = async () => {
    if (!canImport) return
    setBusy(true)
    setErr("")
    try {
      const p = await projectsApi.importRepo(path.trim(), importKey || undefined)
      await done(p, "imported")
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const keyHint = !key
    ? "2–16 characters: a letter, then letters, digits, _ or -. Used in URLs and the CLI."
    : keyTaken
      ? `${key} already exists`
      : !keyValid
        ? key.length < 2
          ? "too short: at least 2 characters"
          : key.length > 16
            ? "too long: at most 16 characters"
            : /^[^A-Z]/.test(key)
              ? "must start with a letter"
              : "only letters, digits, _ and - are allowed"
        : `key ${key} is available`

  return (
    <Dialog
      open={!!createMode}
      onOpenChange={(o) => {
        if (!o && !busy) {
          closeCreate()
          setErr("")
        }
      }}
    >
      <DialogContent data-testid="create-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is its own git repository of requirements, epics, stories, tasks and changesets.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={createMode ?? "create"}
          onValueChange={(v) => {
            setErr("")
            openCreate(v as "create" | "import")
          }}
          className="gap-3"
        >
          <TabsList className="w-full">
            <TabsTrigger value="create" data-testid="create-tab">
              Create
            </TabsTrigger>
            <TabsTrigger value="import" data-testid="import-tab">
              Import existing repository
            </TabsTrigger>
          </TabsList>
          <TabsContent value="create">
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void create()
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="create-key">Key</Label>
                <Input
                  id="create-key"
                  data-testid="create-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toUpperCase().replace(/\s/g, ""))}
                  placeholder="SHOP"
                  maxLength={24}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!key && (!keyValid || keyTaken)}
                  className="id-mono uppercase"
                  autoFocus
                />
                <FieldHint testId="create-key-hint" error={!!key && (!keyValid || keyTaken)}>
                  {keyHint}
                </FieldHint>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-name">Name</Label>
                <Input
                  id="create-name"
                  data-testid="create-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Checkout and payments"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="create-github">
                  GitHub repository <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="create-github"
                  data-testid="create-github"
                  value={github}
                  onChange={(e) => setGithub(e.target.value)}
                  placeholder="owner/name"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!ghValid}
                />
                {github.trim() ? (
                  <>
                    <label className="flex items-center gap-2 text-[13px]">
                      <Checkbox
                        data-testid="create-private"
                        checked={priv}
                        onCheckedChange={(c) => setPriv(c === true)}
                      />
                      Private repository
                    </label>
                    <FieldHint error={!ghValid}>
                      {ghValid
                        ? `Creates ${priv ? "a private" : "a public"} repository ${github.trim()} with the gh CLI on the server (it must be installed and signed in) and pushes to it. This can take a few seconds.`
                        : "use the form owner/name"}
                    </FieldHint>
                  </>
                ) : (
                  <FieldHint>Leave empty for a local-only repository; you can add a remote later.</FieldHint>
                )}
              </div>
              {err && createMode === "create" && (
                <p data-testid="create-error" className="text-[12.5px] whitespace-pre-wrap text-err">
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeCreate} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canCreate} data-testid="create-submit">
                  {busy ? (github.trim() ? "Creating repository…" : "Creating…") : "Create project"}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
          <TabsContent value="import">
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void doImport()
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="import-path">Repository directory</Label>
                <Input
                  id="import-path"
                  data-testid="import-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/absolute/path/to/repository"
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldHint error={!!path && !path.trim().startsWith("/")}>
                  An absolute path on the server to an existing reqforge repository (it has a reqforge.json). It is
                  registered in place, not copied.
                </FieldHint>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="import-key">
                  Key <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="import-key"
                  data-testid="import-key"
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value.toUpperCase().replace(/\s/g, ""))}
                  placeholder="from reqforge.json"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!importKeyValid}
                  className="id-mono uppercase"
                />
                <FieldHint error={!importKeyValid}>
                  {importKeyValid ? "Defaults to the repository's own key." : "2–16 characters: a letter, then letters, digits, _ or -"}
                </FieldHint>
              </div>
              {err && createMode === "import" && (
                <p data-testid="create-error" className="text-[12.5px] whitespace-pre-wrap text-err">
                  {err}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeCreate} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canImport} data-testid="import-submit">
                  {busy ? "Importing…" : "Import"}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------ rename

export function RenameProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()}>
      {project && <RenameBody key={project.key} project={project} onClose={onClose} />}
    </Dialog>
  )
}

function RenameBody({ project, onClose }: { project: Project; onClose: () => void }) {
  const { refresh } = useProjects()
  const [name, setName] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const can = !!name.trim() && name.trim() !== project.name && !busy

  const save = async () => {
    if (!can) return
    setBusy(true)
    setErr("")
    try {
      await projectsApi.rename(project.key, name.trim())
      toast.success(`renamed ${project.key}`)
      await refresh()
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogContent data-testid="rename-dialog">
      <DialogHeader>
        <DialogTitle>
          Rename <span className="id-mono">{project.key}</span>
        </DialogTitle>
        <DialogDescription>The key stays the same; only the display name changes.</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Input data-testid="rename-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {err && <p className="text-[12.5px] text-err">{err}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!can} data-testid="rename-save">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

// ------------------------------------------------------------------ delete

// reqforge: implements REQ-0033
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project | null
  onClose: () => void
  onDeleted: (r: DeleteProjectResult) => void
}) {
  return (
    <Dialog open={!!project} onOpenChange={(o) => !o && onClose()}>
      {project && <DeleteBody key={project.key} project={project} onClose={onClose} onDeleted={onDeleted} />}
    </Dialog>
  )
}

function DeleteBody({
  project,
  onClose,
  onDeleted,
}: {
  project: Project
  onClose: () => void
  onDeleted: (r: DeleteProjectResult) => void
}) {
  const [typed, setTyped] = useState("")
  const [alsoRemote, setAlsoRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = typed === project.key

  const del = async () => {
    if (!matches || busy) return
    setBusy(true)
    setErr("")
    try {
      const r = await projectsApi.remove(project.key, alsoRemote && !!project.github)
      onDeleted(r)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <DialogContent
      data-testid="delete-dialog"
      className="sm:max-w-lg"
      onOpenAutoFocus={(e) => {
        // focus the confirmation field, never the destructive button
        e.preventDefault()
        inputRef.current?.focus()
      }}
      onInteractOutside={(e) => busy && e.preventDefault()}
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>
          Delete project <span className="id-mono">{project.key}</span>?
        </DialogTitle>
        <DialogDescription>{project.name}</DialogDescription>
      </DialogHeader>
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>This permanently deletes the project and cannot be undone.</AlertTitle>
        <AlertDescription>
          <p data-testid="delete-summary">
            Removes {describeCounts(project.artifacts)} and the full git history at{" "}
            <code className="font-mono text-[12px] break-all">{project.path}</code>.
          </p>
        </AlertDescription>
      </Alert>
      {project.github ? (
        <label className="flex items-start gap-2 text-[13px]">
          <Checkbox
            data-testid="delete-remote"
            checked={alsoRemote}
            onCheckedChange={(c) => setAlsoRemote(c === true)}
            className="mt-0.5"
          />
          <span>
            Also delete the GitHub repository{" "}
            <a
              href={`https://github.com/${project.github}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12.5px] underline"
            >
              {project.github}
            </a>{" "}
            <b className="text-err">(irreversible)</b>
            <span className="block text-[12px] text-muted-foreground">
              {alsoRemote
                ? "The repository, its issues and pull requests are deleted with gh repo delete."
                : "Unchecked: the GitHub repository is kept."}
            </span>
          </span>
        </label>
      ) : project.remote ? (
        <p className="text-[12.5px] text-muted-foreground">
          The remote <code className="font-mono">{project.remote}</code> is not touched.
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="delete-confirm-input">
          Type <span className="id-mono font-semibold">{project.key}</span> to confirm
        </Label>
        <Input
          ref={inputRef}
          id="delete-confirm-input"
          data-testid="delete-confirm-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="id-mono"
          disabled={busy}
        />
      </div>
      {err && (
        <p data-testid="delete-error" className="text-[12.5px] whitespace-pre-wrap text-err">
          {err}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="delete-confirm"
          disabled={!matches || busy}
          onClick={() => void del()}
          className="bg-destructive text-white hover:bg-destructive/90"
        >
          {busy ? "Deleting…" : alsoRemote && project.github ? "Delete project and GitHub repository" : "Delete project"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
