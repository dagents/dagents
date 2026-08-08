'use client'

/**
 * AssistantContent — multica-style rendering of an assistant message.
 *
 * The inline executor tags different event kinds with closed labels
 * ([thinking]...[/thinking], [status]...[/status], [tool:Name]<input-json>...[/tool],
 * [tool-result]...[/tool-result], [error]...[/error], [log]...[/log]).
 *
 * Mirrors multica's `chat-message-list.tsx` timeline pattern:
 *
 *   1. Parse tagged content into segments.
 *   2. Split into three regions:
 *      - preface: text before the first non-text segment (leading reply)
 *      - middle:  first non-text → last non-text (inclusive; the "process":
 *                 thinking / tool-use / tool-result / error / intermediate text)
 *      - final:   text after the last non-text segment (trailing reply)
 *   3. Render preface + final as the main reply (no bubble — multica treats
 *      the assistant as a "content stream"). Render middle as an outer
 *      collapsible "N steps" group; each item inside also collapses
 *      independently (Conductor-style).
 *
 * Why a separate component: both floating-chat and chat-detail render
 * assistant messages the same way, so the parsing + rendering lives here
 * to avoid duplicating the tag grammar in two places.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon'

export interface Segment {
  kind: 'text' | 'thinking' | 'status' | 'tool-use' | 'tool-result' | 'error' | 'log'
  content: string
  /** Tool name for tool-use segments. */
  tool?: string
  /** Parsed tool-use input (for summary display). */
  input?: unknown
}

/**
 * Per-message run telemetry rendered in the assistant footer. Mirrors the
 * `chat:done` WS frame's `usage` / `durationMs` / `cost` and the persisted
 * `metadata.usage` / `metadata.durationMs` / `metadata.cost` shape. Either
 * field is optional — the footer renders whatever is present.
 */
export interface AssistantMessageMeta {
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  durationMs?: number
  cost?: number
}

/**
 * Extract an `AssistantMessageMeta` from a chat message's `metadata` blob
 * (DB-loaded messages carry `metadata.usage` / `metadata.durationMs` /
 * `metadata.cost`). Returns `undefined` when nothing useful is present so
 * callers can pass the result straight through to `<AssistantContent meta=… />`
 * without conditionals. Shared between `chat-detail` and `floating-chat` to
 * avoid duplicating the (typed) field-picking logic.
 */
export function extractMeta(metadata: Record<string, unknown> | null | undefined): AssistantMessageMeta | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined
  const meta: AssistantMessageMeta = {}
  const usage = metadata.usage
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    meta.usage = {
      inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : undefined,
      outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : undefined,
      cacheReadTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : undefined,
      cacheWriteTokens: typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : undefined,
    }
  }
  if (typeof metadata.durationMs === 'number') meta.durationMs = metadata.durationMs
  if (typeof metadata.cost === 'number') meta.cost = metadata.cost
  if (!meta.usage && meta.durationMs == null && meta.cost == null) return undefined
  return meta
}


/**
 * Parse the tagged-content format produced by inline-executor's eventToText.
 *
 * Grammar (each tag is a closed label):
 *   [thinking]...[/thinking]
 *   [tool:Name]<input-json>[/tool]
 *   [tool-result]...[/tool-result]
 *   [status]...[/status]
 *   [error]...[/error]
 *   [log]...[/log]
 *
 * Anything outside tags is a text segment (the assistant's main reply).
 * Unmatched/unclosed tags (legacy data, streaming partials) are parsed by
 * `parseOrphanTags` so their content becomes proper segments instead of
 * leaking raw `[thinking]` / `[status]` markers into the UI.
 */
export function parseAssistantContent(raw: string): Segment[] {
  const segments: Segment[] = []
  // Match [tag]content[/tag]. Note: `[tool:Name]` opens with `tool:Bash` but
  // closes with `[/tool]` (not `[/tool:Name]`), so we capture the tag name
  // and the optional `:Name` suffix separately, and the close tag uses just
  // the base name via backreference `\1`.
  //   Group 1: base tag (thinking | tool-result | tool | status | error | log)
  //   Group 2: tool name (only for `tool`, e.g. `Bash` from `[tool:Bash]`)
  //   Group 3: body content
  // `[\s\S]*?` lazily matches the body (incl. newlines) up to the close tag.
  const re = /\[(thinking|tool-result|tool|status|error|log)(?::([^\]]+))?\]([\s\S]*?)\[\/\1\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    // Text before this tag block — may contain orphan (unclosed) tags from
    // legacy output or streaming partials. Parse them into proper segments
    // so raw `[status]` / `[thinking]` markers don't leak into the UI.
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, '')
      if (text) segments.push(...parseOrphanTags(text))
    }
    const tag = match[1]
    const toolName = match[2] ?? undefined
    const rawBody = match[3] ?? ''
    const body = rawBody.replace(/^\n+|\n+$/g, '')
    if (tag === 'thinking') segments.push({ kind: 'thinking', content: body })
    else if (tag === 'tool') {
      // tool-use body is the input JSON (may be empty for tools with no input).
      let parsedInput: unknown
      if (rawBody) {
        try {
          parsedInput = JSON.parse(rawBody)
        } catch {
          parsedInput = undefined
        }
      }
      segments.push({ kind: 'tool-use', tool: toolName ?? 'tool', content: body, input: parsedInput })
    }
    else if (tag === 'tool-result') segments.push({ kind: 'tool-result', content: body })
    else if (tag === 'status') segments.push({ kind: 'status', content: body })
    else if (tag === 'error') segments.push({ kind: 'error', content: body })
    else if (tag === 'log') segments.push({ kind: 'log', content: body })
    lastIndex = re.lastIndex
  }
  // Trailing text (the tail of a streaming chunk before a tag closes, or
  // legacy content with no closed tags at all).
  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex).replace(/^\n+|\n+$/g, '')
    if (text) segments.push(...parseOrphanTags(text))
  }
  return segments
}

/**
 * Parse orphan (unclosed) tags from a text fragment into proper segments.
 *
 * Legacy eventToText output and streaming partials may emit `[thinking]xxx`
 * or `[status]xxx` without a matching close tag. Previously we stripped the
 * opening tag and kept the content as flat text — but that mixed thinking
 * content with the assistant's reply, producing an ugly unstructured block.
 *
 * Now we parse each orphan tag into its proper segment kind:
 *   - `[thinking] content`  → thinking segment (collapsible in ProcessFold)
 *   - `[status] content`    → skipped (noise: started/completed events)
 *   - `[log] content`       → skipped (noise)
 *   - `[error] content`     → error segment
 *   - `[tool:Name] content` → tool-use segment (when input parses as JSON)
 *
 * Content runs to end of line (or next `[` / EOL), matching the legacy
 * single-line tag format. This keeps the assistant's actual reply (on the
 * next line) as a separate text segment instead of merging it into thinking.
 */
function parseOrphanTags(text: string): Segment[] {
  const segments: Segment[] = []
  // Match an orphan opening tag + its content up to end-of-line / next `[`.
  // `[^\[\n]*` stops at newline or `[`, so multi-line replies stay separate.
  const orphanRe = /\[(thinking|tool-result|tool|status|error|log)(?::([^\]]+))?\][ \t]*([^[\n]*)(?=\n|\[|$)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = orphanRe.exec(text)) !== null) {
    // Text before this orphan tag.
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, '')
      if (before) segments.push({ kind: 'text', content: before })
    }
    const tag = match[1]
    const toolName = match[2] ?? undefined
    const body = (match[3] ?? '').trim()
    if (tag === 'thinking' && body) {
      segments.push({ kind: 'thinking', content: body })
    } else if (tag === 'tool' && body) {
      let parsedInput: unknown
      try { parsedInput = JSON.parse(body) } catch { parsedInput = undefined }
      segments.push({ kind: 'tool-use', tool: toolName ?? 'tool', content: body, input: parsedInput })
    } else if (tag === 'tool-result' && body) {
      segments.push({ kind: 'tool-result', content: body })
    } else if (tag === 'error' && body) {
      segments.push({ kind: 'error', content: body })
    }
    // status / log orphans are skipped — they're noise (started/completed).
    lastIndex = orphanRe.lastIndex
  }
  // Trailing text after the last orphan tag (or the whole text if no orphans).
  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).replace(/^\n+|\n+$/g, '')
    if (after) segments.push({ kind: 'text', content: after })
  }
  return segments
}

/**
 * Split segments into three regions, mirroring multica's `splitTimeline`:
 *   - preface: leading text segments (before the first non-text segment)
 *   - middle:  first non-text → last non-text (inclusive; sandwich text
 *              becomes intermediate "process" rows)
 *   - final:   trailing text segments (after the last non-text segment)
 *
 * status / log segments are filtered out before splitting — they're noise
 * (started/completed events and log lines) and shouldn't influence where
 * the process fold opens or closes.
 */
function splitSegments(segments: Segment[]): {
  preface: Segment[]
  middle: Segment[]
  final: Segment[]
} {
  const meaningful = segments.filter((s) => s.kind !== 'status' && s.kind !== 'log')
  if (meaningful.length === 0) return { preface: [], middle: [], final: [] }

  let firstNonText = -1
  let lastNonText = -1
  for (let i = 0; i < meaningful.length; i++) {
    if (meaningful[i].kind !== 'text') {
      if (firstNonText === -1) firstNonText = i
      lastNonText = i
    }
  }

  if (firstNonText === -1) {
    // All text — no process fold.
    return { preface: meaningful, middle: [], final: [] }
  }
  return {
    preface: meaningful.slice(0, firstNonText),
    middle: meaningful.slice(firstNonText, lastNonText + 1),
    final: meaningful.slice(lastNonText + 1),
  }
}

interface AssistantContentProps {
  content: string
  /** True while the assistant bubble is still accumulating WS chunks. */
  streaming?: boolean
  /** Run telemetry for the usage footer. Hidden while `streaming` is true. */
  meta?: AssistantMessageMeta
}

export function AssistantContent({ content, streaming, meta }: AssistantContentProps): React.ReactElement {
  const segments = parseAssistantContent(content)

  // No segments parsed (e.g. empty content or only whitespace) → render
  // a placeholder while streaming, or just the footer when settled.
  if (segments.length === 0) {
    return (
      <>
        {streaming ? <span className="assistant-cursor">▋</span> : null}
        {meta && !streaming ? <UsageFooter meta={meta} /> : null}
      </>
    )
  }

  const { preface, middle, final } = splitSegments(segments)

  // Decide where the streaming cursor lives: prefer the trailing final text
  // segment; if there is none, the trailing preface (no process fold); if
  // there is a process fold but no trailing text, the cursor rides on the
  // fold's last item (handled inside ProcessFold via isStreamingTail).
  const finalTextSegments = final.filter((s) => s.kind === 'text')
  const lastFinalIsText = finalTextSegments.length > 0
  const prefaceTextSegments = preface.filter((s) => s.kind === 'text')
  const cursorOnPreface = middle.length === 0 && prefaceTextSegments.length > 0
  const cursorOnFold = middle.length > 0 && !lastFinalIsText

  return (
    <div className="assistant-content">
      {/* preface: leading text (the assistant's opening reply) */}
      {preface.map((seg, i) => (
        <Fragment key={`pre-${i}`}>
          <TextBlock
            content={seg.content}
            streaming={streaming && cursorOnPreface && i === preface.length - 1}
          />
        </Fragment>
      ))}

      {/* middle: process fold ("N steps") — thinking / tool / tool-result / error */}
      {middle.length > 0 ? (
        <ProcessFold
          items={middle}
          streaming={streaming}
          cursorOnTail={cursorOnFold}
        />
      ) : null}

      {/* final: trailing text (the assistant's settled answer) */}
      {final.map((seg, i) => (
        <Fragment key={`fin-${i}`}>
          <TextBlock
            content={seg.content}
            streaming={streaming && lastFinalIsText && i === final.length - 1}
          />
        </Fragment>
      ))}

      {/* Usage footer — tokens / duration / cost. Only shown after the
          message settles (otherwise incomplete data would flash mid-stream). */}
      {meta && !streaming ? <UsageFooter meta={meta} /> : null}
    </div>
  )
}

/**
 * Usage footer — small muted line below the assistant's reply showing token
 * count, run duration, and $ cost. Renders only the parts that are present
 * (`input + output` tokens; cost as 4-decimal USD). Returns `null` when
 * nothing useful is in `meta`, so callers can always render the wrapper.
 */
function UsageFooter({ meta }: { meta: AssistantMessageMeta }): React.ReactElement | null {
  const parts: string[] = []
  const usage = meta.usage
  if (usage) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (total > 0) parts.push(formatTokens(total))
  }
  if (meta.durationMs != null) parts.push(formatDuration(meta.durationMs))
  if (meta.cost != null) parts.push(`$${meta.cost.toFixed(4)}`)
  if (parts.length === 0) return null
  return <div className="assistant-usage-footer">{parts.join(' · ')}</div>
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`
  return `${n} tokens`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Plain text block — the assistant's main reply (preface / final). */
function TextBlock({ content, streaming }: { content: string; streaming?: boolean }): React.ReactNode {
  if (!content) return null
  return (
    <div className="assistant-text">
      {content}
      {streaming ? <span className="assistant-cursor">▋</span> : null}
    </div>
  )
}

/**
 * Outer process fold — wraps the agent's "process" (thinking + tool calls +
 * tool results + errors + intermediate text) in a single collapsible group.
 *
 * Mirrors multica's `OuterProcessFold`:
 *   - Closed by default once the message settles; open while streaming.
 *   - Trigger shows "N steps" (e.g. "3 steps").
 *   - Body is a bordered card with each item rendered as its own row.
 */
function ProcessFold({
  items,
  streaming,
  cursorOnTail,
}: {
  items: Segment[]
  streaming?: boolean
  cursorOnTail?: boolean
}): React.ReactNode {
  // Open while the task streams (so the user watches progress), collapsed
  // once it settles. Mirrors multica's OuterProcessFold behaviour.
  const [open, setOpen] = useState(!!streaming)
  const wasStreaming = useRef(!!streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false)
    wasStreaming.current = !!streaming
  }, [streaming])

  const stepCount = items.length

  return (
    <div className="assistant-process">
      <button
        type="button"
        className="assistant-process-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon
          name={open ? 'chevronDown' : 'chevronRight'}
          style={{ width: 12, height: 12 }}
        />
        <span>{stepCount} 步骤</span>
      </button>
      {open ? (
        <div className="assistant-process-body">
          {items.map((item, i) => (
            <Fragment key={i}>
              <ProcessRow
                item={item}
                streaming={streaming && cursorOnTail && i === items.length - 1}
              />
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Single row inside the process fold — dispatches by segment kind. */
function ProcessRow({
  item,
  streaming,
}: {
  item: Segment
  streaming?: boolean
}): React.ReactNode {
  switch (item.kind) {
    case 'text':
      // Intermediate text inside the process fold — down-shifted to read as
      // part of the agent's process, not the final answer.
      return (
        <div className="assistant-process-text">
          {item.content}
          {streaming ? <span className="assistant-cursor">▋</span> : null}
        </div>
      )

    case 'thinking':
      return <ThinkingRow content={item.content} streaming={streaming} />

    case 'tool-use':
      return <ToolUseRow tool={item.tool ?? 'tool'} input={item.input} />

    case 'tool-result':
      return <ToolResultRow content={item.content} />

    case 'error':
      return (
        <div className="assistant-error">
          <Icon name="alertTriangle" style={{ width: 12, height: 12 }} />
          <span>{item.content}</span>
        </div>
      )

    default:
      return null
  }
}

/** Collapsible thinking row — grey italic preview, fold to expand. */
function ThinkingRow({
  content,
  streaming,
}: {
  content: string
  streaming?: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  if (!content) return null
  const preview = content.length > 150 ? content.slice(0, 150) + '…' : content

  return (
    <div className="assistant-row">
      <button
        type="button"
        className="assistant-row-trigger assistant-row-thinking"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name="brain" style={{ width: 12, height: 12 }} />
        <span className="assistant-row-preview">{preview}</span>
      </button>
      {open ? <pre className="assistant-row-body">{content}</pre> : null}
      {streaming ? <span className="assistant-cursor">▋</span> : null}
    </div>
  )
}

/** Collapsible tool-use row — tool name (bold) + input summary (muted). */
function ToolUseRow({
  tool,
  input,
}: {
  tool: string
  input?: unknown
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const summary = getToolSummary(input)
  const hasInput = input != null && Object.keys(input as Record<string, unknown>).length > 0

  return (
    <div className="assistant-row">
      <button
        type="button"
        className="assistant-row-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon
          name={hasInput ? (open ? 'chevronDown' : 'chevronRight') : 'chevronRight'}
          style={{ width: 12, height: 12, visibility: hasInput ? 'visible' : 'hidden' }}
        />
        <span className="assistant-row-toolname">{tool}</span>
        {summary ? <span className="assistant-row-summary">{summary}</span> : null}
      </button>
      {open && hasInput ? (
        <pre className="assistant-row-body">{JSON.stringify(input, null, 2)}</pre>
      ) : null}
    </div>
  )
}

/** Collapsible tool-result row — muted preview, fold to expand. */
function ToolResultRow({ content }: { content: string }): React.ReactNode {
  const [open, setOpen] = useState(false)
  if (!content) return null
  const preview = content.length > 120 ? content.slice(0, 120) + '…' : content

  return (
    <div className="assistant-row">
      <button
        type="button"
        className="assistant-row-trigger assistant-row-result"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon
          name={open ? 'chevronDown' : 'chevronRight'}
          style={{ width: 12, height: 12 }}
        />
        <span className="assistant-row-preview">{preview}</span>
      </button>
      {open ? (
        <pre className="assistant-row-body">
          {content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content}
        </pre>
      ) : null}
    </div>
  )
}

/** Shorten long file paths to ".../last-two-segments" (multica-style). */
function shortenPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '.../' + parts.slice(-2).join('/')
}

/**
 * Extract a one-line summary from a tool-use input, mirroring multica's
 * `getToolSummary`. Returns '' when nothing useful is found.
 */
function getToolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>
  if (typeof inp.query === 'string' && inp.query) return inp.query
  if (typeof inp.file_path === 'string' && inp.file_path) return shortenPath(inp.file_path)
  if (typeof inp.path === 'string' && inp.path) return shortenPath(inp.path)
  if (typeof inp.pattern === 'string' && inp.pattern) return inp.pattern
  if (typeof inp.description === 'string' && inp.description) return String(inp.description)
  if (typeof inp.command === 'string' && inp.command) {
    const cmd = String(inp.command)
    return cmd.length > 100 ? cmd.slice(0, 100) + '…' : cmd
  }
  if (typeof inp.prompt === 'string' && inp.prompt) {
    const p = String(inp.prompt)
    return p.length > 100 ? p.slice(0, 100) + '…' : p
  }
  if (typeof inp.skill === 'string' && inp.skill) return String(inp.skill)
  // Fallback: first short string value.
  for (const v of Object.values(inp)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 120) return v
  }
  return ''
}
