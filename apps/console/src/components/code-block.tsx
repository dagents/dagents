'use client'

/**
 * CodeBlock — one code surface for every chat consumer (assistant markdown
 * fences). Chrome: sticky language banner + copy button, borrowed from
 * deepseek-harness's `ui-primitives/markdown/CodeBlock.tsx`; token colors
 * stay on `--shiki-*` custom properties (tokens.css) so light/dark themes
 * agree between highlighted and plain blocks.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '@/components/icon'
import { grammarLoadCount, highlightToHtml, subscribeGrammarLoaded } from '@/lib/highlight'
import '@/styles/code-block.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed). */
  code: string
  /** Grammar hint (the markdown fence info string); unknown = plain. */
  lang?: string | undefined
}

export function CodeBlock({ code, lang }: CodeBlockProps): React.ReactElement {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  // Re-render when a lazy grammar finishes loading, so a fence that showed
  // plain text while its language's grammar imported picks up highlighting.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const html = useMemo(() => highlightToHtml(trimmed, lang), [trimmed, lang, loaded])
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)

  const onCopy = useCallback(() => {
    if (copied) return
    void navigator.clipboard.writeText(trimmed).then(() => {
      setCopied(true)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => { setCopied(false) }, 1500)
    }).catch(() => {
      // clipboard unavailable (non-secure context) — silent fail
    })
  }, [copied, trimmed])

  // Clear the pending reset timer on unmount so it can't fire on a gone node.
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  return (
    <div className="code-block">
      <div className="code-block-banner">
        <span className="code-block-lang">{lang || 'text'}</span>
        <button
          type="button"
          className={`code-block-copy${copied ? ' copied' : ''}`}
          onClick={onCopy}
          aria-label={copied ? '已复制' : '复制代码'}
        >
          <Icon name={copied ? 'check' : 'copy'} style={{ width: 12, height: 12 }} />
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      {html === undefined ? (
        <pre className="code-block-plain"><code>{trimmed}</code></pre>
      ) : (
        // shiki's output is a static span tree it generated from `code` (no
        // user HTML passes through), the sanctioned innerHTML path per
        // shiki's own docs.
        <div className="code-block-highlighted" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}
