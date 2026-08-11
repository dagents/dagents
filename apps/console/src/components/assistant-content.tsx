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
import { ToolCallCard } from '@/components/tool-call-card'
import {
  classifyTool,
  extractSummary,
} from '@/lib/tool-call-parser'
import '@/styles/tool-call.css'

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

/** Plain text block — the assistant's main reply (preface / final).
 *  Now renders basic markdown (code blocks, inline code, bold, italic,
 *  links, lists, blockquotes, headings) via a lightweight formatter. */
function TextBlock({ content, streaming }: { content: string; streaming?: boolean }): React.ReactNode {
  if (!content) return null
  return (
    <div className="prose assistant-text">
      {renderMarkdown(content)}
      {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
    </div>
  )
}

/**
 * Lightweight inline markdown renderer — converts common patterns to
 * React elements without pulling in a full markdown library.
 * Supports: code blocks (```), inline code (`), bold (**), italic (*),
 * links [text](url), bullet/numbered lists, headings (#..####),
 * blockquotes (>), and horizontal rules (---).
 */
function renderMarkdown(text: string): React.ReactNode {
  const blocks: React.ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push(
        <pre key={key++} data-lang={lang || undefined}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const headingText = headingMatch[2]
      const Tag = (`h${Math.min(level + 1, 4)}`) as keyof React.JSX.IntrinsicElements
      blocks.push(<Tag key={key++}>{renderInline(headingText)}</Tag>)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        quoteLines.push(lines[i].slice(1).trim())
        i++
      }
      blocks.push(<blockquote key={key++}>{renderInline(quoteLines.join(' '))}</blockquote>)
      continue
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} />)
      i++
      continue
    }

    // Bullet list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>,
      )
      continue
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++}>
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ol>,
      )
      continue
    }

    // Empty line — skip
    if (line.trim() === '') { i++; continue }

    // Paragraph (accumulate consecutive non-empty, non-special lines)
    const paraLines: string[] = []
    while (i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('>') &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push(<p key={key++}>{renderInline(paraLines.join(' '))}</p>)
    }
  }

  return blocks
}

/** Render inline markdown: `code`, **bold**, *italic*, [links](url). */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  // Pattern matches: `code` | **bold** | *italic* | [text](url)
  const re = /(`[^`]+`)|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/

  while (remaining.length > 0) {
    const match = re.exec(remaining)
    if (!match) {
      parts.push(remaining)
      break
    }
    if (match.index > 0) {
      parts.push(remaining.slice(0, match.index))
    }
    if (match[1]) {
      // inline code
      parts.push(<code key={key++}>{match[1].slice(1, -1)}</code>)
    } else if (match[2]) {
      parts.push(<strong key={key++}>{match[2]}</strong>)
    } else if (match[3]) {
      parts.push(<em key={key++}>{match[3]}</em>)
    } else if (match[4] && match[5]) {
      // Sanitize href: only allow http(s) URLs, block javascript:/data: schemes
      const rawHref = match[5]
      const safeHref = /^(https?:\/\/|mailto:)/i.test(rawHref) ? rawHref : '#'
      parts.push(<a key={key++} href={safeHref} target="_blank" rel="noopener noreferrer">{match[4]}</a>)
    }
    remaining = remaining.slice(match.index + match[0].length)
  }

  return parts.length === 1 ? parts[0] : <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>
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

/** Collapsible thinking section — grey italic preview, fold to expand.
 *  Uses the new `.thinking-section` styles from tool-call.css: a labeled
 *  "思考" header with a brain icon, italic muted preview, and an indented
 *  italic body block. Streams show the cursor while the tag is open. */
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
    <div className="thinking-section">
      <button
        type="button"
        className="thinking-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="thinking-trigger-icon" style={{ width: 12, height: 12 }} />
        <Icon name="brain" className="thinking-trigger-icon" style={{ width: 12, height: 12 }} />
        <span className="thinking-trigger-label">思考</span>
        <span className="thinking-preview">{preview}</span>
        {streaming ? <span className="assistant-cursor">▋</span> : null}
      </button>
      {open ? <div className="thinking-body">{content}</div> : null}
    </div>
  )
}

/** Collapsible tool-use row — delegates to the structured ToolCallCard
 *  (typed icon/color header + summary + JSON body + copy button + file
 *  diff view for write/edit tools). Replaces the old flat mono preview. */
function ToolUseRow({
  tool,
  input,
}: {
  tool: string
  input?: unknown
}): React.ReactElement {
  // Normalize the input to a plain object for the card; non-object /
  // null inputs become undefined so the card renders without a body.
  const toolInput: Record<string, unknown> | undefined =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  return (
    <ToolCallCard
      toolName={tool}
      toolInput={toolInput}
      category={classifyTool(tool)}
      summary={extractSummary(toolInput)}
    />
  )
}

/** Collapsible tool-result row — muted mono preview, fold to expand.
 *  Uses the new `.tool-result-compact` styles from tool-call.css. */
function ToolResultRow({ content }: { content: string }): React.ReactNode {
  const [open, setOpen] = useState(false)
  if (!content) return null
  const preview = content.length > 120 ? content.slice(0, 120) + '…' : content

  return (
    <div className="tool-result-compact">
      <button
        type="button"
        className="tool-result-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon
          name={open ? 'chevronDown' : 'chevronRight'}
          className="tool-result-glyph"
          style={{ width: 12, height: 12 }}
        />
        <span className="tool-result-preview">{preview}</span>
      </button>
      {open ? (
        <pre className="tool-result-body">
          {content.length > 4000 ? content.slice(0, 4000) + '\n... (truncated)' : content}
        </pre>
      ) : null}
    </div>
  )
}

