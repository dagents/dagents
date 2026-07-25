/**
 * Daemons page data fetchers (Task 11).
 *
 * - Task queue: projected from `/api/agents` — the dispatch server exposes no
 *   list endpoint for `dispatch_tasks`, but each agent row carries its latest
 *   task (`task_id`/`task_status`/`task_created_at`/`finished_at`/`run_id`), so
 *   we project those into a `DispatchTask` per agent. This matches the
 *   placeholder posture the plan calls out (timeline = "list of dispatch_tasks
 *   with status=running"); a future `/api/dispatch/tasks` list route can swap
 *   in unchanged by replacing this one fetcher.
 * - Fleet stats: from `/api/fleet-stats` (existing proxy → dispatch
 *   `GET /fleet-stats`). The upstream payload is the rich `FleetStats` shape
 *   from `lib/fleet-stats.ts`; we project it down to the four-card summary the
 *   daemons page renders.
 *
 * Status mapping: the `dispatch_tasks.status` CHECK allows
 * `queued`/`claimed`/`running`/`completed`/`failed`. The daemons UI collapses
 * that to the four buckets the filter chips carry:
 *   - `queued` + `claimed` → `queued` (pending work)
 *   - `running`            → `running`
 *   - `completed`          → `done`
 *   - `failed`             → `failed`
 */

export type DispatchTaskStatus = 'queued' | 'running' | 'done' | 'failed'

export interface DispatchTask {
  id: string
  /** Agent kind (prompt / claude / codex / remote) — proxy for task "type". */
  type: string
  status: DispatchTaskStatus
  /** Agent name — proxy for the task description (no description column on dispatch_tasks). */
  description: string | null
  /** Owning run id (the run the task belongs to). */
  flow_id: string | null
  /** Not surfaced by the agents list; default 0 so the priority badge renders. */
  priority: number
  created_at: string
  /** `finished_at` when terminal, else `created_at` (so the timeline step time is honest). */
  updated_at: string
}

export interface FleetStats {
  online_daemons: number
  active_tasks: number
  queue_depth: number
  throughput_per_min: number
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** Row shape from `/api/agents` (snake_case from pg, mirrors `agents-catalog.ts`). */
interface AgentListRow {
  id: string
  name: string
  kind: string
  task_id: string | null
  run_id: string | null
  task_status: string | null
  task_created_at: Date | string | null
  finished_at: Date | string | null
}

/** Subset of the real `GET /fleet-stats` payload we project into `FleetStats`. */
interface FleetStatsPayload {
  windowHours: number
  fleet: {
    daemons: { byStatus: Record<string, number>; total: number }
    tasks: { byStatus: Record<string, number>; total: number }
  }
  throughput: {
    tasks: { completed: number; failed: number; total: number }
  }
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status})`)
  }
  const body = (await res.json()) as Envelope<T>
  if (!body.success || body.data === undefined) {
    throw new Error(`${label} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data
}

/** Map a raw `dispatch_tasks.status` value to the UI's four-bucket status. */
function mapTaskStatus(raw: string | null): DispatchTaskStatus | null {
  if (!raw) return null
  if (raw === 'running') return 'running'
  if (raw === 'queued' || raw === 'claimed') return 'queued'
  if (raw === 'completed' || raw === 'done') return 'done'
  if (raw === 'failed') return 'failed'
  return null
}

function toDateStr(d: Date | string | null | undefined): string | null {
  if (d == null) return null
  return d instanceof Date ? d.toISOString() : d
}

/**
 * Fetch the dispatch task queue, projected from `/api/agents`. Each agent row
 * contributes at most one task (its latest); agents with no current task are
 * dropped. `statusFilter` filters client-side to one of the four UI buckets
 * (`queued`/`running`/`done`/`failed`); omit it for the full list.
 */
export async function fetchDispatchTasks(statusFilter?: DispatchTaskStatus): Promise<DispatchTask[]> {
  const data = await unwrap<{ agents: AgentListRow[]; truncated: boolean }>(
    await fetch('/api/agents', { cache: 'no-store' }),
    'dispatch tasks',
  )
  const tasks: DispatchTask[] = []
  for (const a of data.agents) {
    if (!a.task_id) continue
    const status = mapTaskStatus(a.task_status)
    if (!status) continue
    if (statusFilter && status !== statusFilter) continue
    const createdAt = toDateStr(a.task_created_at) ?? new Date().toISOString()
    const updatedAt = toDateStr(a.finished_at) ?? createdAt
    tasks.push({
      id: a.task_id,
      type: a.kind,
      status,
      description: a.name,
      flow_id: a.run_id,
      priority: 0,
      created_at: createdAt,
      updated_at: updatedAt,
    })
  }
  return tasks
}

/**
 * Fetch the fleet summary, projected from the real `/api/fleet-stats` payload
 * into the four numbers the daemons stats card renders. `queue_depth` folds
 * `queued` + `claimed` together (pending work); `active_tasks` is the live
 * `running` count; `throughput_per_min` is the window's terminal task total
 * over the window minutes (0 when no window).
 */
export async function fetchFleetStats(): Promise<FleetStats> {
  const data = await unwrap<FleetStatsPayload>(
    await fetch('/api/fleet-stats', { cache: 'no-store' }),
    'fleet stats',
  )
  const taskByStatus = data.fleet?.tasks?.byStatus ?? {}
  const daemonByStatus = data.fleet?.daemons?.byStatus ?? {}
  const hours = data.windowHours > 0 ? data.windowHours : 0
  const minutes = hours * 60
  const throughputPerMin =
    minutes > 0 ? (data.throughput?.tasks?.total ?? 0) / minutes : 0
  return {
    online_daemons: daemonByStatus.online ?? 0,
    active_tasks: taskByStatus.running ?? 0,
    queue_depth: (taskByStatus.queued ?? 0) + (taskByStatus.claimed ?? 0),
    throughput_per_min: throughputPerMin,
  }
}
