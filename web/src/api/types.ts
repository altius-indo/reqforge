// Wire types for the reqforge JSON API. These mirror reqforge/api.py, query.py, changes.py and
// chat.py exactly; the Rust backend serves the same shapes, so change both sides together.

export type Kind = "requirements" | "epics" | "stories" | "tasks"
export type Tab = Kind | "trace" | "lint" | "changes"
export const KINDS: Kind[] = ["requirements", "epics", "stories", "tasks"]

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
}

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
