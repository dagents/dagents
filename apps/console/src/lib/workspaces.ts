/**
 * Workspace domain model + pure mappers + fetch wrappers (M5b.1 / P1.10.T6).
 *
 * The Workspace 项目对话页 is the per-project collaboration surface. The data
 * comes from the console's own `/api/workspaces/*` proxy routes (which forward
 * to the gateway's `/api/v1/workspaces/*` read API — see
 * `apps/gateway/src/routes/workspaces.ts`). This module owns:
 *
 *   - the typed domain model the view renders (`WorkspaceSummary`,
 *     `WorkspaceDetail`, `WorkspaceMember`, `LinkedFlow`, `ThreadMessage`,
 *     `WorkspaceQuota`, `QuotaFacet`, `ArtifactCounts`)
 *   - **pure** mappers that turn the gateway rows into the domain model
 *     (`mapQuota`, `quotaPercent`, `quotaBars`, `deriveProjectStatus`,
 *     `threadToMessages`, `attachmentName`). Pure = no network, no React — so
 *     they are unit-testable in vitest's node environment, matching
 *     `agents-catalog.ts` / `flows.ts`.
 *   - thin `fetch` wrappers (`fetchWorkspaces` / `fetchWorkspaceDetail` /
 *     `fetchWorkspaceThread`) that throw on non-2xx, mirroring
 *     `agents-catalog.ts`.
 *
 * ## Conversation thread = run history
 *
 * There is no separate thread table on the client either. The gateway returns
 * `runs` scoped to the workspace; `threadToMessages` turns each run into one
 * or two chat messages (the user question from `run.input`, the agent answer
 * from `run.output`), preserving the OTel `run_id` so a message is
 * end-to-end traceable. Attachments are read from `run.artifact_uri` (an S3
 * URI; we surface the basename as a chip). The day separator ("今天" / "昨天" /
 * date) is derived client-side from `createdAt`.
 *
 * ## Quota
 *
 * `workspaces.quota` is a jsonb blob `{ cost, runs, tokens }`, each
 * `{ used, cap, unit? }`. The gateway normalizes it; `quotaBars` derives the
 * three bars the meta panel renders (width % + a warn/danger tint when over
 * 80% / 100%). Tokens are formatted with `formatTokens` (K/M) so the bar label
 * stays compact.
 */

/** One project row in the left list. */
export interface WorkspaceSummary {
  id: string
  name: string
  /** Avatar glyph (the project's initial); defaults to name[0]. */
  glyph: string
  description: string | null
  /** `active` | `archived`. */
  status: string
  memberCount: number
  flowCount: number
  createdAt: string
}

/** A workspace member (the meta panel "成员" section). */
export interface WorkspaceMember {
  id: string
  memberId: string
  displayName: string | null
  initial: string | null
  role: string
}

/** A flow linked to the workspace (the meta panel "关联 flow" card). */
export interface LinkedFlow {
  id: string
  /** Flowise flow id (the binding key). */
  pipelineId: string
  /** Live Flowise name (falls back to the pipelineId on a Flowise outage). */
  name: string
  /** `idle` | `paused` | `unknown` (best-effort from Flowise `deployed`). */
  status: string
  note: string | null
  updatedAt: string | null
}

/** One quota facet: used vs cap. */
export interface QuotaFacet {
  used: number
  cap: number
  unit?: string
}

/** The monthly quota blob (cost / runs / tokens). */
export interface WorkspaceQuota {
  cost?: QuotaFacet
  runs?: QuotaFacet
  tokens?: QuotaFacet
}

/** Produced-artifact counts by kind (the meta panel "产物" card). */
export interface ArtifactCounts {
  reports: number
  datasets: number
  patches: number
}

/** One workspace's full detail (the right meta panel + center chat header). */
export interface WorkspaceDetail {
  workspace: {
    id: string
    name: string
    glyph: string
    description: string | null
    ownerUserId: string | null
    status: string
    quota: WorkspaceQuota
    createdAt: string
    updatedAt: string
  }
  members: WorkspaceMember[]
  flows: LinkedFlow[]
  artifacts: ArtifactCounts
}

/** One chat message derived from a run (the center thread). */
export interface ThreadMessage {
  /** Stable key for React (the run id + a role suffix). */
  key: string
  role: 'human' | 'bot'
  /** Display name (the human owner, or "orchestrator" for a bot turn). */
  name: string
  /** Avatar initial(s). */
  initial: string
  /** `HH:MM` for the message head. */
  time: string
  /** Day separator label ("今天" / "昨天" / `M月D日`) — non-empty only on the
   *  first message of a new day. */
  day?: string
  /** OTel run id this turn belongs to (end-to-end traceable). */
  runId?: string
  /** The message body (the user question or the agent answer). */
  body: string
  /** Attachment basenames pulled from `run.artifact_uri`. */
  attachments: string[]
}

/** A row from the gateway thread endpoint (snake_case → camelCased). */
interface ThreadRow {
  id: string
  identifier: string
  pipelineId: string
  status: string
  input: unknown
  output: unknown
  artifactUri: string | null
  createdByUserId: string | null
  traceId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

// ─── pure mappers ─────────────────────────────────────────────────────────

/**
 * The console-visible project status. `archived` → `done`; `active` with no
 * recent thread → `idle`; `active` with a thread turn in the last day →
 * `running`. Mirrors the design's `running` / `idle` chips.
 */
export function deriveProjectStatus(
  status: string,
  latestThreadAt: string | null,
  now: Date = new Date(),
): 'running' | 'idle' | 'done' {
  if (status === 'archived') return 'done'
  if (!latestThreadAt) return 'idle'
  const ts = new Date(latestThreadAt).getTime()
  if (Number.isNaN(ts)) return 'idle'
  const dayMs = 24 * 60 * 60 * 1000
  return now.getTime() - ts < dayMs ? 'running' : 'idle'
}

/** Percentage (0–100) of a quota facet used; 0 when cap is 0/missing. */
export function quotaPercent(facet: QuotaFacet | undefined): number {
  if (!facet || !facet.cap || facet.cap <= 0) return 0
  return Math.min(100, Math.round((facet.used / facet.cap) * 100))
}

/** The bar tint for a facet: `danger` over 100%, `warn` over 80%, else none. */
export function quotaTint(percent: number): '' | 'warn' | 'danger' {
  if (percent >= 100) return 'danger'
  if (percent >= 80) return 'warn'
  return ''
}

/** The three quota bars the meta panel renders (cost / runs / tokens). */
export interface QuotaBar {
  key: 'cost' | 'runs' | 'tokens'
  label: string
  /** Formatted "used / cap" string (tokens in K/M, cost with unit). */
  value: string
  percent: number
  tint: '' | 'warn' | 'danger'
}

/** Format a token count compactly (K / M), dropping a trailing `.0`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}K`
  }
  return String(n)
}

/** Format a cost with its unit (default `$`). */
export function formatCost(used: number, unit?: string): string {
  const sym = unit === 'USD' ? '$' : unit ?? ''
  return `${sym}${used.toLocaleString('en-US')}`
}

/**
 * Build the three quota bars (cost / runs / tokens) the meta panel renders.
 * Missing facets yield an empty bar (0%); the design shows the row regardless
 * so the panel's "配额（本月）" card always has three rows.
 */
export function quotaBars(quota: WorkspaceQuota): QuotaBar[] {
  const cost = quota.cost
  const runs = quota.runs
  const tokens = quota.tokens
  const costPct = quotaPercent(cost)
  const runsPct = quotaPercent(runs)
  const tokensPct = quotaPercent(tokens)
  return [
    {
      key: 'cost',
      label: '成本',
      value: cost
        ? `${formatCost(cost.used, cost.unit)} / ${formatCost(cost.cap, cost.unit)}`
        : '— / —',
      percent: costPct,
      tint: quotaTint(costPct),
    },
    {
      key: 'runs',
      label: 'runs',
      value: runs ? `${runs.used} / ${runs.cap}` : '— / —',
      percent: runsPct,
      tint: quotaTint(runsPct),
    },
    {
      key: 'tokens',
      label: 'tokens',
      value: tokens ? `${formatTokens(tokens.used)} / ${formatTokens(tokens.cap)}` : '— / —',
      percent: tokensPct,
      tint: quotaTint(tokensPct),
    },
  ]
}

/**
 * Pull the basename out of an S3 URI / object key for an attachment chip.
 * `s3://bucket/runs/R-8821/results_skip.csv` → `results_skip.csv`. Returns
 * `null` when the uri is empty or has no basename.
 */
export function attachmentName(artifactUri: string | null): string | null {
  if (!artifactUri) return null
  const clean = artifactUri.split('?')[0]!
  const parts = clean.split(/[/]/).filter(Boolean)
  const last = parts[parts.length - 1]
  return last && last.includes('.') ? last : null
}

/** Day-separator label for a message timestamp, relative to `now`. */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - that.getTime()) / (24 * 60 * 60 * 1000))
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** `HH:MM` (local) for a message head. */
function hhmm(iso: string): string {
  const d = new Date(iso)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** Read a `question`-ish string out of an opaque `runs.input` JSONB blob. */
function readQuestion(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const k of ['question', 'prompt', 'message', 'text', 'q']) {
      if (typeof obj[k] === 'string') return obj[k] as string
    }
  }
  return ''
}

/** Read an answer string out of an opaque `runs.output` JSONB blob. */
function readAnswer(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    for (const k of ['text', 'answer', 'output', 'result', 'content']) {
      if (typeof obj[k] === 'string') return obj[k] as string
    }
  }
  return ''
}

/**
 * Build the scheduler fan-out body for a single Workspace conversation turn.
 *
 * The composer posts one turn at a time, so the "batch" is a single input —
 * the scheduler's fan-out endpoint is reused because it is the path that
 * writes a `runs` row carrying `workspace_id` (the thread's scoping key). The
 * scheduler creates a parent run + one child for the single input; the parent
 * is what the thread renders (its `input.question` is the user's turn, its
 * `output` the agent answer after the child settles and the parent aggregates).
 *
 * The body shape matches `fanOutBodySchema` in `apps/scheduler/src/app.ts`:
 * `{ flowId, pipelineId, identifier, inputs: [{ body }], workspaceId }`. The
 * child `body` is the Flowise prediction body (`{ question, streaming: false,
 * overrideConfig: { sessionId } }`) so the scheduler's prediction client posts
 * exactly what Flowise's `/api/v1/prediction/:flowId` expects — same shape the
 * chat proxy builds (`apps/console/src/app/api/chat/route.ts`). `streaming` is
 * `false` because the scheduler's prediction client awaits the full response
 * (it doesn't consume SSE); the turn surfaces in the thread once the run
 * completes, not token-by-token.
 *
 * `identifier` is a short human label for the run (shown as `runId` on the
 * message). `sessionId` carries the run id into Flowise Flow State
 * (architecture v0.2 §6.5) so a resumed session lands on the right memory.
 *
 * Pure (no network) so it is unit-testable and so the route + the client share
 * one builder with no drift.
 */
export function buildWorkspaceRunBody(input: {
  flowId: string
  question: string
  workspaceId: string
  /** The scheduler stamps this as `runs.id` (ON CONFLICT idempotent). */
  runId: string
  identifier: string
  /** Optional Flowise session id to continue a prior conversation. */
  sessionId?: string
}): {
  flowId: string
  pipelineId: string
  identifier: string
  inputs: Array<{ body: { question: string; streaming: boolean; overrideConfig: { sessionId: string } } }>
  workspaceId: string
} {
  return {
    flowId: input.flowId,
    // pipelineId mirrors flowId (architecture v0.2: the run's pipeline_id is
    // the Flowise flow id; see runs-repo.ts `RerunSource.flowId`).
    pipelineId: input.flowId,
    identifier: input.identifier,
    inputs: [
      {
        body: {
          question: input.question,
          streaming: false,
          overrideConfig: { sessionId: input.sessionId ?? input.runId },
        },
      },
    ],
    workspaceId: input.workspaceId,
  }
}

/**
 * Turn a list of thread runs into chat messages, newest-first (the gateway
 * returns newest-first). Each run becomes a user message (the question) +
 * an assistant message (the answer), unless the question/answer is empty.
 * The first message of each day carries a `day` separator label. The run id
 * (the OTel trace key) is attached to both messages of a turn.
 *
 * `ownerName` / `ownerInitial` label the human turns (the project owner, or a
 * fallback "成员" when unknown). Bot turns are labeled "orchestrator".
 */
export function threadToMessages(
  rows: readonly ThreadRow[],
  ownerName: string,
  ownerInitial: string,
  now: Date = new Date(),
): ThreadMessage[] {
  const out: ThreadMessage[] = []
  let lastDay = ''
  // rows are newest-first; render top-to-bottom oldest-first so the chat reads
  // chronologically. Walk oldest-first to assign day separators in order.
  for (const row of [...rows].reverse()) {
    const question = readQuestion(row.input)
    const answer = readAnswer(row.output)
    const attach = attachmentName(row.artifactUri)
    const day = dayLabel(row.createdAt, now)
    const showDay = day !== lastDay
    if (showDay) lastDay = day

    if (question) {
      out.push({
        key: `${row.id}:user`,
        role: 'human',
        name: ownerName,
        initial: ownerInitial,
        time: hhmm(row.createdAt),
        ...(showDay ? { day } : {}),
        // `identifier` is a non-null text column on `runs`, so a persisted
        // turn always carries a runId here. The `|| row.id` fallback only
        // fires for legacy rows with an empty identifier — that is the one
        // gap the ws-chat `含 run` filter keys on (it keeps only turns with a
        // truthy runId). Don't fall back to `row.id` there: a missing
        // identifier means the run id is genuinely unknown, and surfacing the
        // db uuid instead would make `含 run` indistinguishable from `全部`.
        ...(row.identifier ? { runId: row.identifier } : {}),
        body: question,
        attachments: [],
      })
    }
    if (answer) {
      out.push({
        key: `${row.id}:bot`,
        role: 'bot',
        name: 'orchestrator',
        initial: 'O',
        time: hhmm(row.createdAt),
        // only the first message of the turn carries the day separator
        ...(showDay && !question ? { day } : {}),
        ...(row.identifier ? { runId: row.identifier } : {}),
        body: answer,
        attachments: attach ? [attach] : [],
      })
    }
  }
  return out
}

// ─── fetch wrappers ───────────────────────────────────────────────────────

/** Envelope shared by all gateway routes (`{ success, data }` / `{ success, error }`). */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** Throw the gateway's `error` (or a generic fallback) on a non-success. */
async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

/** GET /api/workspaces — the project list. */
export async function fetchWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  const data = await unwrap<{ items: WorkspaceSummary[] }>(
    await fetch('/api/workspaces', { cache: 'no-store', signal }),
    'workspace list',
  )
  return data.items
}

/** GET /api/workspaces/:id — one project's full detail. */
export async function fetchWorkspaceDetail(id: string, signal?: AbortSignal): Promise<WorkspaceDetail> {
  return unwrap<WorkspaceDetail>(
    await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { cache: 'no-store', signal }),
    'workspace detail',
  )
}

/** GET /api/workspaces/:id/threads — the conversation thread (runs). */
export async function fetchWorkspaceThread(
  id: string,
  signal?: AbortSignal,
): Promise<ThreadRow[]> {
  const data = await unwrap<{ items: ThreadRow[]; nextBefore: string | null; nextBeforeId: string | null }>(
    await fetch(`/api/workspaces/${encodeURIComponent(id)}/threads`, { cache: 'no-store', signal }),
    'workspace thread',
  )
  return data.items
}

/**
 * POST /api/workspaces/:id/runs — start a new conversation turn.
 *
 * Posts a single-input fan-out to the scheduler (via the console proxy) so a
 * `runs` row carrying `workspace_id` lands; the next `fetchWorkspaceThread`
 * reconciles the optimistic message with the real row. Returns the scheduler's
 * `{ parentRunId }` so the caller can tag the optimistic turn with the run id
 * that will appear in the thread. Throws on a non-success (the proxy already
 * sanitized a dial failure to 502).
 */
export async function postWorkspaceRun(
  id: string,
  body: ReturnType<typeof buildWorkspaceRunBody>,
  signal?: AbortSignal,
): Promise<{ runId: string }> {
  const data = await unwrap<{ parentRunId: string }>(
    await fetch(`/api/workspaces/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
    'workspace run',
  )
  return { runId: data.parentRunId }
}
