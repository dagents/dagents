/**
 * Component-test harness smoke test (M0.2).
 *
 * This file exists to prove the jsdom + testing-library + jest-dom stack is
 * wired end-to-end before the 9-screen fidelity work starts adding real
 * component tests: `render` mounts into a jsdom document, `getByText` queries
 * it, and `toBeInTheDocument` is a jest-dom matcher loaded via setupFiles. If
 * any of those three links is broken this test fails loudly — that is the whole
 * acceptance gate for this task. Keep it minimal and dependency-free (only
 * `PageShell`, a leaf server-component-safe component) so it stays green as the
 * design-fidelity redesign lands more surface area.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageShell } from '@/components/page-shell'

describe('component-test harness (M0.2 smoke)', () => {
  it('renders the PageShell title and subtitle into the document', () => {
    render(<PageShell title="T" subtitle="S">body</PageShell>)

    expect(screen.getByText('T')).toBeInTheDocument()
    expect(screen.getByText('S')).toBeInTheDocument()
  })
})
