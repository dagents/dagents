/**
 * New-task textarea keyboard convention tests (v0.3-M3.2 / audit §2.2).
 *
 * Pins the ⏎发送 / ⇧⏎换行 contract design `new-task.html:559-561` specifies:
 *
 *   ta.addEventListener('keydown', (e) => {
 *     if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!send.disabled) doSend(); }
 *   });
 *
 * — i.e. plain Enter submits the composer (building the `/workspace?new=1&…`
 * handoff and `router.push`-ing it), while Shift+Enter is left alone so the
 * textarea's native newline insertion runs. The M3.1 view already wires
 * `onKeyDownTextarea`, but M3.1's `picker.test.tsx` only asserts the send
 * *button* path; this suite closes that gap by exercising the keyboard path
 * directly and asserting the side effects that distinguish the two keys.
 *
 * It also guards the IME-composition guard M3.2 adds on top of the design
 * (`e.nativeEvent.isComposing`): with a CJK IME mid-composition, Enter must
 * confirm the candidate, not submit the task. The prototype's
 * `new-task.html:559-561` does not guard this (en-only input), but the
 * console's user base is zh, so the guard is in-scope for audit §2.2's
 * ⏎发送/⇧⏎换行 contract. See `new-task-view.tsx` `onKeyDownTextarea`.
 *
 * The fetches to `/api/flows` + `/api/agents` and `next/navigation`'s
 * `useRouter` are mocked the same way `picker.test.tsx` mocks them — the
 * keyboard contract is independent of which flows/agents are listed, so the
 * fixtures stay minimal and the focus stays on Enter vs Shift+Enter vs IME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// `next/navigation` is a server-context module jsdom can't resolve; mock it
// before importing the view. The send path builds a query string and pushes
// to `/workspace?new=1&...` — capturing `push` lets us assert Enter fired the
// handoff (and Shift+Enter did not) without the workspace route existing.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tasks/new',
}))

// Minimal stubs for the two list fetches the view fires on mount — the
// keyboard contract does not depend on the option rows, so empty lists keep
// the suite focused on Enter/Shift+Enter/IME behavior. Mirrors the
// fetch-stubbing shape `picker.test.tsx` uses (just without fixtures).
const EMPTY_FLOW_LIST = JSON.stringify({ success: true, data: [] })
const EMPTY_AGENT_LIST = JSON.stringify({
  success: true,
  data: { agents: [], truncated: false },
})

describe('NewTaskView textarea keyboard convention (M3.2 ⏎发送 / ⇧⏎换行)', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    pushMock.mockReset()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/agents')) {
        return new Response(EMPTY_AGENT_LIST, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // /api/flows (list)
      return new Response(EMPTY_FLOW_LIST, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  })

  // Restore the real fetch so other suites aren't poisoned.
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // Imported lazily so the `next/navigation` mock above takes effect first.
  async function renderView(): Promise<void> {
    const { NewTaskView } = await import('@/components/new-task-view')
    render(<NewTaskView />)
  }

  // ── Enter sends ───────────────────────────────────────────────────

  it('Enter (no Shift) on a non-empty textarea fires the send handoff once', async () => {
    await renderView()
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    const user = userEvent.setup()
    await user.type(ta, '复现 attention 消融')
    expect(pushMock).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')

    expect(pushMock).toHaveBeenCalledTimes(1)
    const target = pushMock.mock.calls[0]![0] as string
    expect(target.startsWith('/workspace?new=1&')).toBe(true)
    expect(target).toContain('task=')
  })

  it('Enter on an empty (whitespace-only) textarea does NOT fire the handoff', async () => {
    await renderView()
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)

    // Plain Enter with nothing typed — send is disabled, so doSend() is a no-op.
    await userEvent.type(ta, '{Enter}')

    expect(pushMock).not.toHaveBeenCalled()
  })

  it('Enter does not leave a trailing newline in the textarea when it sends', async () => {
    // Enter submits via preventDefault, so the textarea value must stay the
    // typed text with no `\n` appended — the audit §2.2 ⏎发送 contract.
    await renderView()
    const ta = (await screen.findByPlaceholderText(/描述你要完成的任务/)) as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.type(ta, '一个任务')
    await user.keyboard('{Enter}')

    // The handoff fired (sanity) and the textarea never gained a newline.
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(ta.value).toBe('一个任务')
  })

  // ── Shift+Enter inserts a newline, does NOT send ──────────────────

  it('Shift+Enter does NOT fire the send handoff', async () => {
    await renderView()
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    const user = userEvent.setup()
    await user.type(ta, '第一行')
    await user.keyboard('{Shift>}{Enter}{/Shift}')

    expect(pushMock).not.toHaveBeenCalled()
  })

  it('Shift+Enter inserts a newline into the textarea value', async () => {
    // The other half of audit §2.2: ⇧⏎换行. The textarea must contain `\n`
    // after Shift+Enter — i.e. the handler let the default insertion run.
    await renderView()
    const ta = (await screen.findByPlaceholderText(/描述你要完成的任务/)) as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.type(ta, '第一行')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(ta, '第二行')

    expect(pushMock).not.toHaveBeenCalled()
    expect(ta.value).toBe('第一行\n第二行')
  })

  // ── IME composition guard ─────────────────────────────────────────

  it('Enter mid-IME-composition does NOT fire the send handoff', async () => {
    // With a CJK IME open, `isComposing` is true on the keydown; Enter must
    // confirm the candidate, not submit. userEvent has no first-class IME
    // API, so dispatch a synthetic keydown whose native event reports
    // isComposing: true. The handler reads `e.nativeEvent.isComposing`.
    await renderView()
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)

    await userEvent.type(ta, '任务')

    const evt = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true })
    // jsdom's KeyboardEvent has no real `isComposing` IDL attr — define it on
    // the instance so React's `e.nativeEvent.isComposing` reads true.
    Object.defineProperty(evt, 'isComposing', { value: true })
    ta.dispatchEvent(evt)

    expect(pushMock).not.toHaveBeenCalled()
  })

  it('Enter AFTER IME composition ends fires the send handoff', async () => {
    // Once composition closes (isComposing false), Enter submits normally —
    // the guard only suppresses the in-composition keydown.
    await renderView()
    const ta = (await screen.findByPlaceholderText(/描述你要完成的任务/)) as HTMLTextAreaElement
    const user = userEvent.setup()
    await user.type(ta, '复现论文')

    // A normal (non-composing) Enter submits.
    await user.keyboard('{Enter}')

    expect(pushMock).toHaveBeenCalledTimes(1)
    const target = pushMock.mock.calls[0]![0] as string
    expect(target.startsWith('/workspace?new=1&')).toBe(true)
    expect(ta.value).toBe('复现论文')
  })
})
