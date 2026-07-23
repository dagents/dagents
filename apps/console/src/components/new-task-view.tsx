'use client'

/**
 * 新增 Task view (v0.3-M3.1/M3.3 / audit §2).
 *
 * Ports design/new-task.html to React. A vertically-centered composer page
 * (`.nt-page` > `.nt-top` + `.nt-bottom`): a directory workspace card, a
 * composer (assoc chip rail + textarea + footer with 关联Flow/关联Agent
 * picker triggers + send), and an empty-state suggestion grid. The pickers
 * are the M3.1 deliverable — two independent `.nt-picker.open` popovers
 * (`#nt-picker-flow`「选择 AgentFlow」and `#nt-picker-agent`「选择 Agent」),
 * each with a search input + scrollable option list, behind a shared
 * `[data-picker-backdrop]`.
 *
 * ## Picker open/close/pick (the M3.1 acceptance surface)
 *
 * `openPicker(kind)` closes any open picker, opens the requested one, shows
 * the backdrop, and focuses the search. `closePickers()` reverses it. Escape,
 * backdrop click, and an outside click (not on a picker or its trigger button)
 * all close. Picking an option toggles its id in `state.flows` / `state.agents`
 * and re-renders the assoc chip rail — multi-select, matching the design's
 * `toggleAssoc` (new-task.html:481-517). The chip's remove button toggles the
 * same id off.
 *
 * ## Data
 *
 * Flows come from `/api/flows` (→ gateway → Flowise AGENTFLOW chatflows);
 * agents come from `/api/agents` (→ gateway → dispatch `GET /agents`). Both
 * are fetched once on mount; the picker derives its option rows from the
 * fetched list + the live search string. The fetches degrade gracefully: a
 * failed list renders an empty picker (no crash), matching how FlowsView
 * surfaces `listError`.
 *
 * ## Submit handoff (audit §2 / contract 3)
 *
 * The design's `doSend` (new-task.html:564-574) does NOT POST — it builds a
 * `URLSearchParams` (`task`/`dir`/`flows`/`agents`/`contextRefs`) and navigates to
 * `workspace.html?new=1&…`. The console ports that to `router.push(
 * '/workspace?new=1&…')`. Audit §2 notes the workspace route's `?new=1`
 * consumer is a later task (M9 contract alignment); this view builds the
 * handoff correctly regardless — the query string carries everything the
 * future consumer needs.
 *
 * Honesty about coverage: the directory card (audit §2.3) renders and the
 * fallback `webkitdirectory` input is wired; the File System Access API path
 * is unit-tested with a fake directory handle (jsdom has no real picker), and
 * the `webkitdirectory` fallback is exercised via a synthesized `change` event
 * carrying `File`s whose `webkitRelativePath` is set. ⏎发送 / ⇧⏎换行 (audit
 * §2.2) is wired — `onKeyDownTextarea` (v0.3-M3.2) adds the IME-composition
 * guard the design's `new-task.html:559-561` omits; see
 * `__tests__/keyboard.test.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageShell } from '@/components/page-shell'
import { Icon } from '@/components/icon'
import { fetchAgents } from '@/lib/agents-catalog'
import '@/styles/new-task.css'

/** One flow option row in the flow picker (derived from /api/flows FlowSummary). */
interface FlowOption {
  id: string
  name: string
  meta: string
  glyph: string
}

/** One agent option row in the agent picker (derived from /api/agents CatalogAgent). */
interface AgentOption {
  id: string
  name: string
  meta: string
  glyph: string
}

/** The four suggestion templates (design new-task.html:410-415). */
const SUGGEST = [
  { tag: '论文复现', text: '复现这批 RL 论文里的 attention 消融，对照 baseline 给出图表。' },
  { tag: '假设验证', text: '读取仓库数据，验证对齐损失对 10% 噪声标签的鲁棒性假设。' },
  { tag: '代码迁移', text: '把这 4 个 TF 模型迁移到 PyTorch，数值对齐误差控制在 1e-5。' },
  { tag: '跨域综述', text: '通读目录里的 32 篇跨域论文，提取共性方法并生成综述。' },
] as const

interface FlowListResponse {
  success: boolean
  data?: Array<{
    id: string
    name: string
    type?: string
    status?: string
    nodeCount?: number
    versionHash?: string
  }>
  error?: string
}

// Agents come through the shared `fetchAgents()` from `@/lib/agents-catalog`
// (console /api/agents → gateway → dispatch `GET /agents`), which maps the raw
// snake_case `AgentListRow` to the typed `CatalogAgent` domain model — notably
// deriving `roles` from `capability_descriptor.tags`. The console's /api/agents
// route forwards the dispatch envelope **verbatim** (no field mapping), so a
// local response interface reading `roles`/`status`/`daemon`/`region`/`cost`
// off the wire would be wrong: those fields exist only on `CatalogAgent`, not
// on the raw row. Reusing `fetchAgents()` keeps this component on the real wire
// contract the catalogue already owns (and tests guard).

type PickerKind = 'flow' | 'agent'

/**
 * A path the task will carry as a context reference (the directory's relative
 * path prefix + every file under it). Built from either a File System Access
 * directory handle (preferred) or the `webkitdirectory` fallback input.
 */
interface ContextRef {
  /** Path relative to the picked folder root, e.g. `notes/a.md` (root file → name). */
  path: string
}

/** A selected directory (design new-task.html state.dir). */
interface DirState {
  name: string
  path: string
  count: number
  /** Every file under the directory, as a context reference for the task. */
  contextRefs: ContextRef[]
}

/**
 * The File System Access API (`window.showDirectoryPicker`) is not in the
 * bundled lib.dom typings as a window method (the handle types are, but the
 * picker entry point is not), and it is absent from jsdom. Narrow `window` to
 * this shape so the feature-detect + call type-check, and stay honest that it
 * is `undefined` everywhere the API is unavailable.
 */
interface WindowWithDirPicker extends Window {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
  }) => Promise<FileSystemDirectoryHandle>
}

export function NewTaskView(): React.ReactElement {
  const router = useRouter()

  // ── data (flows + agents lists) ───────────────────────────────────
  const [flows, setFlows] = useState<FlowOption[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [flowSearch, setFlowSearch] = useState('')
  const [agentSearch, setAgentSearch] = useState('')

  // ── composer state ─────────────────────────────────────────────────
  const [dir, setDir] = useState<DirState | null>(null)
  const [selectedFlows, setSelectedFlows] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [text, setText] = useState('')
  const [openPicker, setOpenPicker] = useState<PickerKind | null>(null)

  const flowSearchRef = useRef<HTMLInputElement>(null)
  const agentSearchRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  // Fetch the flow + agent lists once on mount (degrade gracefully on error).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/flows', { cache: 'no-store' })
        const json = (await res.json()) as FlowListResponse
        if (cancelled) return
        if (res.ok && json.success && json.data) {
          setFlows(
            json.data.map((f) => ({
              id: f.id,
              name: f.name,
              // design new-task.html:407 — `version + ' · ' + status + ' · ' + nodes + ' 节点'`.
              // We have no SemVer on a chatflow; surface the repro hash (or '') + status +
              // node count, the closest version signal (mirrors FlowSummary.versionHash).
              meta: `${f.versionHash ? f.versionHash + ' · ' : ''}${f.status ?? 'idle'} · ${f.nodeCount ?? 0} 节点`,
              glyph: 'F',
            })),
          )
        }
      } catch {
        // empty picker on failure — the page still renders
      }
    })()
    void (async () => {
      try {
        const { agents: rows } = await fetchAgents()
        if (cancelled) return
        setAgents(
          rows.map((a) => ({
            id: a.id,
            name: a.name,
            // design new-task.html:408 — `(a.model || a.kind) + ' · ' + roles.join('/')`.
            // CatalogAgent has no model; use kind (the closest runtime signal).
            // `a.roles` is derived from capability_descriptor.tags by mapRowToCatalogAgent.
            meta: `${a.kind} · ${a.roles.join('/')}`,
            glyph: a.name.slice(-2),
          })),
        )
      } catch {
        // empty picker on failure
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const closePickers = useCallback(() => setOpenPicker(null), [])

  const openPickerFor = useCallback((kind: PickerKind) => {
    setOpenPicker(kind)
    // Focus the search shortly after open (design new-task.html:530 setTimeout 30ms).
    // rAF avoids focusing before the input is painted in the jsdom/no-paint path.
    const ref = kind === 'flow' ? flowSearchRef : agentSearchRef
    requestAnimationFrame(() => ref.current?.focus())
  }, [])

  // Escape closes the open picker (design new-task.html:545).
  useEffect(() => {
    if (!openPicker) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePickers()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openPicker, closePickers])

  // Outside click + backdrop click close (design new-task.html:542-546).
  // mousedown so a click starting inside the picker but releasing outside
  // doesn't steal-focus-close it. The trigger buttons stop propagation.
  useEffect(() => {
    if (!openPicker) return
    const onDown = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (
        target.closest('.nt-picker') ||
        target.closest('.nt-add-btn')
      ) {
        return
      }
      closePickers()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openPicker, closePickers])

  const toggleAssoc = useCallback((kind: PickerKind, id: string) => {
    if (kind === 'flow') {
      setSelectedFlows((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    } else {
      setSelectedAgents((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    }
  }, [])

  // ── filtered picker options ────────────────────────────────────────
  const visibleFlows = useMemo(() => {
    const q = flowSearch.trim().toLowerCase()
    if (!q) return flows
    return flows.filter((f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
  }, [flows, flowSearch])

  const visibleAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
  }, [agents, agentSearch])

  // ── directory picker ───────────────────────────────────────────────
  // File System Access API first (`showDirectoryPicker`): Chromium-based
  // browsers expose it; it hands back a FileSystemDirectoryHandle we can walk
  // to enumerate every file under the folder. Where the API is missing
  // (Firefox, Safari, jsdom), fall back to a hidden `<input webkitdirectory>`
  // and read `webkitRelativePath` off each chosen File. Both paths converge on
  // the same DirState — name/path/count + a contextRefs entry per file — so the
  // submit handoff carries an identical `contextRefs=[{path}]` list regardless
  // of which picker the browser offered.
  const openDirViaFsAccess = useCallback(async (): Promise<boolean> => {
    const w = window as WindowWithDirPicker
    if (typeof w.showDirectoryPicker !== 'function') return false
    let handle: FileSystemDirectoryHandle
    try {
      handle = await w.showDirectoryPicker({ id: 'nt-ws-dir', mode: 'read' })
    } catch (err) {
      // AbortError = the user dismissed the native picker — leave state as-is
      // and stay on the FS Access path. Returning true keeps `onCardPick` from
      // falling back to the webkitdirectory input, which would just re-pop a
      // second chooser for a dismissal that's already the user's choice.
      // Any OTHER throw means the API is present but blew up at call time
      // (SecurityError when the call isn't user-gestured, a transient
      // NotAllowedError, …): return false so `onCardPick` falls back to the
      // hidden webkitdirectory input instead of leaving the card frozen.
      if (err instanceof DOMException && err.name === 'AbortError') return true
      return false
    }
    // Walk the directory tree depth-first. `for await ... of handle.values()`
    // yields every entry as a `FileSystemHandle` (the file/directory union
    // base); `entry.kind` discriminates the two. `values()` is only declared
    // on `FileSystemDirectoryHandle` (via the `dom.asynciterable` lib), so the
    // recursion narrows with a cast — TS can't narrow the base `FileSystemHandle`
    // to the directory subtype off the `kind` literal alone (it's a single
    // interface, not a discriminated union in lib.dom). The walk is seeded with
    // the folder name as the prefix so each file path is `folder/sub/file.md` —
    // the same shape `webkitRelativePath` yields in the fallback path, keeping
    // the two pickers' contextRefs byte-identical.
    const refs: ContextRef[] = []
    const walk = async (
      dir: FileSystemDirectoryHandle,
      prefix: string,
    ): Promise<void> => {
      for await (const entry of dir.values()) {
        const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, entryPath)
        } else {
          refs.push({ path: entryPath })
        }
      }
    }
    await walk(handle, handle.name)
    setDir({
      name: handle.name,
      path: handle.name,
      count: refs.length,
      contextRefs: refs,
    })
    return true
  }, [])

  const onDirChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || !files.length) return
      const first = files[0]!
      const rel = first.webkitRelativePath || first.name
      const parts = rel.split('/')
      const folderName = parts[0] || first.name
      const path = parts.length > 1 ? parts.slice(0, -1).join('/') : folderName
      // Build one contextRef per chosen file. `webkitRelativePath` is the full
      // `folder/sub/file.md` path; we keep it whole so the handoff carries the
      // same shape the File System Access path produces.
      const refs: ContextRef[] = Array.from(files).map((f) => ({
        path: f.webkitRelativePath || f.name,
      }))
      setDir({ name: folderName, path, count: files.length, contextRefs: refs })
    },
    [],
  )

  // Card click prefers the native File System Access picker; if the browser
  // lacks it, it falls back to clicking the hidden `<input webkitdirectory>`.
  const onCardPick = useCallback(() => {
    void openDirViaFsAccess().then((used) => {
      if (!used) dirInputRef.current?.click()
    })
  }, [openDirViaFsAccess])

  // ── send state + handoff ────────────────────────────────────────────
  const sendDisabled = !text.trim()

  const doSend = useCallback(() => {
    const t = text.trim()
    if (!t) return
    const params = new URLSearchParams()
    params.set('task', t)
    if (dir) {
      params.set('dir', dir.path)
      // contextRefs: one entry per file under the picked directory. JSON-
      // encoded as `[{path}]` so the workspace consumer can parse the list
      // without a second delimiter (paths can contain commas/slashes).
      if (dir.contextRefs.length) {
        params.set('contextRefs', JSON.stringify(dir.contextRefs))
      }
    }
    if (selectedFlows.length) params.set('flows', selectedFlows.join(','))
    if (selectedAgents.length) params.set('agents', selectedAgents.join(','))
    router.push(`/workspace?new=1&${params.toString()}`)
  }, [text, dir, selectedFlows, selectedAgents, router])

  // ⏎发送 / ⇧⏎换行 (audit §2.2 / design new-task.html:559-561).
  //
  // Enter (no Shift, not mid-IME-composition) → preventDefault + doSend (the
  // textarea's default Enter would otherwise insert a `\n`, so preventDefault
  // is what keeps the submitted task single-line and stops the handoff from
  // racing a stray newline into state). Shift+Enter is intentionally NOT
  // handled here — we let it fall through so the textarea's native `\n`
  // insertion runs. The IME guard (`isComposing`) stops Enter from submitting
  // while a CJK candidate window is open (hitting Enter there confirms the
  // candidate, not the task) — design new-task.html:559-561 does not guard this
  // because the prototype targets en input, but the audit §2.2 contract is
  // ⏎发送/⇧⏎换行 for the console's zh user base, so the guard is in-scope.
  const onKeyDownTextarea = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (!sendDisabled) doSend()
      }
    },
    [sendDisabled, doSend],
  )

  // ── assoc chip rail (design new-task.html:494-510 renderAssoc) ──────
  const chips = useMemo(() => {
    const out: { kind: PickerKind; id: string; label: string; name: string }[] = []
    for (const id of selectedFlows) {
      const f = flows.find((x) => x.id === id)
      if (f) out.push({ kind: 'flow', id, label: 'Flow', name: f.name })
    }
    for (const id of selectedAgents) {
      const a = agents.find((x) => x.id === id)
      if (a) out.push({ kind: 'agent', id, label: 'Agent', name: a.name })
    }
    return out
  }, [selectedFlows, selectedAgents, flows, agents])

  return (
    <PageShell
      title="新增 Task"
      subtitle="从一个空白对话开始。选择本地目录作为 workspace，或关联具体的 AgentFlow / Agent，把任务派发给对的执行单元。"
      fullBleed
    >
      <div className="page nt-page">
        <div className="nt-top">
          {/* context: directory workspace */}
          <div
            className={`nt-ws-card${dir ? ' has-dir' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="选择本地目录作为 workspace"
            onClick={onCardPick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onCardPick()
              }
            }}
          >
            <span className="nt-ws-icon">
              <Icon name="folder" />
            </span>
            <span className="nt-ws-text">
              <span className="nt-ws-title">{dir ? dir.name : '选择本地目录'}</span>
              <span className="nt-ws-sub">
                {dir
                  ? `${dir.path} · ${dir.count} 个文件已索引`
                  : '作为 workspace · 文件将索引后供 agent 读取'}
              </span>
              {!dir ? <span className="nt-ws-cta">点击选择文件夹</span> : null}
            </span>
            {dir ? (
              <button
                type="button"
                className="nt-ws-clear"
                aria-label="清除目录"
                // A real <button> (not a nested role="button" span) — interactive
                // elements cannot nest. It sits as a sibling of the card content
                // inside the role="button" card; stopPropagation keeps the click
                // from re-triggering the card's dirInput.click().
                onClick={(e) => {
                  e.stopPropagation()
                  setDir(null)
                  if (dirInputRef.current) dirInputRef.current.value = ''
                }}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </div>

          <input
            id="nt-dir-input"
            ref={dirInputRef}
            type="file"
            // Fallback for browsers without the File System Access API
            // (Firefox/Safari/jsdom): `webkitdirectory` + `directory` let the
            // user pick a folder via the classic file input. The React typings
            // don't include these non-standard attrs, so they're spread via a
            // cast below to keep TS happy without a `// @ts-ignore`. The card
            // click only reaches this input when `showDirectoryPicker` is
            // unavailable (see onCardPick).
            multiple
            hidden
            onChange={onDirChange}
            {...({ webkitdirectory: '', directory: '' } as unknown as Record<string, string>)}
          />

          {/* composer */}
          <div className="nt-composer">
            <div className="nt-assoc" id="nt-assoc" aria-live="polite">
              {chips.map((c) => (
                <span className="assoc-chip" key={`${c.kind}-${c.id}`}>
                  <span className="kind">{c.label}</span>
                  <span className="nm" title={c.name}>
                    {c.name}
                  </span>
                  <button
                    type="button"
                    aria-label="移除"
                    data-kind={c.kind}
                    data-id={c.id}
                    onClick={() => toggleAssoc(c.kind, c.id)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))}
            </div>

            <div className="nt-textarea-wrap">
              <textarea
                id="nt-textarea"
                rows={3}
                placeholder="描述你要完成的任务… 例如：复现这批 RL 论文里的 attention 消融，对照 baseline 给出图表。"
                aria-label="任务描述"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDownTextarea}
              />
            </div>

            <div className="nt-foot">
              <div className="nt-add-wrap">
                <button
                  type="button"
                  className="nt-add-btn"
                  id="nt-add-flow"
                  aria-haspopup="true"
                  aria-expanded={openPicker === 'flow'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (openPicker === 'flow') closePickers()
                    else openPickerFor('flow')
                  }}
                >
                  <Icon name="flows" />
                  关联 Flow
                </button>
                <div
                  className={`nt-picker${openPicker === 'flow' ? ' open' : ''}`}
                  id="nt-picker-flow"
                  role="dialog"
                  aria-label="选择 AgentFlow"
                >
                  <div className="nt-picker-head">
                    <input
                      ref={flowSearchRef}
                      className="nt-picker-search"
                      type="search"
                      placeholder="搜索 AgentFlow…"
                      id="nt-flow-search"
                      value={flowSearch}
                      onChange={(e) => setFlowSearch(e.target.value)}
                    />
                  </div>
                  <div className="nt-picker-list" id="nt-flow-list">
                    {visibleFlows.length === 0 ? (
                      <div className="nt-picker-empty">无匹配结果</div>
                    ) : (
                      visibleFlows.map((f) => {
                        const sel = selectedFlows.includes(f.id)
                        return (
                          <button
                            type="button"
                            className={`nt-picker-opt${sel ? ' selected' : ''}`}
                            key={f.id}
                            data-id={f.id}
                            data-kind="flow"
                            onClick={() => {
                              toggleAssoc('flow', f.id)
                              closePickers()
                            }}
                          >
                            <span className="nt-picker-glyph">{f.glyph}</span>
                            <span className="nt-picker-info">
                              <span className="nt-picker-name">{f.name}</span>
                              <span className="nt-picker-meta">{f.meta}</span>
                            </span>
                            <span className="nt-picker-check">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="nt-add-wrap">
                <button
                  type="button"
                  className="nt-add-btn"
                  id="nt-add-agent"
                  aria-haspopup="true"
                  aria-expanded={openPicker === 'agent'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (openPicker === 'agent') closePickers()
                    else openPickerFor('agent')
                  }}
                >
                  <Icon name="agents" />
                  关联 Agent
                </button>
                <div
                  className={`nt-picker${openPicker === 'agent' ? ' open' : ''}`}
                  id="nt-picker-agent"
                  role="dialog"
                  aria-label="选择 Agent"
                >
                  <div className="nt-picker-head">
                    <input
                      ref={agentSearchRef}
                      className="nt-picker-search"
                      type="search"
                      placeholder="搜索 Agent…"
                      id="nt-agent-search"
                      value={agentSearch}
                      onChange={(e) => setAgentSearch(e.target.value)}
                    />
                  </div>
                  <div className="nt-picker-list" id="nt-agent-list">
                    {visibleAgents.length === 0 ? (
                      <div className="nt-picker-empty">无匹配结果</div>
                    ) : (
                      visibleAgents.map((a) => {
                        const sel = selectedAgents.includes(a.id)
                        return (
                          <button
                            type="button"
                            className={`nt-picker-opt${sel ? ' selected' : ''}`}
                            key={a.id}
                            data-id={a.id}
                            data-kind="agent"
                            onClick={() => {
                              toggleAssoc('agent', a.id)
                              closePickers()
                            }}
                          >
                            <span className="nt-picker-glyph">{a.glyph}</span>
                            <span className="nt-picker-info">
                              <span className="nt-picker-name">{a.name}</span>
                              <span className="nt-picker-meta">{a.meta}</span>
                            </span>
                            <span className="nt-picker-check">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="nt-foot-spacer" />
              <span className="nt-meta-hint">⏎ 发送 · ⇧⏎ 换行</span>
              <button
                type="button"
                className="nt-send"
                id="nt-send"
                disabled={sendDisabled}
                onClick={doSend}
              >
                <Icon name="arrow" />
                创建并派发
              </button>
            </div>
          </div>
        </div>

        <div className="nt-bottom">
          <div className="nt-suggest-label">或从一个模板开始</div>
          <div className="nt-suggest" id="nt-suggest">
            {SUGGEST.map((s) => (
              <button
                type="button"
                className="nt-suggest-item"
                key={s.tag}
                onClick={() => {
                  setText(s.text)
                }}
              >
                <span className="tag">{s.tag}</span>
                {s.text}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* backdrop for pickers (design new-task.html:377,527-528).
          Mirrors agents-view.tsx:472 — base `.drawer-backdrop` is opacity:0;
          the `.open` class flips it to opacity:1 + pointer-events:auto. */}
      <div
        className={`drawer-backdrop${openPicker ? ' open' : ''}`}
        data-picker-backdrop
        hidden={openPicker === null}
      />
    </PageShell>
  )
}
