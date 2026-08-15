/**
 * ChatLayout regression tests:
 *
 *   §1 ⌘K / Ctrl+K toggles the command palette — the navbar (and its
 *      palette button) was removed, so the keyboard listener is the ONLY
 *      entry point; if it breaks the palette becomes unreachable.
 *   §2 Escape-side close is the palette's own concern; here we only pin
 *      the second ⌘K press closing it (toggle semantics).
 *   §3 The sidebar collapse preference is restored from localStorage.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatLayout } from '@/components/chat-layout'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/components/chat-nav-sidebar', () => ({
  ChatNavSidebar: () => <div data-testid="sidebar" />,
}))
vi.mock('@/components/command-palette', () => ({
  CommandPalette: ({ open }: { open: boolean }) =>
    open ? <div data-testid="palette" /> : null,
}))
vi.mock('@/components/keyboard-shortcuts', () => ({
  KeyboardShortcuts: () => null,
}))
vi.mock('@/components/floating-chat', () => ({
  FloatingChat: () => null,
}))

describe('ChatLayout — navbar removed, palette stays keyboard-reachable', () => {
  it('§1: ⌘K opens the command palette', () => {
    render(<ChatLayout><div /></ChatLayout>)
    expect(screen.queryByTestId('palette')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getByTestId('palette')).toBeInTheDocument()
  })

  it('§1b: Ctrl+K also opens the palette', () => {
    render(<ChatLayout><div /></ChatLayout>)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByTestId('palette')).toBeInTheDocument()
  })

  it('§2: a second ⌘K closes the palette (toggle)', () => {
    render(<ChatLayout><div /></ChatLayout>)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByTestId('palette')).not.toBeInTheDocument()
  })

  it('§3: collapses the sidebar when localStorage says so', () => {
    localStorage.setItem('od:chat-sidebar', 'collapsed')
    render(<ChatLayout><div /></ChatLayout>)
    // The aside's class is the observable contract for ChatNavSidebar.
    expect(document.querySelector('.chat-layout-sidebar')?.classList.contains('collapsed')).toBe(true)
    localStorage.removeItem('od:chat-sidebar')
  })
})
