// Wire types for the reqforge JSON API. These mirror reqforge/api.py, query.py, changes.py and
// chat.py exactly; the Rust backend serves the same shapes, so change both sides together.

export type Kind = "requirements" | "epics" | "stories" | "tasks" | "components"
export type Tab = Kind | "trace" | "verification" | "lint" | "changes" | "design"
export const KINDS: Kind[] = ["requirements", "epics", "stories", "tasks", "components"]

// ------------------------------------------------------------------ meta
export type FieldType = "str" | "text" | "enum" | "ref" | "reflist" | "list" | "objlist" | "int"

export interface FieldSchema {
  type: FieldType
  required?: boolean
  /** enum values */
  values?: string[]
  default?: unknown
  /** target kind for ref / reflist */
  kind?: Kind
  /** object keys for objlist */
  keys?: string[]
}

export type KindSchema = Record<string, FieldSchema>

export interface TaxonomyType {
  order: number
  test: string
  /** category -> description; null means open-ended (any category) */
  categories: Record<string, string> | null
}

export interface ProjectConfig {
  key: string
  name: string
  autocommit?: boolean
  gates?: Record<string, unknown>
  /** "type/category" or "type" -> reason */
  coverage_waivers?: Record<string, string>
  components?: Record<string, string>
  [k: string]: unknown
}

export interface Meta {
  config: ProjectConfig
  /** kind -> id prefix (REQ, EPIC, STORY, TASK) */
  kinds: Record<Kind, string>
  taxonomy: Record<string, TaxonomyType>
  schemas: Record<Kind, KindSchema>
  enums: Record<string, string[]>
}

// ------------------------------------------------------------------ records
export interface AcceptanceCriterion {
  id: string
  text: string
}

export interface EvalSpec {
  id: string
  name?: string
  kind?: string
  command?: string
  covers?: string[]
  required?: boolean
  [k: string]: unknown
}

/** Any stored record. Fields beyond the system ones come from Meta.schemas[kind]. */
export interface RecordBase {
  id: string
  version: number
  created: string
  updated: string
  title?: string
  tags?: string[]
  status?: string
  [field: string]: unknown
}

export interface Requirement extends RecordBase {
  statement?: string
  type?: string
  category?: string
  priority?: string
  rationale?: string
  acceptance_criteria?: AcceptanceCriterion[]
  parent?: string | null
  standards?: string[]
  stakeholders?: string[]
  source?: string
  notes?: string
}

export interface Story extends RecordBase {
  epic?: string
  narrative?: string
  requirements?: string[]
  deliverable?: string
  component?: string
  acceptance_criteria?: AcceptanceCriterion[]
  evals?: EvalSpec[]
  points?: number | null
}

/** A list row: record plus link-count annotations added by query.page. */
export interface ListRow extends RecordBase {
  /** requirements: number of stories realising it */
  _stories?: number
  /** requirements: number of child requirements */
  _children?: number
  /** stories: number of tasks */
  _tasks?: number
  /** stories: number of evals */
  _evals?: number
  /** requirements: worst verification status of its acceptance criteria */
  _verification?: VerificationStatus
}

export interface Page<T = ListRow> {
  total: number
  offset: number
  limit: number
  items: T[]
}

export interface ListParams {
  q?: string
  sort?: string
  order?: "asc" | "desc"
  offset?: number
  limit?: number
  /** field filters (value may be "a|b" for OR); `covered=yes|no` for requirements */
  [filter: string]: string | number | undefined
}

// ------------------------------------------------------------------ facets
export type FacetCounts = Record<string, number>

export interface TreeCategory {
  category: string
  count: number
  covered: number
  errors: number
  warnings: number
  /** waiver reason, or null */
  waived: string | null
}

export interface TreeNode {
  type: string
  count: number
  covered: number
  errors: number
  warnings: number
  categories: TreeCategory[]
}

/** facet name -> value counts, plus `_tree` (requirements) and `_epic_titles` (stories). */
export type Facets = {
  _tree?: TreeNode[]
  _epic_titles?: Record<string, string>
} & {
  [facet: string]: FacetCounts | TreeNode[] | Record<string, string> | undefined
}

// ------------------------------------------------------------------ lint / trace
export type Severity = "error" | "warning" | "info"

export interface LintFinding {
  severity: Severity
  rule: string
  ids: string[]
  message: string
}

export type LintCounts = Record<Severity, number>

export interface LintCoverage {
  cells: number
  gaps: string[]
  waived: Record<string, string>
}

export interface LintPage {
  ok: boolean
  requirements: number
  counts: LintCounts
  coverage: LintCoverage
  by_rule: Record<string, Partial<LintCounts>>
  total: number
  offset: number
  limit: number
  items: LintFinding[]
}

export interface LintParams {
  rule?: string
  severity?: string
  type?: string
  category?: string
  q?: string
  offset?: number
  limit?: number
}

export interface TraceCheck {
  id: string
  name: string
  passed: boolean
  severity: "error" | "warning"
  failures: string[]
  measured?: number
}

export interface TraceMetrics {
  requirements: number
  active: number
  epics: number
  stories: number
  tasks: number
  evals: number
  requirement_coverage: number
  criteria_coverage: number
  [k: string]: number
}

export interface TraceReport {
  ok: boolean
  score: number
  metrics: TraceMetrics
  checks: TraceCheck[]
  matrix?: unknown
}

// ------------------------------------------------------------------ context / impact
export interface ImpactStory {
  id: string
  title?: string
  status?: string
  component?: string | null
  via: string[]
}

export interface ImpactTask {
  id: string
  title?: string
  kind?: string
  status?: string
  story?: string
}

export interface ImpactEval {
  story: string
  id: string
  name?: string
  kind?: string
  command?: string | null
  covers: string[]
}

export interface Impact {
  requirements: string[]
  children: string[]
  stories: ImpactStory[]
  tasks: ImpactTask[]
  evals: ImpactEval[]
  components: string[]
  in_progress_work: string[]
}

export interface RecordContext {
  record: RecordBase
  referenced_by: string[]
  /** requirements only */
  parent?: string | null
  children?: { id: string; title?: string }[]
  impact?: Impact
  lint?: LintFinding[]
  /** requirements only: per-criterion verification detail (same as GET /verification?req=ID) */
  code?: ReqVerification
  /** requirements only: design documents whose `realises` lists this requirement */
  design?: DesignDocRef[]
}

// ------------------------------------------------------------------ design documents
/** A design document, design/<slug>.md (GET /design lists them; GET /design/{slug} is its raw Markdown). */
export interface DesignDoc {
  slug: string
  title: string
  /** requirement ids the document realises */
  realises: string[]
}

export type DesignDocRef = Pick<DesignDoc, "slug" | "title">

// ------------------------------------------------------------------ changesets
export type ChangesetStatus = "pending" | "applied" | "rejected" | "stale"

export interface ChangesetSummary {
  id: string
  title: string
  status: ChangesetStatus
  created: string
  applied_at: string | null
  valid: boolean
  ops: number
}

/** An op as proposed by the agent (stored verbatim). */
export interface ChangesetOp {
  op: "create" | "update" | "delete"
  kind?: Kind
  ref?: string
  data?: Record<string, unknown>
  id?: string
  patch?: Record<string, unknown>
  add?: Record<string, unknown>
  remove?: Record<string, unknown>
  reason?: string
}

/** An op after simulation (ids resolved, field diffs computed). */
export interface ResolvedOp {
  i: number
  op: "create" | "update" | "delete"
  kind: Kind
  id: string
  ref?: string | null
  title?: string | null
  reason?: string | null
  /** create: brief of the created record */
  data?: Record<string, unknown>
  /** update: field -> [old, new] */
  changes?: Record<string, [unknown, unknown]>
  base_version?: number | null
}

export interface TraceDelta {
  check: string
  name: string
  severity: string
  new_failures: string[]
  fixed: string[]
}

export interface Simulation {
  valid: boolean
  errors: string[]
  ops: ResolvedOp[]
  refmap: Record<string, string>
  lint: {
    before: LintCounts
    after: LintCounts
    new: LintFinding[]
    resolved: LintFinding[]
    gaps_before: number
    gaps_after: number
    mece_ok: boolean
  }
  trace: {
    ok_before: boolean
    ok_after: boolean
    metrics_before: TraceMetrics
    metrics_after: TraceMetrics
    delta: TraceDelta[]
  }
  impact: Impact
}

export interface ImpactNotes {
  stories?: string
  code?: string
  evals?: string
  risks?: string[]
}

export interface Changeset {
  id: string
  title: string
  summary: string
  rationale: string
  status: ChangesetStatus
  created: string
  valid: boolean
  ops: ChangesetOp[]
  impact_notes: ImpactNotes
  base_versions: Record<string, number>
  analysis: Simulation
  applied_at?: string
  excluded_ops?: number[]
  assigned_ids?: Record<string, string>
  stale_reasons?: string[]
  rejected_reason?: string
  rejected_at?: string
}

export interface ApplyResult {
  changeset_id: string
  status: "applied"
  assigned_ids: Record<string, string>
  written: string[]
  lint: LintCounts
  trace_ok: boolean
  trace_metrics: TraceMetrics
  failing_checks: { check: string; failures: string[] }[]
}

export interface RejectResult {
  changeset_id: string
  status: "rejected"
}

// ------------------------------------------------------------------ writes
export interface BulkRequest {
  ids?: string[]
  q?: string
  where?: Record<string, string>
  set?: Record<string, unknown>
  add?: Record<string, unknown>
  remove?: Record<string, unknown>
  dry_run: boolean
}

export interface BulkResult {
  matched: number
  changed: string[]
  dry_run: boolean
}

export interface ImportResult {
  created: string[]
  updated: string[]
}

export interface DeleteResult {
  deleted: string
  dangling: string[]
}

export interface SyncResult {
  ok: boolean
  committed?: boolean
  pushed?: boolean
  note?: string
  error?: string
}

export interface ApiErrorBody {
  error: string
  details?: unknown[]
}

// ------------------------------------------------------------------ chat
export interface ChatStatus {
  available: boolean
  claude: string | null
}

export interface ChatContextPayload {
  view: Record<string, string>
  selected: string[]
  selected_total: number
}

export interface ChatRequest {
  chat_id: string
  message: string
  session_id: string | null
  context: ChatContextPayload | null
}

export type ChatEvent =
  | { type: "session"; session_id: string }
  | { type: "gap"; gap: PendingGap }
  | { type: "tool"; name: string; sub: boolean; text: string }
  | { type: "text"; text: string }
  | { type: "changeset"; id: string }
  | { type: "warning"; text: string }
  | { type: "error"; text: string }
  | {
      type: "done"
      session_id?: string | null
      cost?: number | null
      turns?: number | null
      is_error?: boolean
      result?: string | null
    }

// ------------------------------------------------------------------ projects (workspace)
export interface ArtifactCounts {
  requirements: number
  epics: number
  stories: number
  tasks: number
  changesets: number
  sessions: number
  reports: number
}

export interface Project {
  key: string
  name: string
  path: string
  created: string
  default: boolean
  /** false when the project directory is missing or unreadable */
  available: boolean
  remote: string | null
  /** "owner/name" when the remote is on GitHub */
  github: string | null
  artifacts: ArtifactCounts
}

export interface ProjectList {
  workspace: string
  /** the server runs one repository (--repo): no create/delete/default */
  single: boolean
  default: string | null
  projects: Project[]
}

export interface CreateProjectRequest {
  key: string
  name: string
  github?: string
  private?: boolean
}

export interface DeleteProjectResult {
  deleted: string
  path: string
  removed: ArtifactCounts
  remote: string | null
  remote_deleted: unknown
  /** the workspace default after the delete */
  default: string | null
}

// ------------------------------------------------------------------ code traceability / verification
/** Per criterion; a requirement takes its worst criterion (failing > suspect > untested > pending > verified). */
export type VerificationStatus = "verified" | "pending" | "untested" | "suspect" | "failing"
/** worst first */
export const VERIFICATION_STATUSES: VerificationStatus[] = ["failing", "suspect", "untested", "pending", "verified"]

export interface Component extends RecordBase {
  key: string
  path?: string
  repo_url?: string
  globs?: string[]
  language?: string
  owners?: string[]
  description?: string
}

/** A trace tag found in code (`reqforge: implements REQ-1`, `REQ-1#AC1` on a test). */
export interface CodeLocation {
  component: string
  file: string
  line: number
  symbol?: string | null
  ac?: string | null
}

export interface EvidenceRow {
  source: string
  status: string
  commit?: string | null
  run?: string | null
  at: string
}

export interface CriterionVerification {
  target: string
  status: VerificationStatus
  tests: CodeLocation[]
  /** "STORY-0001/E1" */
  evals: string[]
  evidence: EvidenceRow[]
  /** "component:file" changed since the evidence (suspect) */
  changed: string[]
}

export interface ReqVerification {
  status: VerificationStatus
  active: boolean
  implemented: boolean
  implements: CodeLocation[]
  acs: Record<string, CriterionVerification>
}

export interface ComponentIndexSummary {
  component: string
  commit: string | null
  scanned_at: string
  files_scanned: number
  tagged_files: number
  implements: number
  verifies: number
  requirements: number
}

export interface ProjectStateHealth {
  snapshot: {
    exists: boolean
    last_reconciled: string | null
    age_days: number | null
    stale: boolean
    /** days past limit_days (0 when fresh or absent) */
    days_over: number
    limit_days: number
    valid: boolean
  }
  decisions: {
    accepted: number
    /** accepted decisions not exercised by tagged, passing tests */
    unexercised: number
    /** unexercised for at least grace_days (lint warns) */
    overdue: number
    overdue_ids: string[]
    grace_days: number
  }
}

export interface VerificationReport {
  ok: boolean
  summary: {
    criteria: Record<VerificationStatus, number>
    requirements: Record<VerificationStatus, number>
    criteria_total: number
    verified_ratio: number
    implemented: number
    evidence: number
    components: ComponentIndexSummary[]
    /** "type/category" -> counts */
    by_category: Record<string, { requirements: number; verified: number }>
    /** project state health, as reported by the scheduled monitor */
    state?: ProjectStateHealth
  }
  checks: TraceCheck[]
  statuses: Record<string, VerificationStatus>
}

export interface CodeListing {
  components: Component[]
  indexes: ComponentIndexSummary[]
}

export interface ScanResult {
  scanned: {
    component: string
    skipped?: string
    root?: string
    commit?: string | null
    files_scanned?: number
    tagged_files?: number
    tags?: number
    implements?: number
    verifies?: number
  }[]
}

export interface EvidenceRequest {
  files: { name: string; content: string }[]
  component?: string
  commit?: string
  run?: string
}

export interface IngestResult {
  cases: number
  matched: number
  skipped: number
  unmatched: string[]
  evidence: number
  passed: number
  failed: number
  targets: number
  commit: string | null
}

export interface CodeImpact {
  component: string
  root?: string
  base: string
  changed_files: string[]
  requirements: { id: string; title?: string; via: { kind: string; file: string; line: number; symbol?: string | null }[] }[]
  tests: { file: string; symbols: string[] }[]
  evals: { story: string; id: string; kind?: string; command?: string | null }[]
  criteria_at_risk: string[]
  untraced_changes: string[]
}

// ------------------------------------------------------------------ tasks: start, agent runs, agent queue
export interface UnfinishedDep {
  id: string
  status: string
  title: string
}

/** GET tasks/{id}/readiness */
export interface TaskReadiness {
  task: string
  status: string
  version: number
  unfinished: UnfinishedDep[]
  can_start: boolean
  start_reasons: string[]
  can_start_agent: boolean
  agent_reasons: string[]
  component: string
}

/** POST tasks/{id}/start */
export interface StartResult {
  task: RecordBase
  /** ids moved to in-progress: the task, then its story and epic when they were todo */
  changed: string[]
  at: string
}

/** GET tasks/{id}/agent: readiness + what a run would do */
export interface AgentPlan {
  task: string
  ready: boolean
  reasons: string[]
  component: string
  branch: string
  unfinished: UnfinishedDep[]
  component_path?: string
  worktree?: string
  brief?: string
  /** other in-progress tasks of the same story with unmerged agent branches (REQ-0051#AC7; advisory) */
  parallel?: ParallelTask[]
}

export interface ParallelTask {
  id: string
  title: string
  branch: string
  ahead: number
}

export interface AgentCommit {
  sha: string
  message: string
}

/** exit code, or "cancelled" / "error" / "killed" */
export type AgentExitStatus = number | string

export type AgentEvent =
  | { type: "run"; run_id: string; branch: string; worktree: string; component: string; base: string; task_started: boolean }
  | { type: "session"; session_id?: string | null }
  | { type: "tool"; name: string; sub: boolean; text: string }
  | { type: "text"; text: string }
  | { type: "warning"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; is_error?: boolean; result?: string | null; turns?: number | null; cost?: number | null }
  | {
      type: "result"
      run_id: string
      exit_status: AgentExitStatus
      branch: string
      commits: AgentCommit[]
      violations: string[]
      task_status: string | null
    }

/** GET tasks/{id}/agent/live?since=n */
export interface AgentLive {
  running: boolean
  total: number
  events: AgentEvent[]
}

/** GET tasks/{id}/runs (newest first; events omitted): agent runs and Complete attempts */
export type RunLog = AgentRunLog | CompleteRunLog

export interface AgentRunLog {
  kind?: "agent"
  run_id: string
  task: string
  story: string
  component: string
  branch: string
  worktree: string
  base: string
  user: string
  started: string
  ended: string
  exit_status: AgentExitStatus
  commits: AgentCommit[]
  violations: string[]
}

/** one Complete attempt (requirements/agent-runs/COMPLETE-<TASK>-<ts>.json) */
export interface CompleteRunLog {
  kind: "complete"
  run_id: string
  task: string
  user: string
  started: string
  ended?: string
  branch: string
  target: string
  /** "completed", "refused: <why>" or "error: …" */
  outcome: string
  reasons?: string[]
  conflicts?: string[]
  evals?: CompleteEvalResult[]
  violations?: string[]
  merge_commit?: string
  changed?: string[]
  cleanup_warnings?: string[]
}

// ------------------------------------------------------------------ tasks: review & complete (REQ-0056)
export interface BranchCommit {
  sha: string
  author: string
  at: string
  message: string
}

/** GET tasks/{id}/branch (404 when the task has no agent branch) */
export interface BranchReview {
  task: string
  branch: string
  worktree: string
  /** the branch checked out in the component's checkout, where Complete lands */
  target: string
  base: string
  commits: BranchCommit[]
  /** git diff --name-status: A, M, D, R100, … */
  files: { status: string; path: string }[]
  diff: string
  truncated: boolean
  ahead: number
  behind: number
  complete: { ready: boolean; reasons: string[] }
}

export interface CompleteEvalResult {
  id: string
  name: string
  command?: string
  status: "passed" | "failed" | "skipped" | "violation" | string
  seconds?: number
}

/** POST tasks/{id}/complete */
export interface CompleteResult {
  task: string
  merge_commit: string
  /** ids that moved to done: the task, then its story and epic when they qualified */
  changed: string[]
  evals: CompleteEvalResult[]
  /** which evals ran: the task's listed ones, all of the story's (its last open task), none, or "landed" (an earlier attempt already merged) */
  eval_scope?: "task" | "story" | "none" | "landed"
  /** "no evals run" when the task listed none and was not the story's last open task */
  note?: string
  cleanup_warnings: string[]
}

export interface FailedEval {
  id: string
  name: string
  command: string
  seconds: number
  output_tail: string
}

/** details[0] of a 409 from POST tasks/{id}/complete */
export type CompleteRefusal =
  | { step: "preconditions"; reason: string; reasons?: string[] }
  | { step: "merge"; reason: string; conflicts: string[]; task_head_restored: boolean }
  | { step: "evals"; reason: string; failed: FailedEval[] }
  | { step: "sandbox"; reason: string; eval: string; violations: string[] }
  | { step: "target-moved"; reason: string }
  | { step: "land"; reason: string }

/** GET/POST agent-queue */
export interface AgentQueue {
  enabled: boolean
  limit: number
  changed_by: string | null
  changed_at: string | null
  running: string[]
  waiting: string[]
}

export interface AgentQueueUpdate {
  enabled?: boolean
  limit?: number
  confirm?: boolean
}

/** GET verification/history: one snapshot per evidence ingest, oldest first */
export interface VerificationSnapshot {
  at: string
  commit?: string | null
  run?: string | null
  criteria: Partial<Record<VerificationStatus, number>>
  criteria_total: number
  verified_ratio: number
}

// ------------------------------------------------------------------ session history (REQ-0062)
/** a quiet spell of 14 days or more since the last session that is not recorded yet */
export interface PendingGap {
  from: string
  to: string
  days: number
  /** deliberate when the project was paused with a reason since the last session */
  gap: "deliberate" | "unexplained"
  pause_reason: string
}

/** a gap as recorded in history/sessions.jsonl */
export interface HistoryGap extends PendingGap {
  type: "gap"
  project: string
  user: string
  reason: string
  at: string
}

export interface HistoryPause {
  type: "pause"
  project: string
  user: string
  at: string
  reason: string
}
