/**
 * CodeBlock contract tests:
 *
 *   §1 Renders the fence's language as the banner label plus a copy button.
 *   §2 Unknown languages fall back to a plain <pre> — never an error.
 *   §3 The code text renders verbatim (shiki output or plain fallback).
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CodeBlock } from '@/components/code-block'

describe('CodeBlock', () => {
  it('§1: renders the language label and the copy button', () => {
    render(<CodeBlock code={'const answer: number = 42'} lang="ts" />)
    expect(screen.getByText('ts')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制代码' })).toBeInTheDocument()
  })

  it('§2: unknown languages fall back to a plain pre block', () => {
    render(<CodeBlock code="hello world" lang="notalang" />)
    expect(document.querySelector('.code-block-plain')).not.toBeNull()
    expect(document.querySelector('.code-block-highlighted')).toBeNull()
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('§3: renders the code verbatim in the highlighted path', () => {
    render(<CodeBlock code={'{"ready":true}'} lang="json" />)
    // shiki emits a span tree inside .code-block-highlighted
    const host = document.querySelector('.code-block-highlighted')
    expect(host).not.toBeNull()
    expect(host?.textContent).toContain('{"ready":true}')
  })
})
