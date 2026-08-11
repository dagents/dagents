'use client'

/**
 * FileDiffView — visual rendering of a file modification tool call.
 *
 * For write/edit/replace tools the agent's input JSON usually carries one
 * of:
 *   - `old_string` + `new_string`  → a find-and-replace (the most common
 *     shape, used by Edit / MultiEdit / patch tools).
 *   - `content` (+ `file_path`)    → a full file write.
 *
 * This component renders that as a unified-diff-style block:
 *   - Lines only in `old_string` get a red `-` background.
 *   - Lines only in `new_string` get a green `+` background.
 *   - Common lines render as context (no background).
 *   - A file-path header sits above the diff.
 *   - Monospace font, line-by-line.
 *
 * When only `content` is present (a full write, no old/new pair), we show
 * the file path header + a green-tinted "new content" preview block
 * (collapsible via 展开/折叠).
 *
 * The diff is computed by a tiny LCS-based line differ inline — no
 * external dependency. For very large inputs (>2000 lines combined) the
 * diff is skipped and the raw content is shown, to avoid pathological
 * runtime on huge generated files.
 */
import { useMemo, useState } from 'react'
import '@/styles/tool-call.css'

export interface FileDiffViewProps {
  /** The parsed tool input. Expected fields: file_path/path, old_string, new_string, content. */
  input: Record<string, unknown>
}

const MAX_DIFF_LINES = 2000

export function FileDiffView({ input }: FileDiffViewProps): React.ReactElement | null {
  const filePath = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.path === 'string'
      ? input.path
      : ''
  const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
  const newStr = typeof input.new_string === 'string' ? input.new_string : ''
  const content = typeof input.content === 'string' ? input.content : ''

  const hasPair = oldStr.length > 0 || newStr.length > 0
  const hasContent = content.length > 0

  // Collapsed by default; user clicks 展开 to see the full diff. This
  // keeps long process folds readable.
  const [open, setOpen] = useState(false)

  const diffLines = useMemo(() => {
    if (!hasPair) return []
    const a = oldStr.split('\n')
    const b = newStr.split('\n')
    if (a.length + b.length > MAX_DIFF_LINES) return null // too big — skip
    return computeDiff(a, b)
  }, [hasPair, oldStr, newStr])

  if (!hasPair && !hasContent) return null

  return (
    <div className="file-diff">
      {filePath ? (
        <div className="file-diff-path" title={filePath}>
          <span className="file-diff-path-glyph" aria-hidden="true">📄</span>
          <span className="file-diff-path-text">{shortenPathForHeader(filePath)}</span>
        </div>
      ) : null}

      <button
        type="button"
        className="file-diff-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '折叠差异' : '展开差异'}
      </button>

      {open ? (
        <div className="file-diff-body">
          {hasPair && diffLines ? (
            <pre className="file-diff-pre">
              {diffLines.map((line, i) => (
                <span
                  key={i}
                  className={`file-diff-line file-diff-${line.kind}`}
                >
                  <span className="file-diff-marker" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span className="file-diff-text">{line.text}</span>
                </span>
              ))}
            </pre>
          ) : hasPair && diffLines === null ? (
            // Diff too large to compute — show the raw new_string as a
            // green-tinted block so the user still sees the change.
            <pre className="file-diff-pre file-diff-pre-truncated">
              <span className="file-diff-line file-diff-add">
                <span className="file-diff-marker">+</span>
                <span className="file-diff-text">
                  {newStr.length > 2000 ? newStr.slice(0, 2000) + '\n…（已截断）' : newStr}
                </span>
              </span>
            </pre>
          ) : hasContent ? (
            // Full-file write (no old/new pair) — show as new content.
            <pre className="file-diff-pre">
              <span className="file-diff-line file-diff-add">
                <span className="file-diff-marker">+</span>
                <span className="file-diff-text">
                  {content.length > 4000 ? content.slice(0, 4000) + '\n…（已截断）' : content}
                </span>
              </span>
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Shorten a path for the diff header. Keeps the filename + parent dir. */
function shortenPathForHeader(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 4) return p
  return '…/' + parts.slice(-3).join('/')
}

type DiffLineKind = 'add' | 'del' | 'ctx'
interface DiffLine { kind: DiffLineKind; text: string }

/**
 * Compute a line-level diff between two string arrays using LCS dynamic
 * programming. Returns an ordered list of add/del/context lines.
 *
 * This is the classic O(n*m) DP — fine for typical tool inputs (tens to
 * a few hundred lines). The caller guards against pathological sizes
 * with MAX_DIFF_LINES.
 */
function computeDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length

  // LCS length table. Using Uint32Array for memory efficiency.
  const dp = new Uint32Array((n + 1) * (m + 1))
  const stride = m + 1
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1
      } else {
        const down = dp[(i + 1) * stride + j]
        const right = dp[i * stride + (j + 1)]
        dp[i * stride + j] = down > right ? down : right
      }
    }
  }

  // Backtrack to build the diff.
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      lines.push({ kind: 'del', text: a[i] })
      i++
    } else {
      lines.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: a[i] })
    i++
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j] })
    j++
  }
  return lines
}
