/**
 * tool-call-parser.ts — structured parsing of agent execution tags.
 *
 * The gateway's inline-executor (`eventToText`) emits a tagged-content
 * format inside assistant messages:
 *
 *   [thinking]...[/thinking]               — agent's chain-of-thought
 *   [tool:Name]{input-json}[/tool]         — a tool call (input is compact JSON)
 *   [tool-result]...[/tool-result]         — textual result of the previous tool call
 *   [status]...[/status]                   — diagnostic noise (started/completed/retry)
 *   [error]...[/error]                     — runtime error
 *   [log]...[/log]                         — diagnostic log line
 *
 * This module parses that grammar into ordered `MessageSegment`s that the
 * UI can render directly (text blocks, tool-call cards, file diffs,
 * thinking folds, etc.). It is the structured sibling of the older
 * `parseAssistantContent` in `assistant-content.tsx` — same grammar, but
 * richer segment types (separate `tool-call` / `tool-result` / `thinking`
 * / `error` kinds with parsed payloads) and explicit handling of streaming
 * partials (an unclosed `[tool:Name]` shows as "执行中…" instead of
 * leaking raw tag text).
 *
 * Parsing rules
 *   1. Closed `[tag]body[/tag]` blocks become typed segments.
 *   2. Text between blocks becomes `text` segments.
 *   3. Streaming partials — an opening tag without a matching close — are
 *      detected and surfaced as an `in-progress` segment so the UI can
 *      show a spinner / "执行中…" placeholder. This is what makes the
 *      component stream-friendly: a half-arrived `[tool:Bash]{"command":"git`
 *      does not corrupt the rendered output.
 *   4. Status / log tags are dropped — they are noise (started/completed
 *      events, retry notices) and would only clutter the timeline.
 */

/** Tool category — drives the card's icon and accent color. */
export type ToolCategory = 'search' | 'edit' | 'terminal' | 'tool'

/** Discriminated union of parsed message segments. */
export type MessageSegment =
  | { type: 'text'; content: string }
  | {
      type: 'thinking'
      content: string
      /** True when the [thinking] tag opened but never closed (streaming). */
      inProgress?: boolean
    }
  | {
      type: 'tool-call'
      content: string
      toolName: string
      /** Parsed JSON input object (or the raw string if parsing failed). */
      toolInput: Record<string, unknown> | undefined
      /** Extracted headline field used for the card's summary line. */
      summary: string
      /** Category derived from the tool name (drives icon/color). */
      category: ToolCategory
      /** True when the [tool:Name] tag opened but never closed (streaming). */
      inProgress?: boolean
    }
  | {
      type: 'tool-result'
      content: string
      /** True when the [tool-result] tag opened but never closed. */
      inProgress?: boolean
    }
  | { type: 'error'; content: string }

/**
 * Tool-name → category mapping. Mirrors the card spec:
 *   - Read/View/Glob/Grep  → search (blue)
 *   - Write/Edit/Create    → edit   (green)
 *   - Bash/Execute/Command → terminal (purple)
 *   - anything else        → tool   (gray)
 *
 * Match is case-insensitive substring against the tool name, so new tool
 * names like `MultiEdit` or `ViewFile` get classified correctly without
 * needing an exact allowlist.
 */
const CATEGORY_RULES: ReadonlyArray<{ test: RegExp; category: ToolCategory }> = [
  { test: /read|view|glob|grep|search|find|list/i, category: 'search' },
  { test: /write|edit|create|patch|replace|update|insert|delete|remove/i, category: 'edit' },
  { test: /bash|execute|command|terminal|shell|run|spawn/i, category: 'terminal' },
]

/** Emoji glyph shown in the card header, by category. */
export const CATEGORY_GLYPH: Record<ToolCategory, string> = {
  search: '🔍',
  edit: '✏️',
  terminal: '💻',
  tool: '🔧',
}

/**
 * Classify a tool name into a category. Falls back to `tool` (gray) when
 * no rule matches. Used by the card component to pick an icon/color.
 */
export function classifyTool(toolName: string): ToolCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(toolName)) return rule.category
  }
  return 'tool'
}

/**
 * Shorten a file path to its last two segments with a leading `.../`.
 * Used for summary lines so long absolute paths stay readable.
 *   `/Users/x/projects/foo/src/index.ts` → `.../src/index.ts`
 */
export function shortenPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 3) return p
  return '.../' + parts.slice(-2).join('/')
}

/**
 * Extract a single-line summary from a parsed tool input. Picks the most
 * informative field present, in priority order. Returns `''` when nothing
 * useful is found so callers can fall back to a generic label.
 *
 * Recognized fields (in order):
 *   query, file_path, path, pattern, url, command, description, prompt, skill
 *
 * String values are truncated to ~120 chars; file paths are shortened.
 */
export function extractSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const pick = (key: string): string | undefined => {
    const v = input[key]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const query = pick('query')
  if (query) return truncate(query)
  const filePath = pick('file_path') ?? pick('path')
  if (filePath) return shortenPath(filePath)
  const pattern = pick('pattern')
  if (pattern) return truncate(pattern)
  const url = pick('url')
  if (url) return truncate(url)
  const command = pick('command')
  if (command) return truncate(command, 100)
  const description = pick('description')
  if (description) return truncate(description)
  const prompt = pick('prompt')
  if (prompt) return truncate(prompt, 100)
  const skill = pick('skill')
  if (skill) return skill
  // Fallback: first short string value on the object.
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 120) return v
  }
  return ''
}

/** Truncate a string to `max` chars, appending an ellipsis if shortened. */
function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Try to parse a tool body as JSON. The inline-executor emits compact
 * JSON; partial streaming chunks may be malformed. Returns the parsed
 * object or `undefined` (never throws).
 */
function tryParseToolInput(body: string): Record<string, unknown> | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    // Wrap non-object JSON (string/number) so the card still renders.
    return { value: parsed }
  } catch {
    return undefined
  }
}

/**
 * Parse the tagged-content format into ordered `MessageSegment`s.
 *
 * Handles both closed tags and streaming partials. Status / log tags are
 * dropped (they are noise). Whitespace-only text runs between tags are
 * dropped too, so the timeline stays compact.
 *
 * @example
 *   parseMessageContent('hi [tool:Bash]{"command":"ls"}[/tool] done')
 *   // → [
 *   //     { type: 'text', content: 'hi' },
 *   //     { type: 'tool-call', toolName: 'Bash', toolInput: { command: 'ls' }, summary: 'ls', category: 'terminal' },
 *   //     { type: 'text', content: 'done' },
 *   //   ]
 */
export function parseMessageContent(raw: string): MessageSegment[] {
  if (!raw) return []
  const segments: MessageSegment[] = []

  // Match closed `[tag]body[/tag]` blocks. `tool:Name` opens with the
  // tool name but closes with just `[/tool]`, so the base tag and the
  // optional `:Name` suffix are captured separately and the close tag
  // backreferences the base name.
  //   Group 1: base tag (thinking | tool-result | tool | status | error | log)
  //   Group 2: tool name suffix (only for `tool`, e.g. `Bash` from `[tool:Bash]`)
  //   Group 3: body
  const closedRe =
    /\[(thinking|tool-result|tool|status|error|log)(?::([^\]]+))?\]([\s\S]*?)\[\/\1\]/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = closedRe.exec(raw)) !== null) {
    // Text before this tag block.
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, '')
      if (text.trim()) segments.push({ type: 'text', content: text })
    }
    pushClosedSegment(segments, match[1], match[2], match[3] ?? '')
    lastIndex = closedRe.lastIndex
  }

  // Tail: text after the last closed tag — may contain streaming partials
  // (an open tag whose close hasn't arrived yet) or trailing prose.
  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex)
    segments.push(...parseTail(tail))
  }

  return segments
}

/** Build a segment for a closed tag match. */
function pushClosedSegment(
  segments: MessageSegment[],
  tag: string,
  toolNameSuffix: string | undefined,
  rawBody: string,
): void {
  const body = rawBody.replace(/^\n+|\n+$/g, '')

  if (tag === 'thinking') {
    if (body) segments.push({ type: 'thinking', content: body })
    return
  }
  if (tag === 'tool') {
    const toolName = (toolNameSuffix ?? 'tool').trim()
    const toolInput = tryParseToolInput(rawBody)
    segments.push({
      type: 'tool-call',
      content: body,
      toolName,
      toolInput,
      summary: extractSummary(toolInput),
      category: classifyTool(toolName),
    })
    return
  }
  if (tag === 'tool-result') {
    if (body) segments.push({ type: 'tool-result', content: body })
    return
  }
  if (tag === 'error') {
    if (body) segments.push({ type: 'error', content: body })
    return
  }
  // status / log — dropped (noise).
}

/**
 * Parse the tail of the input (after the last closed tag) for streaming
 * partials: an opening tag whose close hasn't arrived yet. Also handles
 * plain trailing text.
 *
 * A partial looks like `[tool:Bash]{"command":"git st` (no close). We
 * surface it as a tool-call segment with `inProgress: true` so the card
 * can render a "执行中…" placeholder. A partial `[thinking]...` becomes
 * a thinking segment; `[tool-result]...` a tool-result segment; `[error]`
 * an error segment.
 */
function parseTail(tail: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  // Match an opening tag + its (possibly empty / partial) body up to end
  // of input or the next opening `[`.
  const partialRe =
    /\[(thinking|tool-result|tool|status|error|log)(?::([^\]]+))?\]([\s\S]*?)$/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  let sawPartial = false
  while ((match = partialRe.exec(tail)) !== null) {
    sawPartial = true
    // Text before this partial tag.
    if (match.index > lastIndex) {
      const text = tail.slice(lastIndex, match.index).replace(/^\n+|\n+$/g, '')
      if (text.trim()) segments.push({ type: 'text', content: text })
    }
    const tag = match[1]
    const toolNameSuffix = match[2]
    const rawBody = match[3] ?? ''
    const body = rawBody.replace(/^\n+|\n+$/g, '')

    if (tag === 'thinking') {
      // Even an empty partial thinking shows as in-progress.
      segments.push({ type: 'thinking', content: body, inProgress: true })
    } else if (tag === 'tool') {
      const toolName = (toolNameSuffix ?? 'tool').trim()
      const toolInput = tryParseToolInput(rawBody)
      segments.push({
        type: 'tool-call',
        content: body,
        toolName,
        toolInput,
        summary: extractSummary(toolInput),
        category: classifyTool(toolName),
        inProgress: true,
      })
    } else if (tag === 'tool-result') {
      segments.push({ type: 'tool-result', content: body, inProgress: true })
    } else if (tag === 'error') {
      segments.push({ type: 'error', content: body })
    }
    // status / log partials: dropped.
    lastIndex = partialRe.lastIndex
    // `[\s\S]*?$` is greedy to end of string, so one match is enough.
    break
  }

  if (!sawPartial) {
    // No partial tag — the whole tail is plain text.
    const text = tail.replace(/^\n+|\n+$/g, '')
    if (text.trim()) segments.push({ type: 'text', content: text })
  } else if (lastIndex < tail.length) {
    // Trailing text after a partial that the regex didn't consume (rare,
    // since the partial body is greedy to end-of-string, but defensive).
    const text = tail.slice(lastIndex).replace(/^\n+|\n+$/g, '')
    if (text.trim()) segments.push({ type: 'text', content: text })
  }

  return segments
}

/**
 * Heuristic: does this tool-call segment represent a file modification
 * (write/edit/replace) that warrants a file-diff view? Used by the
 * assistant-content renderer to decide whether to mount `<FileDiffView>`.
 *
 * Returns true when the tool name looks like a write/edit and the input
 * has at least one of the diff-relevant fields (old_string / new_string /
 * content / file_path).
 */
export function isFileChangeTool(seg: Extract<MessageSegment, { type: 'tool-call' }>): boolean {
  if (seg.category !== 'edit') return false
  const input = seg.toolInput
  if (!input) return false
  return (
    'old_string' in input ||
    'new_string' in input ||
    'content' in input ||
    'file_path' in input ||
    'path' in input
  )
}
