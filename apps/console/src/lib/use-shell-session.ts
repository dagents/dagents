'use client'

/**
 * use-shell-session — 终端会话的编排 hook（状态机 + boot + IO 动作）。
 *
 * 2026-09-19 P2 多标签：从单会话升级为标签页模型 —— tabs: {id, dirId}[] +
 * activeTabId，同目录复用（planOpenDir）、活动 tab attach/recreate（planTabsBoot）。
 * 历史踩坑语义全部保留：boot 进行中被换 tab 的 disposed 复验（防孤儿会话）、
 * recreate 先删后建（防恢复查询竞态复活）、键入实时取会话 id（防切 tab 瞬间
 * 打向已删会话）、深链意图一次性消费（防过期「带我去」反复压过新选择）。
 *
 * 语义单一事实源：
 *   - boot/目录入口决策 → lib/shell-session-plan（纯函数 + 单测）
 *   - SSE 帧解析/base64  → lib/shell-protocol（纯函数 + 单测）
 *   - xterm 主题映射     → lib/shell-theme
 *
 * 暴露：phase/exitCode/booted/cwd（含 ~ 折叠标签）/dirId/directories/
 * tabs/activeTabId/containerRef + 动作 newSession / reconnect / openIn /
 * browseDirectory / switchTo / closeTab / newTab。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { ShellSessionCreated, ShellSessionList, ShellStreamFrame, ShellSessionSummary } from '@dagents/contracts'
import { useDirectories } from '@/components/use-directories'
import { createDirectory, pickDirectory } from '@/lib/directories'
import { b64ToBytes, createShellFrameParser, strToB64 } from '@/lib/shell-protocol'
import {
  planOpenDir,
  planTabsBoot,
  resolveDirId,
  resolveDirPath,
  type ShellTabState,
} from '@/lib/shell-session-plan'
import { isDarkTheme, readToken, xtermTheme } from '@/lib/shell-theme'
import { useI18n } from '@/i18n'

/** 旧版单会话 key（迁移读；不再写入）。 */
const LEGACY_SESSION_KEY = 'dagents.terminal.sessionId'
/** 标签页持久化（[{id,dirId}]；隐私模式读写失败按空处理）。 */
const TABS_KEY = 'dagents.terminal.tabs'
const ACTIVE_KEY = 'dagents.terminal.activeTab'
/** 新会话的目标项目目录（目录 id；无 = 主目录）。新 tab 的默认落点。 */
const DIR_KEY = 'dagents.terminal.dirId'

export type ShellPhase = 'connecting' | 'live' | 'exited' | 'error'

function readTabs(): { tabs: ShellTabState[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const tabs = parsed.filter(
          (tb): tb is ShellTabState =>
            tb != null && typeof tb === 'object' && typeof (tb as ShellTabState).id === 'string',
        )
        const activeId = localStorage.getItem(ACTIVE_KEY)
        return { tabs, activeId: tabs.some((tb) => tb.id === activeId) ? activeId : null }
      }
    }
  } catch {
    /* 隐私模式 / 损坏 JSON —— 走迁移与空态 */
  }
  return { tabs: [], activeId: null }
}

function persistTabs(tabs: ShellTabState[], activeId: string | null): void {
  try {
    // pending 占位（会话未建）不落盘 —— 刷新瞬间的新 tab 意图按空态处理
    const clean = tabs.filter((tb) => tb.id !== '__pending__')
    localStorage.setItem(TABS_KEY, JSON.stringify(clean))
    const cleanActive = activeId != null && clean.some((tb) => tb.id === activeId) ? activeId : null
    if (cleanActive) localStorage.setItem(ACTIVE_KEY, cleanActive)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* 隐私模式 —— 不持久化不影响本次会话 */
  }
}

export function useShellSession() {
  const { t } = useI18n()
  const [phase, setPhase] = useState<ShellPhase>('connecting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  // 首字节前显示「正在启动 shell…」占位 —— zsh login 冷启动 2-5s，空屏像死机
  const [booted, setBooted] = useState(false)
  const [dirId, setDirId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [tabs, setTabs] = useState<ShellTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const { directories, reload: reloadDirs } = useDirectories()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const homeRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // boot 读动作的最新 tab 状态（动作在 effect 外触发，bootSeq 驱动 effect 重跑）
  const tabsRef = useRef<ShellTabState[]>([])
  const activeTabRef = useRef<string | null>(null)
  // 新会话按钮在 effect 外触发 —— 用递增序号驱动 boot effect 重跑
  const [bootSeq, setBootSeq] = useState(0)

  /** 统一的 tab 状态更新（state + ref + 持久化 + 活动目录偏好同步）。 */
  const commitTabs = useCallback((next: ShellTabState[], nextActive: string | null) => {
    tabsRef.current = next
    activeTabRef.current = nextActive
    setTabs(next)
    setActiveTabId(nextActive)
    persistTabs(next, nextActive)
    const activeDir = next.find((tb) => tb.id === nextActive)?.dirId ?? null
    setDirId(activeDir)
    try {
      if (activeDir === null) localStorage.removeItem(DIR_KEY)
      else localStorage.setItem(DIR_KEY, activeDir)
    } catch {
      /* 忽略 */
    }
  }, [])

  // 键入传输三要素：①保序（并行 fetch 不保序，快速连打实测字符成对乱序：
  // "echo PW_RENDER_OK" 到达 PTY 为 "ehco WP_ERN_DROK"）②微批（8ms 窗口
  // 聚积再单 POST，爆发输入不逐键 RTT）③失败可见。队列只跨 flush 保序；
  // 人类键速下窗口内永远只有单字符，等于直发；粘贴本就是单 onData。
  const pendingInputRef = useRef<string>('')
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve())

  const sendInput = useCallback((data: string) => {
    const id = sessionIdRef.current
    if (!id) return
    pendingInputRef.current += data
    if (flushTimerRef.current != null) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      const payload = pendingInputRef.current
      pendingInputRef.current = ''
      if (!payload) return
      // 实时取会话 id：切换标签瞬间在队列里的键击不能打向已卸下的旧会话
      const id2 = sessionIdRef.current
      if (!id2) return
      inputQueueRef.current = inputQueueRef.current
        .then(async () => {
          const res = await fetch(`/api/shell/${encodeURIComponent(id2)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: strToB64(payload) }),
          })
          if (!res.ok) setPhase('error')
        })
        .catch(() => {
          setPhase('error')
        })
    }, 8)
  }, [])

  /** 订阅输出流：帧解析走共享协议层（lib/shell-protocol，契约见 @dagents/contracts/shell）。 */
  const consumeStream = useCallback(async (term: Terminal, id: string, signal: AbortSignal) => {
    const res = await fetch(`/api/shell/${encodeURIComponent(id)}/stream`, {
      headers: { accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`stream subscribe failed (${res.status})`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parse = createShellFrameParser()

    const applyFrame = (frame: ShellStreamFrame) => {
      if (frame.event === 'hello') {
        const p = frame.data
        term.reset()
        if (p.replay) {
          term.write(b64ToBytes(p.replay))
          setBooted(true)
        }
        if (p.exited) {
          setExitCode(0)
          setPhase('exited')
          setBooted(true)
        } else {
          setPhase('live')
        }
      } else if (frame.event === 'data') {
        setBooted(true)
        term.write(b64ToBytes(frame.data.b64))
      } else if (frame.event === 'exit') {
        setBooted(true)
        setExitCode(frame.data.code)
        setPhase('exited')
      }
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parse(decoder.decode(value, { stream: true }))) applyFrame(frame)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    let disposed = false
    let term: Terminal | null = null
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('connecting')
    setExitCode(null)
    setBooted(false)

    const boot = async () => {
      // ?dir=<目录id> / ?agent=<agentid> 深链优先并一次性消费 —— 目录入口
      // （失败运行行 / 画布失败摘要 / Chat 错误卡）与交互式 agent 会话入口
      // （Agent 详情「交互式会话」）经此直达；消费后即从地址栏剥除（不触发
      // 导航），URL 里的旧意图若残留会在后续 boot 反复压过用户最新选择。
      let intentDir: string | null = null
      let intentAgent: string | null = null
      try {
        const params = new URLSearchParams(window.location.search)
        const dirFromUrl = params.get('dir')
        const agentFromUrl = params.get('agent')
        if (dirFromUrl || agentFromUrl) {
          if (dirFromUrl) {
            intentDir = dirFromUrl
            localStorage.setItem(DIR_KEY, dirFromUrl)
          }
          intentAgent = agentFromUrl
          const clean = new URL(window.location.href)
          clean.searchParams.delete('dir')
          clean.searchParams.delete('agent')
          window.history.replaceState(null, '', clean)
        }
      } catch {
        /* 隐私模式 —— 无深链 */
      }

      // 首次 boot（无 tabs ref）从 localStorage 读；动作触发的 reboot 用 ref
      if (tabsRef.current.length === 0 && activeTabRef.current === null) {
        const stored = readTabs()
        tabsRef.current = stored.tabs
        activeTabRef.current = stored.activeId
      }
      let legacySessionId: string | null = null
      let prefDirId: string | null = null
      try {
        legacySessionId = localStorage.getItem(LEGACY_SESSION_KEY)
        prefDirId = localStorage.getItem(DIR_KEY)
      } catch {
        /* 隐私模式 */
      }

      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (disposed) return

      term = new XTerm({
        allowTransparency: true,
        cursorBlink: true,
        convertEol: false,
        fontSize: 13,
        lineHeight: 1.2,
        fontFamily: readToken('--font-mono', 'Menlo, monospace'),
        theme: xtermTheme(isDarkTheme()),
        scrollback: 5000,
      })
      termRef.current = term
      const fit = new FitAddon()
      fitRef.current = fit
      term.loadAddon(fit)
      term.open(container)
      try {
        fit.fit()
      } catch {
        /* 容器尚未布局（首帧 0 宽）—— ResizeObserver 首拍会再 fit */
      }

      term.onData((data) => {
        if (sessionIdRef.current && !controller.signal.aborted) sendInput(data)
      })

      // ── 会话决策（单一语义源 lib/shell-session-plan，行为矩阵见其单测）──
      // 三个决策输入并行取；任何等待之后都要重验 disposed —— boot 进行中被
      // 切 tab / 新开（bootSeq++）时，旧 boot 若继续 create 会产出永不被
      // 订阅的孤儿会话白占槽位（StrictMode 双挂载同机理）。
      let sessionId: string | null = null
      let sessionCwd: string | null = null
      let homeDir: string | null = null
      try {
        const [dirsRes, listRes] = await Promise.all([
          fetch('/api/directories', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/shell', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ])
        if (disposed) return
        const directories = ((dirsRes as { data?: { items?: Array<{ id: string; path: string }> } } | null)?.data?.items ?? [])
        const sessions = ((listRes as { data?: ShellSessionList } | null)?.data?.sessions ?? []) as ShellSessionSummary[]
        homeDir = (listRes as { data?: ShellSessionList } | null)?.data?.home ?? null

        const plan = planTabsBoot({
          tabs: tabsRef.current,
          activeId: activeTabRef.current,
          legacySessionId,
          sessions,
          intentDirId: intentDir,
          prefDirId,
          directories,
        })

        /** 建会话（fresh/recreate 共用）；返回 null = 失败（boot 已写错误态）。 */
        const createSession = async (cwd?: string, agentId?: string): Promise<string | null> => {
          const created = await fetch('/api/shell', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cols: term!.cols,
              rows: term!.rows,
              ...(cwd ? { cwd } : {}),
              ...(agentId ? { agentId } : {}),
            }),
          })
          const body = (await created.json().catch(() => null)) as {
            success?: boolean
            data?: ShellSessionCreated
            error?: string
          } | null
          if (!created.ok || !body?.success || !body.data) {
            throw new Error(body?.error ?? `create session failed (${created.status})`)
          }
          if (body.data.home) homeRef.current = body.data.home
          sessionCwd = body.data.cwd ?? null
          createdLabel = body.data.label ?? null
          term!.reset()
          return body.data.sessionId
        }
        let createdLabel: string | null = null

        // P4 交互式 agent 会话（?agent= 深链）：人格 CLI 托管在 PTY —— 走
        // 独立建会话（带 agentId），落点 = 目录偏好（?dir= 已在上段落盘）；
        // 不可支持的 runtime 由网关 4xx 诚实拒绝（本 catch 写终端 + 错误态）。
        if (intentAgent) {
          const agentCwd = resolveDirPath(directories, prefDirId)
          const agentId = await createSession(agentCwd, intentAgent)
          if (!agentId) return
          sessionId = agentId
          const tab: ShellTabState = {
            id: agentId,
            dirId: prefDirId,
            ...(createdLabel ? { label: createdLabel } : {}),
          }
          commitTabs([...tabsRef.current.filter((tb) => tb.id !== '__pending__'), tab], agentId)
        } else if (plan.kind === 'attach') {
          // 恢复优先不打扰活会话；顺带用 cwd 反解刷新目录锚与展示标签
          sessionId = plan.session.id
          sessionCwd = plan.session.cwd ?? null
          const anchor = resolveDirId(directories, sessionCwd)
          const nextTabs = tabsRef.current.map((tb) =>
            tb.id === plan.tab.id
              ? { ...tb, dirId: anchor, ...(plan.session.label ? { label: plan.session.label } : {}) }
              : tb,
          )
          commitTabs(nextTabs, plan.tab.id)
        } else if (plan.kind === 'recreate') {
          // tab 身份不变、会话重建：已退出的残留会话先删（等删除完成再建，
          // 防恢复查询与 DELETE 竞态复活）
          await fetch(`/api/shell/${encodeURIComponent(plan.tab.id)}`, { method: 'DELETE' }).catch(() => {})
          if (disposed) return
          const freshId = await createSession(plan.cwd)
          if (!freshId) return
          sessionId = freshId
          commitTabs(
            tabsRef.current.map((tb) => (tb.id === plan.tab.id ? { ...tb, id: freshId } : tb)),
            freshId,
          )
        } else {
          // fresh：新 tab 项（深链/首次/legacy 已失效）
          const freshId = await createSession(plan.cwd)
          if (!freshId) return
          sessionId = freshId
          const tab: ShellTabState = { id: freshId, dirId: plan.dirId }
          commitTabs([...tabsRef.current.filter((tb) => tb.id !== '__pending__'), tab], freshId)
        }
        if (homeDir) homeRef.current = homeDir
      } catch (err) {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31m${t('终端连接失败')}\x1b[0m ${String(err instanceof Error ? err.message : err)}`)
          setPhase('error')
        }
        return
      }
      if (disposed || !sessionId) return
      sessionIdRef.current = sessionId
      setCwd(sessionCwd)

      // ── 输出流 ─────────────────────────────────────────────────
      try {
        await consumeStream(term, sessionId, controller.signal)
      } catch (err) {
        if (disposed || controller.signal.aborted) return
        // 网络抖动/代理重启用「可重连」呈现，不静默装死
        term.writeln(`\r\n\x1b[33m${t('连接断开')}\x1b[0m ${String(err instanceof Error ? err.message : err)}`)
        setPhase('error')
      }
    }
    void boot()

    // ── 视口尺寸同步（debounce，winsize 变化让 top/vim 立即重排） ──
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (!termRef.current || !fitRef.current) return
      try {
        fitRef.current.fit()
      } catch {
        return
      }
      const t = termRef.current
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const id = sessionIdRef.current
        if (!id || !t) return
        void fetch(`/api/shell/${encodeURIComponent(id)}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols: t.cols, rows: t.rows }),
        }).catch(() => {
          /* 尺寸同步失败不致命 */
        })
      }, 200)
    })
    ro.observe(container)

    // ── 主题跟随（tokens 驱动，切换即重设 xterm 主题） ─────────────
    const themeObserver = new MutationObserver(() => {
      if (termRef.current) termRef.current.options.theme = xtermTheme(isDarkTheme())
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      disposed = true
      controller.abort()
      ro.disconnect()
      themeObserver.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      // 卸载不杀会话：网关孤儿回收宽限内返回本页可无缝接回
      term?.dispose()
      termRef.current = null
      sessionIdRef.current = null
    }
    // t 故意不进依赖：boot 失败文案用首次渲染的词典足够（i18n 切语言重挂载整页）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootSeq, commitTabs, consumeStream, sendInput])

  /** 活动标签重建会话（「新开会话」：tab 身份不变，会话换新）。 */
  const newSession = useCallback(async () => {
    const old = sessionIdRef.current
    if (old) {
      await fetch(`/api/shell/${encodeURIComponent(old)}`, { method: 'DELETE' }).catch(() => {})
    }
    abortRef.current?.abort()
    setBootSeq((n) => n + 1)
  }, [])

  const reconnect = useCallback(() => {
    abortRef.current?.abort()
    setBootSeq((n) => n + 1)
  }, [])

  /** 目录入口（选择器/深链热路径）：同目录复用 tab，异目录新 tab。 */
  const openIn = useCallback(
    async (target: string | null) => {
      const open = planOpenDir({ tabs: tabsRef.current, target })
      if (open.kind === 'activate') {
        if (open.tabId === activeTabRef.current) return
        abortRef.current?.abort()
        setBootSeq((n) => n + 1)
        return
      }
      // 新 tab：先记 pending（boot 的 fresh 分支建会话后回填真实 id）
      const pending: ShellTabState = { id: '__pending__', dirId: target }
      commitTabs([...tabsRef.current, pending], '__pending__')
      abortRef.current?.abort()
      setBootSeq((n) => n + 1)
    },
    [commitTabs],
  )

  /** 切换标签：attach 该 tab 的会话（活则回放接续，死则原地重建）。 */
  const switchTo = useCallback(
    (tabId: string) => {
      if (tabId === activeTabRef.current) return
      if (!tabsRef.current.some((tb) => tb.id === tabId)) return
      commitTabs(tabsRef.current, tabId)
      abortRef.current?.abort()
      setBootSeq((n) => n + 1)
    },
    [commitTabs],
  )

  /** 关闭标签：删会话 + 移除 tab；最后一个 tab 关掉 → 自动开一个新空 tab。 */
  const closeTab = useCallback(
    async (tabId: string) => {
      const rest = tabsRef.current.filter((tb) => tb.id !== tabId)
      void fetch(`/api/shell/${encodeURIComponent(tabId)}`, { method: 'DELETE' }).catch(() => {})
      if (rest.length === 0) {
        // 最后一个：关掉等于「清空重来」—— pending 新 tab，boot 建会话
        commitTabs([{ id: '__pending__', dirId: null }], '__pending__')
      } else {
        const wasActive = activeTabRef.current === tabId
        const nextActive = wasActive
          ? (rest.find((tb) => tb.id !== '__pending__') ?? rest[0]).id
          : activeTabRef.current
        commitTabs(rest, nextActive)
      }
      abortRef.current?.abort()
      setBootSeq((n) => n + 1)
    },
    [commitTabs],
  )

  /** 「+」：在活动标签同目录开新 tab（最常见的「再开一个同项目终端」）——
   *  显式动作永远真开新会话，不做复用拦截（复用是目录入口 openIn 的语义）。 */
  const newTab = useCallback(() => {
    const dir = tabsRef.current.find((tb) => tb.id === activeTabRef.current)?.dirId ?? null
    commitTabs([...tabsRef.current, { id: '__pending__', dirId: dir }], '__pending__')
    abortRef.current?.abort()
    setBootSeq((n) => n + 1)
  }, [commitTabs])

  /** 「浏览本地目录…」：OS 原生选框 → 注册目录 → 切换过去。 */
  const browseDirectory = useCallback(async (): Promise<void> => {
    setPicking(true)
    try {
      const path = await pickDirectory()
      if (!path) return // 用户取消 OS 对话框 —— 静默
      const dir = await createDirectory({ path })
      await reloadDirs()
      await openIn(dir.id)
    } finally {
      setPicking(false)
    }
  }, [reloadDirs, openIn])

  /** 家目录折叠显示（设计密度契约：mono 11px meta，路径过长截断） */
  const cwdLabel = (() => {
    if (!cwd) return null
    const home = homeRef.current
    const trimmed = cwd !== '/' ? cwd.replace(/\/+$/, '') : cwd
    const label = home && trimmed.startsWith(home) ? `~${trimmed.slice(home.length)}` : trimmed
    return label || '~'
  })()

  return {
    // 状态
    phase,
    exitCode,
    booted,
    cwd,
    cwdLabel,
    dirId,
    directories,
    picking,
    tabs,
    activeTabId,
    // 挂载点与动作
    containerRef,
    newSession,
    reconnect,
    openIn,
    browseDirectory,
    switchTo,
    closeTab,
    newTab,
  }
}
