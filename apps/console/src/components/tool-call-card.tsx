'use client'

/**
 * ToolCallCard — structured rendering of a single `[tool:Name]{json}[/tool]`
 * segment produced by the inline-executor.
 *
 * Replaces the old flat `ToolUseRow` (which rendered every tool as a
 * one-line mono preview). The card:
 *   - Shows a typed header (icon glyph + colored tool name) so the user
 *     can scan a long process fold at a glance: 🔍 Read, ✏️ Write,
 *     💻 Bash, 🔧 Other.
 *   - Shows a summary line with the headline field (file path / command
 *     / query / pattern / url) extracted from the parsed input.
 *   - Expands to show the full JSON input pretty-printed, plus a copy
 *     button for easy reuse.
 *   - Renders a `<FileDiffView>` for write/edit tools that carry an
 *     `old_string`/`new_string` pair, so file changes are visual.
 *
 * Collapsed by default; click anywhere on the header to expand. While
 * the tool is still streaming (`inProgress`), the header shows a spinner
 * and "执行中…" instead of a static summary.
 */
import { useState } from 'react'
import { Icon } from '@/components/icon'
import {
  CATEGORY_GLYPH,
  type ToolCategory,
} from '@/lib/tool-call-parser'
import { FileDiffView } from '@/components/file-diff-view'
import '@/styles/tool-call.css'

export interface ToolCallCardProps {
  /** Tool name, e.g. "Bash", "Read", "Write", "Edit". */
  toolName: string
  /** Parsed input JSON (may be undefined for tools with no input / failed parse). */
  toolInput: Record<string, unknown> | undefined
  /** Category (drives icon + color). Pre-computed by the parser. */
  category: ToolCategory
  /** Headline summary string (file path / command / query). Pre-extracted. */
  summary: string
  /** Raw body string (the JSON text inside the tag). */
  content?: string
  /** True while the tool call is still streaming (no closing tag yet). */
  inProgress?: boolean
  /** True when the tool call errored — danger left stripe + tinted body. */
  failed?: boolean
  /** Default expanded state. Default: collapsed. */
  defaultOpen?: boolean
}

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  search: '读取',
  edit: '编辑',
  terminal: '终端',
  tool: '工具',
}

export function ToolCallCard({
  toolName,
  toolInput,
  category,
  summary,
  content,
  inProgress,
  failed,
  defaultOpen,
}: ToolCallCardProps): React.ReactElement {
  const [open, setOpen] = useState(!!defaultOpen)
  const [copied, setCopied] = useState(false)

  const glyph = CATEGORY_GLYPH[category]
  const hasInput = !!toolInput && Object.keys(toolInput).length > 0
  const hasDiff = category === 'edit' && hasInput && (
    'old_string' in toolInput! || 'new_string' in toolInput!
  )

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!toolInput) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(toolInput, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard may be unavailable (permissions / non-secure context) —
      // silently no-op; the copy button just won't do anything visible.
    }
  }

  return (
    <div
      className={`tool-call-card tool-call-${category}${failed ? ' tool-call-failed' : ''}`}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-call-glyph" aria-hidden="true">{glyph}</span>
        <span className="tool-call-name">{toolName}</span>
        {inProgress ? (
          // PX-C05: 3-dot bounce right after the tool name while running.
          <span className="tool-call-running-dots" aria-hidden="true">
            <span /><span /><span />
          </span>
        ) : null}
        <span className="tool-call-type-badge">{CATEGORY_LABEL[category]}</span>
        <span className="tool-call-summary">
          {inProgress && !summary ? '执行中…' : summary}
        </span>
        <Icon
          name="chevronRight"
          className="tool-call-chevron"
          style={{ width: 12, height: 12 }}
        />
      </button>

      {/* Always-mounted body behind a 0fr→1fr grid transition (PX-C05) —
          expand/collapse animates height without layout jumps. */}
      <div className="tool-call-body">
        <div className="tool-call-body-inner">
          {/* File diff view for write/edit tools with old/new strings. */}
          {hasDiff ? (
            <FileDiffView input={toolInput!} />
          ) : null}

          {/* Full JSON input, pretty-printed. Hidden when there's no input
              (some tools carry no args). */}
          {hasInput ? (
            <div className="tool-call-json-wrap">
              <button
                type="button"
                className="tool-call-copy"
                onClick={onCopy}
                aria-label="复制输入 JSON"
                title="复制输入 JSON"
              >
                <Icon name={copied ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
              <pre className="tool-call-json">
                {JSON.stringify(toolInput, null, 2)}
              </pre>
            </div>
          ) : content ? (
            <pre className="tool-call-json">{content}</pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}
