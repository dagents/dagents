/**
 * new-task 目录卡 (nt-ws-card) → contextRefs tests (v0.3-M3.3 / audit §2.3).
 *
 * Pins the directory selection behavior the M3.3 task added on top of the
 * M3.1 picker surface. Two picker paths converge on the same `DirState` and
 * the same submit handoff:
 *
 * 1. File System Access API (`window.showDirectoryPicker`) — preferred. Returns
 *    a `FileSystemDirectoryHandle` whose `values()` async iterator the card
 *    walks depth-first to enumerate every file as a `{ path }` contextRef.
 *    jsdom has no real picker, so the test installs a fake handle + iterator
 *    onto `window.showDirectoryPicker` and asserts the walk.
 * 2. `webkitdirectory` fallback — when `showDirectoryPicker` is absent the card
 *    click programmatic-clicks the hidden `<input webkitdirectory>`, and the
 *    `change` handler builds contextRefs from each chosen File's
 *    `webkitRelativePath`. The test synthesizes a `change` with `File`s whose
 *    `webkitRelativePath` is set (jsdom `File` keeps the value).
 *
 * Both paths must produce a `contextRefs=[{path}]` list in the
 * `/workspace?new=1&...` handoff, plus a `dir=` query param. Clearing the
 * directory removes `dir`/`contextRefs` from the handoff again.
 *
 * Scope: directory card → contextRefs + the `dir`/`contextRefs` handoff query
 * params. Picker modal open/close/pick is covered by picker.test.tsx; this
 * suite stays on the card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// `next/navigation` is a server-context module jsdom can't resolve; mock it
// before importing the view. The send button builds a query string and pushes
// to `/workspace?new=1&...` — we capture the path so the test can assert the
// dir/contextRefs handoff without the workspace route existing/consuming it.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/tasks/new',
}))

// Stub `/api/flows` + `/api/agents` so the component's mount effects resolve
// without a gateway/dispatch (mirrors picker.test.tsx's fixtures). The
// directory card does not depend on these, but the view fetches both on mount.
const FLOWS_FIXTURE = { success: true, data: [] } as const
const AGENTS_FIXTURE = {
  success: true,
  data: { agents: [], truncated: false },
} as const

/**
 * A minimal fake FileSystemDirectoryHandle. The real type's `values()` is an
 * async iterator (lib.dom.asynciterable); here we implement
 * `AsyncIterable<FileSystemHandle>` directly so `for await ... of` works under
 * jsdom. `kind` + `name` are the only fields the walk reads.
 */
interface FakeHandle {
  kind: 'directory'
  name: string
  // Inline entries so the fake is self-contained (no shared array across dirs).
  entries: Array<FakeFileEntry | FakeDirEntry>
}
interface FakeFileEntry {
  kind: 'file'
  name: string
}
interface FakeDirEntry {
  kind: 'directory'
  name: string
  entries: Array<FakeFileEntry | FakeDirEntry>
}

/** Build a FileSystemDirectoryHandle-shaped fake from the tree above. */
function fakeDirHandle(tree: FakeHandle): FileSystemDirectoryHandle {
  function toHandle(entry: FakeFileEntry | FakeDirEntry): FileSystemHandle {
    if (entry.kind === 'file') {
      return { kind: 'file', name: entry.name } as unknown as FileSystemHandle
    }
    return fakeDirHandle(entry)
  }
  // `values()` returns an async iterator yielding each child as a handle.
  const asyncIterable: AsyncIterable<FileSystemHandle> = {
    [Symbol.asyncIterator]() {
      let i = 0
      const kids = tree.entries
      return {
        next(): Promise<IteratorResult<FileSystemHandle>> {
          if (i >= kids.length) return Promise.resolve({ done: true, value: undefined })
          const handle = toHandle(kids[i]!)
          i += 1
          return Promise.resolve({ done: false, value: handle })
        },
      }
    },
  }
  return {
    kind: 'directory',
    name: tree.name,
    values: () => asyncIterable,
  } as unknown as FileSystemDirectoryHandle
}

describe('NewTaskView directory card → contextRefs (M3.3)', () => {
  let originalFetch: typeof globalThis.fetch
  let originalShowDirectoryPicker: unknown

  beforeEach(() => {
    originalFetch = globalThis.fetch
    pushMock.mockReset()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/agents')) {
        return new Response(JSON.stringify(AGENTS_FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(FLOWS_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    originalShowDirectoryPicker = (
      window as unknown as { showDirectoryPicker?: unknown }
    ).showDirectoryPicker
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker
    // Restore the original if it existed (it doesn't under jsdom, but be safe).
    if (originalShowDirectoryPicker !== undefined) {
      ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
        originalShowDirectoryPicker
    }
  })

  async function renderView(): Promise<void> {
    const { NewTaskView } = await import('@/components/new-task-view')
    render(<NewTaskView />)
  }

/** Parse the query string off a `/workspace?new=1&...` handoff path. */
function searchParamsOf(handoffPath: string): URLSearchParams {
  // The push target is a root-relative path (`/workspace?new=1&...`), not an
  // absolute URL, so `new URL(...)` throws. Slice off the `?` and parse.
  const qIndex = handoffPath.indexOf('?')
  return new URLSearchParams(qIndex >= 0 ? handoffPath.slice(qIndex + 1) : '')
}

/** The hidden webkitdirectory fallback input. */
  function getDirInput(): HTMLInputElement {
    return document.getElementById('nt-dir-input') as HTMLInputElement
  }

  /** The directory card (role=button, aria-label「选择本地目录作为 workspace」). */
  function getCard(): HTMLElement {
    return screen.getByRole('button', { name: '选择本地目录作为 workspace' })
  }

  // ── File System Access API path (preferred) ─────────────────────────

  it('showDirectoryPicker: walks the handle and surfaces folder name + file count', async () => {
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
      vi.fn().mockResolvedValue(
        fakeDirHandle({
          kind: 'directory',
          name: 'rl-paper-repro',
          entries: [
            { kind: 'file', name: 'README.md' },
            { kind: 'file', name: 'config.yaml' },
            {
              kind: 'directory',
              name: 'src',
              entries: [
                { kind: 'file', name: 'model.py' },
                { kind: 'file', name: 'train.py' },
              ],
            },
          ],
        }),
      )

    await renderView()
    await fireEvent.click(getCard())

    // The card flips to has-dir and shows the folder name + indexed count.
    // The File System Access walk is async (for-await over values()), so wait
    // for the state to settle before asserting.
    await waitFor(() => expect(getCard()).toHaveClass('has-dir'))
    const card = getCard()
    expect(card).toHaveTextContent('rl-paper-repro')
    expect(card).toHaveTextContent('4 个文件已索引')
  })

  it('showDirectoryPicker: deep nested files get folder-prefixed paths in contextRefs', async () => {
    const pickMock = vi.fn().mockResolvedValue(
      fakeDirHandle({
        kind: 'directory',
        name: 'proj',
        entries: [
          { kind: 'file', name: 'a.md' },
          {
            kind: 'directory',
            name: 'sub',
            entries: [
              { kind: 'file', name: 'b.md' },
              {
                kind: 'directory',
                name: 'deep',
                entries: [{ kind: 'file', name: 'c.md' }],
              },
            ],
          },
        ],
      }),
    )
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
      pickMock

    await renderView()
    await fireEvent.click(getCard())

    // Type a task + send so we can inspect the handoff query string. The
    // directory walk is async — wait for has-dir before sending.
    await waitFor(() => expect(getCard()).toHaveClass('has-dir'))
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    await fireEvent.change(ta, { target: { value: '复现 attention 消融' } })
    await fireEvent.click(screen.getByRole('button', { name: /创建并派发/ }))

    expect(pushMock).toHaveBeenCalledTimes(1)
    const target = pushMock.mock.calls[0]![0] as string
    // dir carries the folder path; contextRefs is a JSON list of {path}.
    expect(target).toContain('dir=proj')
    expect(target).toContain('contextRefs=')
    // The decoded list carries all three files with folder-prefixed paths.
    const contextRefsParam = searchParamsOf(target).get('contextRefs')
    expect(contextRefsParam).not.toBeNull()
    const refs = JSON.parse(contextRefsParam!) as Array<{ path: string }>
    expect(refs).toHaveLength(3)
    expect(refs.map((r) => r.path).sort()).toEqual([
      'proj/a.md',
      'proj/sub/b.md',
      'proj/sub/deep/c.md',
    ])
  })

  it('showDirectoryPicker dismissed (AbortError) leaves the card empty and sends no dir', async () => {
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))

    await renderView()
    await fireEvent.click(getCard())

    // No directory selected — card stays in the empty state.
    const card = getCard()
    expect(card).not.toHaveClass('has-dir')
    expect(card).toHaveTextContent('选择本地目录')

    // Sending carries task but neither dir nor contextRefs.
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    await fireEvent.change(ta, { target: { value: 'hi' } })
    await fireEvent.click(screen.getByRole('button', { name: /创建并派发/ }))
    const target = pushMock.mock.calls[0]![0] as string
    expect(target).not.toContain('dir=')
    expect(target).not.toContain('contextRefs=')
  })

  // ── webkitdirectory fallback path ───────────────────────────────────

  it('showDirectoryPicker throwing (SecurityError) falls back to the webkitdirectory input', async () => {
    // The API exists but rejects at call time (e.g. SecurityError when the
    // call isn't in a user-gesture, or another transient failure). Unlike a
    // plain dismissal (AbortError), the card must NOT stay frozen on the FS
    // Access path — it should fall back to the hidden webkitdirectory input so
    // the user still has a way to pick a directory.
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
      vi.fn().mockRejectedValue(new DOMException('sec', 'SecurityError'))

    await renderView()
    const input = getDirInput()
    const clickSpy = vi.spyOn(input, 'click')

    await fireEvent.click(getCard())

    // The picker rejected (not AbortError) → onCardPick falls back to the
    // webkitdirectory input's click().
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    // Card stays empty until a folder is actually chosen via the fallback.
    expect(getCard()).not.toHaveClass('has-dir')
  })

  it('without showDirectoryPicker, card click opens the hidden webkitdirectory input', async () => {
    // jsdom has no showDirectoryPicker by default — this is the fallback path.
    await renderView()
    const input = getDirInput()
    expect(input).not.toBeNull()
    expect(input).toHaveAttribute('hidden')
    expect(input.type).toBe('file')

    // Spy on the input's click to prove the card delegates to it when the
    // File System Access API is absent (the real picker can't open in jsdom).
    const clickSpy = vi.spyOn(input, 'click')
    await fireEvent.click(getCard())
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('webkitdirectory: change builds contextRefs from each file webkitRelativePath', async () => {
    await renderView()
    const input = getDirInput()

    // Synthesize a folder selection: two files under `notes/`, one nested.
    // jsdom `File` keeps `webkitRelativePath` (it's a settable string prop on
    // the File interface per lib.dom) — assign it directly since the native
    // file dialog can't run here.
    const makeFile = (name: string, rel: string): File => {
      const f = new File([''], name, { type: 'text/plain' })
      Object.defineProperty(f, 'webkitRelativePath', { value: rel })
      return f
    }
    const files = [
      makeFile('README.md', 'notes/README.md'),
      makeFile('a.md', 'notes/a.md'),
      makeFile('b.md', 'notes/sub/b.md'),
    ]
    Object.defineProperty(input, 'files', { value: files, configurable: true })

    await fireEvent.change(input)

    const card = getCard()
    expect(card).toHaveClass('has-dir')
    expect(card).toHaveTextContent('notes')
    expect(card).toHaveTextContent('3 个文件已索引')

    // Send and inspect the handoff: contextRefs carries each file's full path.
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    await fireEvent.change(ta, { target: { value: '读取 notes' } })
    await fireEvent.click(screen.getByRole('button', { name: /创建并派发/ }))

    const target = pushMock.mock.calls[0]![0] as string
    expect(target).toContain('dir=notes')
    const contextRefsParam = searchParamsOf(target).get('contextRefs')
    const refs = JSON.parse(contextRefsParam!) as Array<{ path: string }>
    expect(refs.map((r) => r.path).sort()).toEqual([
      'notes/README.md',
      'notes/a.md',
      'notes/sub/b.md',
    ])
  })

  // ── clear ──────────────────────────────────────────────────────────

  it('clearing the directory resets the card and drops dir/contextRefs from the handoff', async () => {
    ;(window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker =
      vi.fn().mockResolvedValue(
        fakeDirHandle({
          kind: 'directory',
          name: 'dropme',
          entries: [{ kind: 'file', name: 'x.md' }],
        }),
      )

    await renderView()
    await fireEvent.click(getCard())
    await waitFor(() => expect(getCard()).toHaveClass('has-dir'))

    // Click the clear button (aria-label「清除目录」).
    const clear = screen.getByRole('button', { name: '清除目录' })
    await fireEvent.click(clear)

    const card = getCard()
    expect(card).not.toHaveClass('has-dir')
    expect(card).toHaveTextContent('选择本地目录')

    // Send — no dir / contextRefs after clear.
    const ta = await screen.findByPlaceholderText(/描述你要完成的任务/)
    await fireEvent.change(ta, { target: { value: 'task only' } })
    await fireEvent.click(screen.getByRole('button', { name: /创建并派发/ }))
    const target = pushMock.mock.calls[0]![0] as string
    expect(target).not.toContain('dir=')
    expect(target).not.toContain('contextRefs=')
  })
})
