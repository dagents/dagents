/**
 * ChatComposer keyboard behavior tests.
 *
 * Pins the Enter / Shift+Enter / IME composition contract the composer's hint
 * text advertises ("⏎ 发送 · ⇧⏎ 换行"):
 *
 *   §1 Enter (no modifier) sends the trimmed input and clears the field.
 *   §2 Shift+Enter inserts a newline (does NOT send).
 *   §3 Enter during IME composition does NOT send — the keystroke confirms
 *      the IME candidate, not the message. This is the CJK-user-critical
 *      guard: without it, confirming pinyin/hiragana would fire onSend
 *      prematurely with a half-composed string.
 *   §4 Enter on empty input does NOT call onSend.
 *   §5 Enter while disabled does NOT call onSend.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatComposer } from '@/components/chat-composer'

function setup(overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}): {
  onSend: ReturnType<typeof vi.fn>
  onAgentChange: ReturnType<typeof vi.fn>
} {
  const onSend = vi.fn()
  const onAgentChange = vi.fn()
  render(
    <ChatComposer
      onSend={onSend}
      onAgentChange={onAgentChange}
      {...overrides}
    />,
  )
  return { onSend, onAgentChange }
}

function typeAndEnter(text: string, opts: { shift?: boolean; composing?: boolean } = {}): void {
  const textarea = screen.getByLabelText('消息输入框')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.keyDown(textarea, {
    key: 'Enter',
    shiftKey: opts.shift ?? false,
    nativeEvent: { isComposing: opts.composing ?? false } as KeyboardEventInit,
    keyCode: opts.composing ? 229 : 13,
  })
}

describe('ChatComposer — Enter behavior matches hint text', () => {
  it('§1: Enter sends the trimmed input and clears the field', () => {
    const { onSend } = setup()
    typeAndEnter('  hello world  ')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('hello world')
    // Field is cleared after send.
    const textarea = screen.getByLabelText('消息输入框') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('§2: Shift+Enter does NOT send (inserts a newline instead)', () => {
    const { onSend } = setup()
    typeAndEnter('hello', { shift: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('§3: Enter during IME composition does NOT send', () => {
    const { onSend } = setup()
    // Simulate a CJK IME composition confirmation — the user presses Enter
    // to accept the candidate, not to send the message.
    typeAndEnter('你好', { composing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('§4: Enter on empty/whitespace input does NOT send', () => {
    const { onSend } = setup()
    typeAndEnter('   ')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('§5: Enter while disabled does NOT send', () => {
    const { onSend } = setup({ disabled: true })
    typeAndEnter('hello')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('§6: auto-repeat Enter (key held down) does NOT machine-gun sends', () => {
    const { onSend } = setup()
    const textarea = screen.getByLabelText('消息输入框')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    // Holding Enter fires repeated keydowns (repeat = true in the event
    // init, exactly like a real auto-repeat) — a repeat must not send
    // (deepseek InputBar e.repeat guard).
    fireEvent.keyDown(textarea, {
      key: 'Enter',
      repeat: true,
      nativeEvent: { isComposing: false } as KeyboardEventInit,
      keyCode: 13,
    })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('renders the hint text advertising the Enter / Shift+Enter contract', () => {
    setup()
    // The hint must surface the keyboard contract so users know how to send
    // vs. insert a newline. The text is the single source of truth for what
    // the keyboard handler should implement.
    expect(screen.getByText(/⏎ 发送/)).toBeInTheDocument()
    expect(screen.getByText(/⇧⏎ 换行/)).toBeInTheDocument()
  })
})
