/**
 * Lab domain model + pure mappers + fetch wrappers (M5b.2 / P1.10.T7).
 *
 * The Lab 多 agent 聊天室 is the multi-agent collaboration room. The data comes
 * from the console's own `/api/lab/*` proxy routes (which forward to the
 * gateway's `/api/v1/lab/*` API — see `apps/gateway/src/routes/lab.ts`). This
 * module owns:
 *
 *   - the typed domain model the view renders (`LabSessionSummary`,
 *     `LabSessionDetail`, `LabMessage`, `LabToolCall`, `LabThreadMessage`,
 *     `LabMention`)
 *   - **pure** mappers that turn the gateway rows into the domain model
 *     (`sessionStatusLabel`, `roleAvatarClass`, `roleInitial`, `roleName`,
 *     `roleTag`, `parseMentions`, `normalizeToolCall`, `messagesToThread`).
 *     Pure = no network, no React — so they are unit-testable in vitest's node
 *     environment, matching `agents-catalog.ts` / `workspaces.ts`.
 *   - thin `fetch` wrappers (`fetchLabSessions` / `fetchLabSessionDetail` /
 *     `sendLabMessage`) that throw on non-2xx, mirroring `agents-catalog.ts`.
 *
 * ## Threading
 *
 * The gateway returns the thread oldest-first. `messagesToThread` keeps that
 * order and attaches a day-separator label ("今天" / "昨天" / `M月D日`) to the
 * first message of each day, exactly like `threadToMessages` in
 * `workspaces.ts`. The MVP renders the thread as a flat chronological stream
 * (matching design/lab.html); `parentId` is preserved on each message for a
 * future reply-indentation view.
 *
 * ## thinking + tool blocks
 *
 * A `LabMessage` may carry a `thinking` string (the agent's private reasoning,
 * rendered as an italic "💭 …" note) and a `toolCall` `{ name, input, output }`
 * blob (rendered as a mono "🛠 tool" card). `normalizeToolCall` tolerates the
 * jsonb coming back as an already-shaped object OR a raw Flowise
 * `usedTools`/`calledTools` array element — it picks the first tool's name +
 * best-effort input/output strings so the card always renders.
 *
 * ## @mentions
 *
 * `parseMentions` extracts `@agent` tokens from a message body so the view can
 * color them; the composer also offers mention chips (`@orchestrator`,
 * `@reader`, `@coder`, `@verifier`) that insert the token into the textarea.
 */

/** One experiment session row in the left list. */
export interface LabSessionSummary {
  id: string
  name: string
  description: string | null
  /** `running` | `paused` | `done`. */
  status: LabSessionStatus
  workspaceId: string | null
  /** `auto` | `assist`. */
  mode: LabSessionMode
  agentsCount: number
  messageCount: number
  createdAt: string
  updatedAt: string
}

/** Lifecycle of a lab session (mirrors the DB CHECK). */
export type LabSessionStatus = 'running' | 'paused' | 'done'

/** Collaboration mode (mirrors the DB CHECK). */
export type LabSessionMode = 'auto' | 'assist'

/** Who authored a lab message (mirrors the DB CHECK). */
export type LabMessageRole = 'human' | 'orchestrator' | 'reader' | 'coder' | 'verifier' | 'system'

/** Structured tool-call block the chat renders as a mono "🛠 tool" card. */
export interface LabToolCall {
  name: string
  input?: string
  output?: string
}

/** One raw message row from the gateway (camelCased). */
export interface LabMessage {
  id: string
  sessionId: string
  parentId: string | null
  role: LabMessageRole
  agentId: string | null
  runId: string | null
  body: string
  thinking: string | null
  toolCall: LabToolCall | null
  createdAt: string
}

/** One session's full detail (the chat header + center thread). */
export interface LabSessionDetail {
  session: {
    id: string
    name: string
    description: string | null
    status: LabSessionStatus
    workspaceId: string | null
    mode: LabSessionMode
    agentsCount: number
    createdAt: string
    updatedAt: string
  }
  messages: LabMessage[]
}

/**
 * One chat message derived for the view (the center thread). Carries the
 * precomputed avatar class / initial / name / role tag / time / day separator
 * + the parsed @mentions so the bubble renders without re-deriving per frame.
 */
export interface LabThreadMessage {
  /** Stable key for React (the message id). */
  key: string
  role: LabMessageRole
  /** Avatar CSS class (`.msg-avatar.<role>` colors the bubble). */
  avatarClass: string
  /** Avatar initial (the role's glyph). */
  initial: string
  /** Display name (the agent_id, or "你" for a human turn). */
  name: string
  /** Mono role tag (e.g. "@reader · reader", "人工介入"). */
  roleTag: string
  /** `HH:MM` for the message head. */
  time: string
  /** Day separator label — non-empty only on the first message of a new day. */
  day?: string
  /** OTel run id this turn belongs to (end-to-end traceable). */
  runId?: string
  /** The message body (with @mentions left inline for the view to color). */
  body: string
  /** @mention tokens parsed out of the body (for chip-coloring). */
  mentions: LabMention[]
  /** The agent's private reasoning (the "💭 …" note); null when absent. */
  thinking: string | null
  /** The structured tool-call block (the "🛠 tool" card); null when absent. */
  toolCall: LabToolCall | null
}

/** One @mention parsed out of a message body. */
export interface LabMention {
  /** The bare token without `@` (e.g. "orchestrator"). */
  handle: string
}

/** The mention chips the composer offers (design/lab.html's `.mention` set). */
export const LAB_MENTION_HANDLES = ['orchestrator', 'reader', 'coder', 'verifier'] as const

// ─── pure mappers ─────────────────────────────────────────────────────────

/** The list chip label for a session status (mirrors the design's 进行/暂停/完成). */
export function sessionStatusLabel(status: LabSessionStatus): string {
  switch (status) {
    case 'running':
      return '进行'
    case 'paused':
      return '暂停'
    case 'done':
      return '完成'
  }
}

/** The avatar CSS class for a role (design/lab.html's `.msg-avatar.<role>`). */
export function roleAvatarClass(role: LabMessageRole): string {
  // `system` reuses the orchestrator's accent tint so a system note reads as
  // an orchestrator-level announcement rather than a 6th color the design
  // doesn't define.
  if (role === 'system') return 'orchestrator'
  return role
}

/** The avatar initial for a role (design/js/lab-data.js `ROLE_AVATAR`). */
export function roleInitial(role: LabMessageRole): string {
  switch (role) {
    case 'human':
      return 'H'
    case 'orchestrator':
      return 'O'
    case 'reader':
      return 'R'
    case 'coder':
      return 'C'
    case 'verifier':
      return 'V'
    case 'system':
      return 'S'
  }
}

/** The display name for a role + agentId (falls back to the role label). */
export function roleName(role: LabMessageRole, agentId: string | null): string {
  if (role === 'human') return '你'
  if (agentId) return agentId
  // No agentId — fall back to the role's default name (design/lab-data.js ROLE_NAME).
  switch (role) {
    case 'orchestrator':
      return 'orchestrator-01'
    case 'reader':
      return 'reader-04'
    case 'coder':
      return 'coder-12'
    case 'verifier':
      return 'verifier-07'
    case 'system':
      return 'system'
  }
}

/** The mono role tag for a message head (design/lab-data.js `ROLE_TAG`). */
export function roleTag(role: LabMessageRole, agentId: string | null): string {
  switch (role) {
    case 'human':
      return '人工介入'
    case 'orchestrator':
      return '@orchestrator'
    case 'reader':
      return '@reader · reader'
    case 'coder':
      return '@coder · coding'
    case 'verifier':
      return '@verifier · verify'
    case 'system':
      return agentId ?? 'system'
  }
}

/**
 * The @mention regex, shared by the parser (`parseMentions`) and the renderer
 * (`splitBodyMentions`) so parsing and rendering are single-source. A handle is
 * `[A-Za-z][A-Za-z0-9_-]*` immediately after a `@` that is itself at the start
 * of the string or preceded by a non-word character — so an email-ish
 * `user@host` does NOT count as a mention of `host` (the `@` there follows the
 * word char `r`). The `g` flag is set for use with `exec` / `split`; callers
 * that re-use the instance reset `lastIndex` themselves.
 *
 * The leading-capture form (no capturing group around `@`) lets `String.split`
 * keep the full `@handle` token in the output array, so the renderer can color
 * it without re-deriving the match.
 */
export const MENTION_RE = /(?<![\w])@[A-Za-z][A-Za-z0-9_-]*/g

/**
 * Extract `@handle` tokens from a message body. A handle is `[A-Za-z][A-Za-z0-9_-]*`
 * immediately after a `@` that is itself at the start of the string or preceded
 * by a non-word character — so an email-ish `user@host` does NOT count as a
 * mention of `host`. Returns the bare handles (no `@`), de-duplicated,
 * order-preserving. Used to color mention chips inside a bubble.
 */
export function parseMentions(body: string): LabMention[] {
  const seen = new Set<string>()
  const out: LabMention[] = []
  // Fresh regex instance so a shared `MENTION_RE` with `g` can't leak
  // `lastIndex` across calls (a module-level `/g` reused by `exec` is stateful).
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const handle = m[0]!.slice(1) // strip the leading `@`
    if (!seen.has(handle)) {
      seen.add(handle)
      out.push({ handle })
    }
  }
  return out
}

/**
 * Split a message body into alternating plain-text / `@handle` segments for
 * inline coloring. Uses the SAME regex as `parseMentions` so a token the
 * parser counts as a mention is exactly the token the renderer colors (the
 * email-exclusion behavior is shared — `user@host` is NOT split into a colored
 * `@host`). Returns segments in source order; the caller renders a mention
 * segment as a colored chip and the rest as plain text.
 */
export interface BodySegment {
  /** The segment text (includes the leading `@` for a mention). */
  text: string
  /** `true` for an @mention segment, `false` for plain text. */
  mention: boolean
}

export function splitBodyMentions(body: string): BodySegment[] {
  // `String.split` with a leading-capture regex keeps the matched `@handle`
  // tokens in the output array, interleaved with the plain-text runs. A match
  // at the very start/end yields empty boundary strings (`'@x'` → `['', '@x', '']`);
  // drop those so the renderer doesn't emit empty `<span>`s.
  const parts = body.split(new RegExp(`(${MENTION_RE.source})`, MENTION_RE.flags))
  return parts
    .filter((text) => text.length > 0)
    .map((text) => ({ text, mention: text.startsWith('@') && text.length > 1 }))
}

/**
 * Normalize an opaque jsonb tool_call into the `LabToolCall` the card renders.
 *
 * The gateway stores `tool_call` as a structured `{ name, input, output }`
 * (the append route validates that shape), so the common case is a passthrough.
 * This also tolerates a Flowise `usedTools`/`calledTools` array element
 * (`{ tool: { name }, input, output }`) so a future agent write path that
 * forwards Flowise's SSE event verbatim still renders a card — it picks the
 * first tool's name + best-effort string input/output. Returns `null` when the
 * blob has no usable name (so the card is simply omitted, not rendered empty).
 */
export function normalizeToolCall(raw: unknown): LabToolCall | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  // Already-shaped { name, input, output }.
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    return {
      name: obj.name,
      input: typeof obj.input === 'string' ? obj.input : obj.input === undefined ? undefined : JSON.stringify(obj.input),
      output: typeof obj.output === 'string' ? obj.output : obj.output === undefined ? undefined : JSON.stringify(obj.output),
    }
  }

  // Flowise usedTools/calledTools element: { tool: { name, ... }, input, output }.
  const tool = obj.tool
  if (typeof tool === 'object' && tool !== null) {
    const t = tool as Record<string, unknown>
    if (typeof t.name === 'string' && t.name.length > 0) {
      return {
        name: t.name,
        input: typeof obj.input === 'string' ? obj.input : undefined,
        output: typeof obj.output === 'string' ? obj.output : undefined,
      }
    }
  }

  return null
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

/**
 * Turn a list of messages (oldest-first, as the gateway returns them) into the
 * view's thread model. The first message of each day carries a `day` separator
 * label. `parentId` is preserved for a future reply-indentation view but does
 * not drive the flat MVP layout.
 *
 * `now` is injectable so the day-separator math is deterministic in tests.
 */
export function messagesToThread(
  rows: readonly LabMessage[],
  now: Date = new Date(),
): LabThreadMessage[] {
  const out: LabThreadMessage[] = []
  let lastDay = ''
  for (const row of rows) {
    const day = dayLabel(row.createdAt, now)
    const showDay = day !== lastDay
    if (showDay) lastDay = day
    out.push({
      key: row.id,
      role: row.role,
      avatarClass: roleAvatarClass(row.role),
      initial: roleInitial(row.role),
      name: roleName(row.role, row.agentId),
      roleTag: roleTag(row.role, row.agentId),
      time: hhmm(row.createdAt),
      ...(showDay ? { day } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
      body: row.body,
      mentions: parseMentions(row.body),
      thinking: row.thinking,
      toolCall: normalizeToolCall(row.toolCall),
    })
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

/** GET /api/lab/sessions — the experiment session list. */
export async function fetchLabSessions(signal?: AbortSignal): Promise<LabSessionSummary[]> {
  const data = await unwrap<{ items: LabSessionSummary[] }>(
    await fetch('/api/lab/sessions', { cache: 'no-store', signal }),
    'lab session list',
  )
  return data.items
}

/** GET /api/lab/sessions/:id — one session's detail + full thread. */
export async function fetchLabSessionDetail(id: string, signal?: AbortSignal): Promise<LabSessionDetail> {
  return unwrap<LabSessionDetail>(
    await fetch(`/api/lab/sessions/${encodeURIComponent(id)}`, { cache: 'no-store', signal }),
    'lab session detail',
  )
}

/** Params for a session patch (mode and/or status). At least one is required. */
export interface PatchLabSessionParams {
  sessionId: string
  mode?: LabSessionMode
  status?: LabSessionStatus
  signal?: AbortSignal
}

/** PATCH /api/lab/sessions/:id — update mode (auto/assist) and/or status; returns the updated session. */
export async function patchLabSession(params: PatchLabSessionParams): Promise<LabSessionSummary> {
  const res = await fetch(`/api/lab/sessions/${encodeURIComponent(params.sessionId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  })
  const data = await unwrap<{ session: LabSessionSummary }>(res, 'lab session patch')
  return data.session
}

/** Params for appending a turn to a session thread. */
export interface SendLabMessageParams {
  sessionId: string
  role: LabMessageRole
  body: string
  agentId?: string
  parentId?: string
  thinking?: string
  toolCall?: LabToolCall
  /** Optional caller-supplied run id; forwarded as `x-run-id` for trace pinning. */
  runId?: string
  signal?: AbortSignal
}

/** POST /api/lab/sessions/:id/messages — append one turn; returns the new message. */
export async function sendLabMessage(params: SendLabMessageParams): Promise<LabMessage> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (params.runId) headers['x-run-id'] = params.runId
  const res = await fetch(`/api/lab/sessions/${encodeURIComponent(params.sessionId)}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      role: params.role,
      body: params.body,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.parentId ? { parentId: params.parentId } : {}),
      ...(params.thinking ? { thinking: params.thinking } : {}),
      ...(params.toolCall ? { toolCall: params.toolCall } : {}),
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  })
  const data = await unwrap<{ message: LabMessage }>(res, 'lab append')
  return data.message
}
