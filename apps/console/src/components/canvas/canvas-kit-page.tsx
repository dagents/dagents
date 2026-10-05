'use client'

/* eslint-disable @typescript-eslint/no-explicit-any -- 存量 flowData 的节点/边是宽松 JSON（gateway 透传存储），新画布读入侧由 model/normalize 归一 */

/**
 * Canvas Kit 页客户端 —— 自研画布（flow-canvas/）的宿主。
 *
 * 与旧 FlowiseCanvas（vendor/agentflow 宿主）同一 props 契约、同一套
 * console 自有的运行/结果/工具栏逻辑（逐行移植自 flowise-canvas.tsx，
 * 2026-08-22~09-05 的产品裁决全部保留）；差异只在画布本体：
 *  - <Agentflow> → <FlowEditor>（header 插槽 + FlowEditorHandle）
 *  - vendor ref 徽章/setEdges 边状态 → applyRunStates 单向注入
 *  - convertToFlowiseFormat 形状税 → FlowEditor 内部 model/normalize
 * 类名沿用 console 自有的 .canvas-*（canvas.css 继续生效，e2e 选择器不变）；
 * 顶栏容器类从 vendor 的 .agentflow-* 改名 .canvas-header-*。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HumanInputAnswerFields } from '@/components/human-input-answer-fields'
import { extractHumanInputPrompts, buildHumanInputsState } from '@/lib/flow-human-inputs'
import type { FlowData } from '@dagents/workflow'
import { validateFlowTopology } from '@dagents/workflow'
import { useToast } from '@/components/toast'
import { useI18n, readLocalePreference } from '@/i18n'
import { Icon } from '@/components/icon'
import { pickDirectory, createDirectory } from '@/lib/directories'
import { fetchRunNodeSpans, type RunNodeSpan } from '@/lib/node-spans'
import { usePolling } from '@/lib/use-polling'
import {
  SaveFlowTemplateDialog,
  scanTemplateParamNames,
} from '@/components/save-flow-template-dialog'
import { FlowVersionsDialog } from '@/components/canvas/flow-versions-dialog'
import { FlowContextDialog } from '@/components/canvas/flow-context-dialog'
import {
  FlowEditor,
  type FlowEditorHandle,
  type HeaderSlotProps,
  type NodeRunStatus,
} from '@/components/flow-canvas'
import { type TerminalSendResult } from '@/components/run-terminal'
import { CanvasResultsPanel, type CanvasRunState } from '@/components/canvas/canvas-results-panel'
import { useRunLive } from '@/lib/use-run-live'
// .kbd（统一 kbd 键帽，shortcuts.css 单一定义、GL03/GL06 全站共用）
import '@/styles/shortcuts.css'
import '@/styles/flow-canvas.css'
import './canvas.css'

/** 未保存守卫的 confirm 文案（confirm 是原生弹窗，走不了 React i18n ——
 *  读当前 locale 给双语；默认中文）。locale 读取走 i18n 模块的单源
 *  helper（存储键 + 解析规则与 Provider 共用）。 */
function unsavedMessage(): string {
  return readLocalePreference() === 'en'
    ? 'Canvas has unsaved changes. Leave anyway?'
    : '画布有未保存的修改，确定离开吗？'
}

export interface CanvasKitPageProps {
  flowId: string
  flowName?: string
  initialFlow: {
    nodes: any[]
    edges: any[]
    viewport?: any
  }
  onSave?: (data: FlowData) => Promise<void>
  readOnly?: boolean
  /** 旁观一个已有运行（如 chat @flow 触发）：挂载后自动轮询并点亮节点/连线。 */
  watchRunId?: string | null
  /** flow 级上下文（P2a，2026-10-04）：服务端取的 flows.context_md。 */
  initialContextMd?: string | null
  /** ?created=1 —— 模板实例化落地：显示一次性首跑引导条。 */
  firstRunHint?: boolean
}

/** span 展示工具（formatSpanPayload / spanToDisplay / activity 流 / tokens
 *  徽章 / LiveElapsed）已随结果面板迁 canvas-results-panel.tsx
 *  （2026-09-22 解耦）。 */

/**
 * 拓扑问题清单 → toast 文案片段：展示前 limit 条原文（校验器消息含节点 id），
 * 超出部分折叠为「等 {n} 条」计数。
 */
function formatTopologyIssues(
  issues: ReadonlyArray<{ message: string }>,
  limit: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const shown = issues
    .slice(0, limit)
    .map((issue) => issue.message)
    .join('；')
  return issues.length > limit ? `${shown} …${t('等 {n} 条', { n: issues.length })}` : shown
}

/** gateway run_node_spans.status → 画布运行态徽章。 */
const SPAN_STATUS_MAP: Record<string, NodeRunStatus> = {
  running: 'running',
  completed: 'done',
  done: 'done',
  failed: 'failed',
  error: 'failed',
  paused: 'waiting',
}

export function CanvasKitPage({
  flowId,
  flowName = 'Untitled',
  initialFlow,
  onSave,
  readOnly = false,
  watchRunId = null,
  firstRunHint = false,
  initialContextMd = null,
}: CanvasKitPageProps): React.ReactElement {
  const editorRef = useRef<FlowEditorHandle>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const toast = useToast()
  const { t } = useI18n()

  // ── 画布内运行 + 节点实时进度 ──
  // run POST 是同步执行完才返回，但网关接受客户端自带的 x-run-id 请求头，
  // 因此画布自己生成 runId、带着头发起运行，同时轮询 node-spans 把
  // 每个节点的 status 实时刷到节点徽章（running = 旋转，done = 绿勾，
  // failed = 红叉 + 错误提示）。
  const [runState, setRunState] = useState<CanvasRunState>('idle')
  // 断点续跑（2026-09-18）：失败终态拉 checkpoint 判 resumable；awaiting 挂起载荷
  const [resumeInfo, setResumeInfo] = useState<{ runId: string; completedCount: number } | null>(
    null,
  )
  const [awaitingInfo, setAwaitingInfo] = useState<{
    nodeId: string
    prompt: string
    inputType: string
    options: string[]
  } | null>(null)
  const [runSummary, setRunSummary] = useState<string | null>(null)
  // 画布直跑的旁观目标（handleRun 成功后置位）：runId + 起跑时刻。
  // 轮询循环本身走 usePolling（700ms + 可见性暂停），这里只持有目标。
  const [watch, setWatch] = useState<{ runId: string; startedAt: number } | null>(null)
  // 运行实时终端（live attach，2026-09）：运行中订阅 run-live 帧流，终端
  // 视图直播（执行顺序 + 逐帧到达）；404 / 断流自动回退 node-spans 轮询
  // 渲染（可用性阶梯见 use-run-live.ts）。应答/续跑回到 running 时重连，
  // hello.replay 带上挂起前的全部帧（runEnd 成为阶段边界）。
  const runLive = useRunLive(runState === 'running' ? (watch?.runId ?? null) : null)
  // 画布直跑接管轮询时，旁观模式（?run=）的自有循环退位 —— 与旧
  // watchLoop 开场 clearInterval 的接管语义等价。
  const manualWatchRef = useRef(false)

  // 运行输入 + 运行结果：点「▶ 运行」先弹输入面板（作为 {{$start.input}}
  // 传入 —— 没有输入的运行对 LLM/Agent 节点毫无意义）；spans 驱动顶栏的
  // 「运行结果」面板，逐节点展示状态/耗时/产出。
  const [runPanelOpen, setRunPanelOpen] = useState(false)
  // 另存为模板（2026-08-30 从页面级 CanvasTopBar 并入 —— 消灭双标题）
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [contextMd, setContextMd] = useState(initialContextMd)
  // 首跑引导条（模板落地）：显示一次即清 URL 参数，刷新不再打扰
  const [firstRunBar, setFirstRunBar] = useState(firstRunHint)
  useEffect(() => {
    if (!firstRunBar) return
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* 忽略 */
    }
  }, [firstRunBar])
  const [runInput, setRunInput] = useState(() => {
    // 输入记忆（2026-09-08 可操作终端 PRD §4.2，⬆ 等价物）：按 flowId 记
    // 上次提交的输入，打开面板即预填 —— 与 dagents.canvas.runDir 同模式。
    try {
      return window.localStorage.getItem(`dagents.canvas.runInput.${flowId}`) ?? ''
    } catch {
      return ''
    }
  })

  // HumanInput 预供答案（2026-09-18）：画布自有 flow 文档，直接提取待答清单
  const humanSpecs = useMemo(() => extractHumanInputPrompts(initialFlow), [initialFlow])
  const [humanAnswers, setHumanAnswers] = useState<Record<string, string>>({})
  const persistRunInput = useCallback(
    (input: string): void => {
      try {
        window.localStorage.setItem(`dagents.canvas.runInput.${flowId}`, input)
      } catch {
        /* 忽略 */
      }
    },
    [flowId],
  )
  const [resultsOpen, setResultsOpen] = useState(false)
  /** run 级失败原因（2026-09-22）：零 span 的整体失败（如拓扑成环）没有
   *  节点可看，唯一线索是它 —— 「运行结果」按钮的存在性也依赖这个而非
   *  仅 spans 数（否则失败越早、越没有入口，toast 指路成死链）。 */
  const [runError, setRunError] = useState<string | null>(null)
  // 当前运行（2026-09-08 可操作终端）：stdin 行插话路由的目标 run ——
  // 画布直跑 = handleRun 生成的 runId；旁观 = URL ?run= 的 watchRunId。
  const [activeRunId, setActiveRunId] = useState<string | null>(watchRunId ?? null)
  // 插话能力位（node-spans inputSupported）：该 run 当前有活 CLI 会话汇点。
  // undefined（旧网关）按支持处理，发送失败时由回执兜底。
  const [inputSupported, setInputSupported] = useState(true)
  // 旁观/刷新恢复的 run 目录锚（P0 数据链，node-spans 回传）：失败入口
  // 「在项目目录打开终端」在非本会话发起的 run 上也能锚定目录。
  const [spectatedRunDirId, setSpectatedRunDirId] = useState<string | null>(null)
  const [latestSpans, setLatestSpans] = useState<RunNodeSpan[]>([])
  /* 结果面板展示态（视图切换 localStorage 记忆 / 行内 ioOpen / 手动折叠
   * 记忆 / 滚动跟随 / 挂起应答输入态）已内聚 CanvasResultsPanel
   * （2026-09-22 解耦）—— 新一轮 run 的折叠记忆清空由组件内
   * runState 边沿 effect 承接。 */
  // 项目目录：Agent/LLM 节点的 CLI 在这个目录里干活。选择记忆在
  // localStorage（dagents.canvas.runDir），跨刷新保留。
  const [directories, setDirectories] = useState<
    Array<{ id: string; path: string; name?: string }>
  >([])
  const [runDirectoryId, setRunDirectoryId] = useState<string>('')
  const reloadDirectories = useCallback((preferId?: string) => {
    void fetch('/api/directories', { cache: 'no-store' })
      .then((r) => r.json())
      .then((body: { data?: { items?: Array<{ id: string; path: string; name?: string }> } }) => {
        const items = body?.data?.items ?? []
        setDirectories(items)
        try {
          if (preferId && items.some((d) => d.id === preferId)) {
            setRunDirectoryId(preferId)
            return
          }
          const saved = window.localStorage.getItem('dagents.canvas.runDir')
          if (saved && items.some((d) => d.id === saved)) setRunDirectoryId(saved)
          else if (items[0]) setRunDirectoryId(items[0]!.id)
        } catch {
          /* 无 localStorage 则默认选第一个 */
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    reloadDirectories()
  }, [reloadDirectories])

  // 添加项目目录（2026-08-30 用户需求：运行输入面板选不到想要的文件夹时
  // 直接加，不跳设置页）—— OS 目录选择器 + 注册 + 选中新目录
  const [addingDir, setAddingDir] = useState(false)
  const handleAddDirectory = useCallback(async (): Promise<void> => {
    if (addingDir) return
    setAddingDir(true)
    try {
      const path = await pickDirectory()
      if (!path) return // 用户取消 OS 对话框
      const created = await createDirectory({ path })
      reloadDirectories(created.id)
      try {
        window.localStorage.setItem('dagents.canvas.runDir', created.id)
      } catch {
        /* 忽略 */
      }
      toast.success(t('目录已添加：{name}', { name: created.name || created.path }))
    } catch {
      toast.error(t('添加项目目录失败'))
    } finally {
      setAddingDir(false)
    }
  }, [addingDir, reloadDirectories, toast, t])

  // 运行输入面板：Esc / 点外关闭（2026-08-30 —— 此前只有角落「取消」
  // 文字钮，用户找不到出口）。排除 ▶运行 按钮自身（外关 + 自身 toggle
  // 叠加会变成「关了又开」）。
  const runPanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!runPanelOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRunPanelOpen(false)
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (runPanelRef.current?.contains(t)) return
      if (t?.closest?.('.canvas-run-btn')) return
      setRunPanelOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [runPanelOpen])

  /** 团队模板的运行输入引导（start 节点 data.inputHint/inputExample）——
   *  有则替换引擎术语 placeholder，第一次跑模板的用户才知道该输入什么。 */
  const startInputHint = useMemo(() => {
    const start = initialFlow.nodes.find((n) => (n.data?.name ?? n.name) === 'startAgentflow')
    return {
      hint: start?.data?.inputHint as string | undefined,
      example: start?.data?.inputExample as string | undefined,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFlow])

  /** 模板参数预扫描（PX-CV04）：另存为模板对话框的 {{变量}} chip 网格数据源。 */
  const templateParamNames = useMemo(
    () => scanTemplateParamNames(initialFlow.nodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlow],
  )

  /** 节点拓扑序（FR-15：结果面板行序按 initialFlow 节点顺序，未知节点垫底）。
   *  终端视图与摘要视图两个分支共用 —— 此前两处相邻 IIFE 各建一份 Map。 */
  const topoOrder = useMemo(
    () => new Map(initialFlow.nodes.map((n, i) => [n.id as string, i])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlow],
  )

  const applySpans = useCallback((spans: ReadonlyArray<RunNodeSpan>): void => {
    const nodeStates: Record<string, { status: NodeRunStatus; error?: string }> = {}
    for (const s of spans) {
      const status = s.status ? SPAN_STATUS_MAP[s.status] : undefined
      if (s.nodeId && status) nodeStates[s.nodeId] = { status, error: s.error ?? undefined }
    }
    editorRef.current?.applyRunStates(nodeStates)
  }, [])

  /** 轮询一次 spans + run 终态。返回 runStatus（无 runs 行时为 null）及
   *  span 概况 —— 旁观模式的启发式收尾需要区分「执行中」和「查不到」；
   *  spans 一并返回（失败即时检测要基于**本轮刚 fetch 到的新数据**判定，
   *  不回头读 state）。 */
  const fetchSpans = useCallback(
    async (
      runId: string,
    ): Promise<{
      runStatus: string | null
      hasRunning: boolean
      hasSpans: boolean
      spans: RunNodeSpan[]
    }> => {
      const r = await fetchRunNodeSpans(runId)
      // !ok（含 404 = 尚未落库）→ 下轮再试；轮询失败静默，最终状态以
      // run POST 的返回为准
      if (!r.ok) return { runStatus: null, hasRunning: false, hasSpans: false, spans: [] }
      applySpans(r.spans)
      setLatestSpans(r.spans)
      setRunError(r.runError ?? null)
      if (r.inputSupported != null) setInputSupported(r.inputSupported)
      if (r.runDirectoryId != null) setSpectatedRunDirId(r.runDirectoryId)
      return {
        runStatus: r.runStatus,
        hasRunning: r.spans.some((sp) => (sp.status ?? '') === 'running'),
        hasSpans: r.spans.length > 0,
        spans: r.spans,
      }
    },
    [applySpans],
  )

  const summarizeWatch = useCallback(
    (status: string | null): void => {
      if (status === 'completed') {
        setRunState('done')
        setRunSummary(t('运行完成'))
      } else if (status === 'cancelled') {
        setRunState('failed')
        setRunSummary(t('已取消'))
      } else {
        setRunState('failed')
        setRunSummary(t('运行失败'))
      }
    },
    [t],
  )

  /** 统一的运行旁观循环（usePolling 驱动：700ms + 可见性暂停）：轮询
   *  spans/runStatus 直到终态；任一 span 失败立即置失败（不等 POST/runs
   *  行）—— 引擎失败后可能还有长收尾。失败判定基于**本轮刚 fetch 的
   *  spans**（2026-09-17 修复：此前写在 setLatestSpans updater 里 ——
   *  updater 必须纯，StrictMode 双调用会双发 toast，且读到的是上一轮
   *  state）。返回 false 即停（usePolling 终态即停）。 */
  const watchTick = useCallback(async (): Promise<boolean> => {
    if (!watch) return false
    const { runStatus, spans } = await fetchSpans(watch.runId)
    // 持久挂起（P2）：非终态 —— 面板亮出应答入口，继续轮询等续跑。
    // 必须返回 true：usePolling 只认 restartKey（runId），而应答是同
    // runId 原地续跑，若在此停轮，应答后的完成态永远无人捕获（2026-09-18）。
    if (runStatus === 'awaiting_input') {
      setRunState('awaiting')
      void refreshCheckpointState(watch.runId)
      return true
    }
    if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
      await fetchSpans(watch.runId) // 收尾定格：终态徽章齐全
      const duration = ((Date.now() - watch.startedAt) / 1000).toFixed(1)
      if (runStatus === 'completed') {
        setRunState('done')
        setRunSummary(t('运行完成 · {n}s', { n: duration }))
        toast.show(t('运行完成 · {n}s', { n: duration }), 'success', 4000)
      } else if (runStatus === 'cancelled') {
        setRunState('failed')
        setRunSummary(t('已取消 · {n}s', { n: duration }))
      } else {
        setRunState('failed')
        setRunSummary(t('运行失败 · {n}s', { n: duration }))
        toast.error(t('运行失败 — 详见「运行结果」面板中红色节点'), 6000)
      }
      return false
    }
    // 失败即时检测：span 已 failed 但 runs 行还没落 —— 立即置失败，
    // 不再让按钮转圈（此前用户会看到「失败」却还在「运行中」）。
    const failed = spans.find((sp) => sp.status === 'failed')
    if (failed) {
      setRunState('failed')
      setRunSummary(
        t('运行失败 · {node}', { node: failed.nodeLabel || failed.nodeId || '?' }) +
          (failed.error ? `：${String(failed.error).slice(0, 60)}` : ''),
      )
      toast.error(
        t('节点 {node} 失败 — 展开运行结果查看详情', {
          node: failed.nodeLabel || failed.nodeId || '?',
        }),
        8000,
      )
      return false
    }
    return true
  }, [watch, fetchSpans, toast, t])
  // watch 置位即轮询（restartKey=runId：连跑第二次也立即重入）
  usePolling(watch ? watchTick : null, {
    intervalMs: 700,
    visibilityPause: true,
    restartKey: watch?.runId,
  })

  const handleRun = useCallback(
    async (input: string, humanInputs?: Record<string, string>): Promise<void> => {
      if (runState === 'running') return
      // 断点续跑模式（2026-09-18）：resumeInfo 在场 → 提交到 resume 端点
      const isResume = resumeInfo != null
      setRunPanelOpen(false)
      setResultsOpen(true)
      setLatestSpans([])
      setRunError(null)
      editorRef.current?.clearRunState()
      setRunState('running')
      setRunSummary(null)
      // 输入记忆（⌃ 语义）：提交即记，⌘⏎ 重跑时预填
      persistRunInput(input)

      const clientRunId = crypto.randomUUID()
      const startedAt = Date.now()
      try {
        // 异步模式：立即返回 runId，进度全靠轮询 —— 同步等待会让长流程
        //（如 5-9 分钟的多 Agent 链）撞上代理层 300s 超时，客户端误报失败。
        //（resumeRunId/skipCount 提前捕获：submit 闭包里 TS 无法维持别名收窄）
        const resumeRunId = resumeInfo?.runId ?? ''
        const resumeSkipCount = resumeInfo?.completedCount ?? 0
        const submit = (asResume: boolean): Promise<Response> =>
          fetch(
            asResume
              ? `/api/workflows/runs/${encodeURIComponent(resumeRunId)}/resume`
              : `/api/workflows/${encodeURIComponent(flowId)}/run?async=1`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(!asResume ? { 'x-run-id': clientRunId } : {}),
              },
              body: JSON.stringify({
                ...(input.trim() ? { input: input.trim() } : {}),
                ...(runDirectoryId ? { directoryId: runDirectoryId } : {}),
                // HumanInput 预供答案（2026-09-18）：与列表运行面板同契约
                ...(humanInputs ? { humanInputs } : {}),
              }),
            },
          )
        let asResume = isResume
        let res = await submit(asResume)
        let json = (await res.json().catch(() => null)) as {
          success?: boolean
          error?: string
          data?: { runId?: string }
        } | null
        // 断点已过期（流程拓扑变了，resume 被网关 422 拒）：旧 checkpoint 的
        // 种子输出指向已不存在的图，续跑唯一正确语义是作废 —— 自动回退
        // 全新跑一次，不把用户摁死在报错里（2026-09-23：flow 被覆盖/重排
        // 后点旧「继续/重试」即触发）。
        if (asResume && res.status === 422 && /topology changed/.test(json?.error ?? '')) {
          setResumeInfo(null)
          asResume = false
          toast.info(t('流程已修改，旧断点失效 —— 已改为全新运行'), 5000)
          res = await submit(false)
          json = (await res.json().catch(() => null)) as typeof json
        }
        if (!res.ok || !json?.success) {
          setRunState('failed')
          const reason = json?.error ?? `HTTP ${res.status}`
          setRunSummary(t('启动失败 · {reason}', { reason: reason.slice(0, 80) }))
          toast.error(t('启动失败：{reason}', { reason: reason.slice(0, 120) }), 8000)
          return
        }
        // resume 端点分配新 runId；直跑沿用客户端预生成 id
        const effectiveRunId = json.data?.runId ?? clientRunId
        setActiveRunId(effectiveRunId)
        if (asResume) {
          setResumeInfo(null)
          toast.info(
            t('已从断点继续 —— 跳过 {n} 个已完成节点', { n: String(resumeSkipCount) }),
            5000,
          )
        }
        // 画布直跑接管旁观：manualWatchRef 让 ?run= 的自有循环退位
        manualWatchRef.current = true
        setWatch({ runId: effectiveRunId, startedAt })
      } catch (err) {
        setRunState('failed')
        const reason = err instanceof Error ? err.message : String(err)
        setRunSummary(t('启动失败 · {reason}', { reason: reason.slice(0, 80) }))
        toast.error(t('启动失败：{reason}', { reason: reason.slice(0, 120) }), 8000)
      }
    },
    [runState, flowId, toast, t, runDirectoryId, persistRunInput, resumeInfo],
  )

  /** 运行中插话（2026-09-08 可操作终端）：POST message 路由，同步回执
   *  三态。409（整个 run 已无活执行）→ not_running —— 终端 stdin 行
   *  同帧就会翻到结束态，这里只负责如实回执。 */
  const sendMessage = useCallback(
    async (nodeId: string, text: string): Promise<TerminalSendResult> => {
      if (!activeRunId) return 'not_running'
      try {
        const res = await fetch(`/api/workflows/runs/${encodeURIComponent(activeRunId)}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodeId, text }),
        })
        const json = (await res.json().catch(() => null)) as {
          success?: boolean
          data?: { status?: string }
        } | null
        if (res.ok && json?.success) {
          const status = json.data?.status
          return status === 'sent' || status === 'unsupported' || status === 'not_running'
            ? status
            : 'error'
        }
        if (res.status === 409) return 'not_running'
        return 'error'
      } catch {
        return 'error'
      }
    },
    [activeRunId],
  )

  /** 断点续跑状态刷新（2026-09-18）：failed→resumable 入口判定；
   *  awaiting→挂起载荷（prompt/options）。失败终态或 awaiting 时调用。 */
  const refreshCheckpointState = useCallback(async (runId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/checkpoint`)
      const json = (await res.json()) as {
        success?: boolean
        data?: {
          status?: string
          completedNodeCount?: number
          awaiting?: {
            nodeId: string
            prompt: string
            inputType: string
            options?: unknown[]
          } | null
        }
      }
      if (!json.success || !json.data) return
      if (json.data.status === 'resumable') {
        setResumeInfo({ runId, completedCount: json.data.completedNodeCount ?? 0 })
      } else if (json.data.status === 'awaiting_input' && json.data.awaiting) {
        setAwaitingInfo({
          nodeId: json.data.awaiting.nodeId,
          prompt: json.data.awaiting.prompt,
          inputType: json.data.awaiting.inputType,
          options: (json.data.awaiting.options ?? []).filter(
            (o): o is string => typeof o === 'string',
          ),
        })
      } else {
        setResumeInfo(null)
        setAwaitingInfo(null)
      }
    } catch {
      // checkpoint 不可达不影响主流程
    }
  }, [])

  /** 失败终态 → 拉一次 checkpoint（resumable 才亮「从此处继续」）。 */
  useEffect(() => {
    if (runState === 'failed' && activeRunId) void refreshCheckpointState(activeRunId)
    if (runState !== 'awaiting') setAwaitingInfo(null)
    if (runState !== 'failed') setResumeInfo(null)
  }, [runState, activeRunId, refreshCheckpointState])

  /** 打开运行输入面板的唯一入口（2026-09-22）：同时收起运行结果面板 ——
   *  两个弹窗共用同一锚点（absolute right:0），同时打开会完全叠住；
   *  「重跑/续跑/▶运行/立即运行」都走这里，互斥收敛为一点。 */
  const openRunPanel = useCallback((): void => {
    setRunPanelOpen(true)
    setResultsOpen(false)
  }, [])

  /** 从此处继续（§6.6）：走 resume 端点 —— 新 runId，种子跳过已完成节点。 */
  const handleResume = useCallback((): void => {
    if (!resumeInfo || runState === 'running') return
    openRunPanel()
  }, [resumeInfo, runState, openRunPanel])

  /** 停止（PM 走查 2026-09-20）：运行结果面板是运行监控中心，此前却没有
   *  停止入口 —— 想中途放弃只能干等或去别处。POST cancel → 引擎 abort，
   *  轮询自然收敛为已取消。 */
  const cancelRun = useCallback(async (): Promise<void> => {
    if (!activeRunId) return
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(activeRunId)}/cancel`, {
        method: 'POST',
      })
      const json = (await res.json().catch(() => null)) as {
        success?: boolean
        error?: string
      } | null
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? t('停止失败'), 6000)
        return
      }
      toast.info(t('已请求停止，等待运行收敛…'), 4000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 6000)
    }
  }, [activeRunId, toast, t])

  /** 应答提交（P2）：同 runId 原地续跑，回到 running 继续旁观。
   *  输入态与回执清空在 CanvasResultsPanel 侧 —— 这里只执行请求，
   *  返回是否成功（true 时组件清空输入框，不做假乐观）。 */
  const submitAnswer = useCallback(
    async (answer: string): Promise<boolean> => {
      if (!activeRunId || !answer) return false
      try {
        const res = await fetch(`/api/workflows/runs/${encodeURIComponent(activeRunId)}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer }),
        })
        const json = (await res.json()) as { success?: boolean; error?: string }
        if (!res.ok || !json.success) {
          toast.error(json.error ?? t('提交答案失败'), 6000)
          return false
        }
        setAwaitingInfo(null)
        setRunState('running')
        manualWatchRef.current = true
        setWatch({ runId: activeRunId, startedAt: Date.now() })
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), 6000)
        return false
      }
    },
    [activeRunId, toast, t],
  )

  /** stdin 行结束态的「重跑」入口（就近原则）：打开运行输入面板 ——
   *  输入已在面板初始化时从记忆预填（persistRunInput），⬆ 语义。 */
  const handleRerun = useCallback((): void => {
    openRunPanel()
  }, [openRunPanel])

  // ── 旁观模式（canvas?run=<runId>）：自动轮询并点亮节点/连线 ──
  // 典型来源：chat @flow / 运行对话框触发的运行（「画布旁观」链接）。
  // 2026-09-20 收敛到 usePolling（消除最后一只手写轮询循环，2026-09-17
  // 的 TODO 兑现）：获得可见性暂停 + 终态即停的统一语义。终止条件不变
  // —— runs 行终态；无 runs 行时退化为启发式（连续 8 轮无 running span
  // 且已有 span）；awaiting_input 挂起继续轮询（应答后 watchTick 接管）。
  const stablePollsRef = useRef(0)
  useEffect(() => {
    if (!watchRunId) return
    stablePollsRef.current = 0
    setActiveRunId(watchRunId)
    setRunState('running')
    setRunSummary(null)
    // 旁观即看流：结果面板默认打开 —— 否则徽章在亮、面板却关着，
    // 流式 live tail 默认不可见（2026-08-30 修复）。
    setResultsOpen(true)
    editorRef.current?.clearRunState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchRunId])

  const spectateTick = useCallback(async (): Promise<boolean> => {
    // 画布直跑已接管（watchTick 700ms 循环）—— 旁观循环退位
    if (!watchRunId || manualWatchRef.current) return false
    const { runStatus, hasRunning, hasSpans } = await fetchSpans(watchRunId)
    // 持久挂起（2026-09-19 行为测试逮出）：awaiting_input 亮应答面板、
    // 继续轮询 —— 应答后 submitAnswer 把接力棒交给 watchTick 收尾。
    if (runStatus === 'awaiting_input') {
      setRunState('awaiting')
      void refreshCheckpointState(watchRunId)
      return true
    }
    if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
      summarizeWatch(runStatus)
      return false
    }
    // 启发式（无 runs 行的旧运行 / 查询失败）：已有 span、无 running、
    // 且连续多轮无进展才收尾 —— 有节点在跑（hasRunning）绝不误判。
    if (!runStatus && hasSpans && !hasRunning) {
      stablePollsRef.current += 1
      if (stablePollsRef.current >= 8) {
        summarizeWatch(null)
        return false
      }
    } else {
      stablePollsRef.current = 0
    }
    return true
  }, [watchRunId, fetchSpans, summarizeWatch, refreshCheckpointState])

  usePolling(watchRunId && !manualWatchRef.current ? spectateTick : null, {
    intervalMs: 900,
    visibilityPause: true,
    restartKey: watchRunId,
  })

  // 布局自动保存（2026-09-06 画布优化）：拖拽停/视口停后 FlowEditor debounce
  // 调用 —— 静默 merge 到 flow_data（只动坐标与视口）。失败不打扰：布局
  // 无语义价值，下次拖动自然重试；配置编辑仍走显式「保存」管线。
  const persistLayout = useCallback(
    (layout: {
      positions: Record<string, { x: number; y: number }>
      viewport: { x: number; y: number; zoom: number }
    }): void => {
      void fetch(`/api/workflows/${encodeURIComponent(flowId)}/layout`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(layout),
      }).catch(() => {})
    },
    [flowId],
  )

  const handleSave = useCallback(async (): Promise<void> => {
    const flowData = editorRef.current?.getDocument()
    if (!flowData) return
    // 保存前拓扑干跑（docs/product-plan.md 方案 A4）：errors=不可执行 /
    // warnings=可疑，全部不阻断保存 —— 尊重草稿自由，把「执行时才爆炸」
    // 提前到「保存时就看见」。校验器是 @dagents/workflow 的 AD-2 单源实现。
    const topology = validateFlowTopology(flowData)
    // 保存成功后才提示 —— PUT 失败时说「已保存」会误导。
    // 全干净不提示：保存按钮已有「已保存 ✓」状态反馈，不重复。
    const notifyTopologyAfterSave = () => {
      if (!topology.ok) {
        toast.error(
          `${t('已保存，但该流程当前无法运行')}：${formatTopologyIssues(topology.errors, 3, t)}`,
          8000,
        )
        // 问题节点画布高亮（2026-10-04）：校验器错误带 node/edge 定位——
        // 复用运行态 failed 样式（红边 + 悬停错误文案），「保存时看见」
        // 从 toast 文本升级为画布上的具名定位。下次运行会覆盖这些标记。
        const problemNodes: Record<string, { status: 'failed'; error?: string }> = {}
        for (const err of topology.errors) {
          if (err.node) problemNodes[err.node] = { status: 'failed', error: err.message }
        }
        if (Object.keys(problemNodes).length > 0) {
          editorRef.current?.applyRunStates(problemNodes)
        }
      } else if (topology.warnings.length > 0) {
        toast.warning(
          `${t('已保存，流程有可疑之处')}：${formatTopologyIssues(topology.warnings, 2, t)}`,
          6000,
        )
      }
    }

    const persist = async (): Promise<void> => {
      // 优先使用外部 onSave，否则走默认持久化逻辑（PUT /api/workflows/:id）
      if (onSave) {
        await onSave(flowData)
        return
      }
      const res = await fetch(`/api/workflows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowData }),
      })
      if (!res.ok) throw new Error(`保存失败: ${res.status}`)
    }

    setSaveState('saving')
    try {
      await persist()
      setSaveState('saved')
      editorRef.current?.markSaved()
      notifyTopologyAfterSave()
      setTimeout(() => setSaveState('idle'), 2000)
    } catch (err) {
      console.error('保存工作流失败:', err)
      setSaveState('error')
      setTimeout(() => setSaveState('idle'), 3000)
    }
  }, [onSave, flowId, toast, t])

  // 自定义 header：flowName + 运行（带节点实时进度徽章）+ 保存
  // ── 未保存守卫（交互安全）：dirty 状态下离开页面 = 静默丢稿 ──
  // 两条路径都拦：①浏览器级（关标签/刷新/外链）beforeunload；
  // ②应用内软导航（Next Link 渲染的 <a>）—— App Router 无官方拦截 API，
  // 用捕获阶段点击拦截：dirty 且目标是站内其他路径 → confirm。
  const dirtyRef = useRef(false)
  const markDirty = useCallback((v: boolean): void => {
    dirtyRef.current = v
  }, [])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    const onClickCapture = (e: MouseEvent): void => {
      if (!dirtyRef.current) return
      if (e.defaultPrevented) return
      const anchor = (e.target as HTMLElement | null)?.closest?.('a')
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#'))
        return
      // 只拦离开当前画布的站内跳转
      try {
        const target = new URL(href, window.location.origin)
        if (target.pathname === window.location.pathname) return
      } catch {
        return
      }
      if (!window.confirm(unsavedMessage())) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClickCapture, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClickCapture, true)
    }
  }, [])

  const renderHeader = useCallback(
    (props: HeaderSlotProps) => {
      // header 每次重渲都带最新 isDirty —— 同步进守卫 ref（含保存成功后的 false）
      dirtyRef.current = props.isDirty
      const saveLabel =
        saveState === 'saving'
          ? t('保存中…')
          : saveState === 'saved'
            ? t('已保存 ✓')
            : saveState === 'error'
              ? t('保存失败')
              : t('保存')
      const saveClass = `canvas-save-btn canvas-save-btn--${saveState}`
      const runLabel =
        runState === 'running'
          ? t('运行中…')
          : runState === 'awaiting'
            ? t('⏸ 待输入')
            : runState === 'done'
              ? t('▶ 再次运行')
              : runState === 'failed'
                ? t('▶ 重试运行')
                : t('▶ 运行')
      return (
        <div className="canvas-header">
          <span className="canvas-header-title" title={flowName}>
            {flowName}
            {props.isDirty && ' *'}
          </span>
          <div className="canvas-header-actions">
            {runSummary ? (
              <span className={`canvas-run-summary canvas-run-summary--${runState}`} role="status">
                {runSummary}
              </span>
            ) : null}
            {latestSpans.length > 0 || runError != null || resumeInfo != null ? (
              <button
                className="canvas-results-btn"
                onClick={() => {
                  // 打开结果面板时收起运行输入面板 —— 两弹窗同锚点互斥
                  //（openRunPanel 的反向，2026-09-22）
                  if (runPanelOpen) setRunPanelOpen(false)
                  setResultsOpen((v) => !v)
                }}
                title={t('查看每个节点的执行状态与产出')}
              >
                {latestSpans.length > 0
                  ? t('运行结果（{n}）', { n: latestSpans.length })
                  : t('运行结果')}
              </button>
            ) : null}
            <button
              className="canvas-save-tpl-btn"
              onClick={() => setSaveTplOpen(true)}
              title={t('把这个流程的当前配置存为可复用模板')}
            >
              {t('另存为模板')}
            </button>
            <button
              className="canvas-save-tpl-btn"
              onClick={() => {
                if (runPanelOpen) setRunPanelOpen(false)
                setVersionsOpen((v) => !v)
              }}
              title={t('查看与回滚历史版本（保存结构变更时自动存档）')}
            >
              {t('版本')}
            </button>
            <button
              className="canvas-save-tpl-btn"
              onClick={() => {
                if (runPanelOpen) setRunPanelOpen(false)
                setContextOpen((v) => !v)
              }}
              title={t('编辑流程上下文（运行时注入 LLM / Agent 节点）')}
            >
              {t('上下文')}
            </button>
            <button
              className="canvas-run-btn"
              onClick={() => {
                if (runPanelOpen) setRunPanelOpen(false)
                else openRunPanel()
              }}
              disabled={runState === 'running' || runState === 'awaiting'}
              title={t('在画布上运行此工作流，节点将实时显示执行进度')}
            >
              {runState === 'running' ? (
                <span className="canvas-run-spin" aria-hidden="true" />
              ) : null}
              {runLabel}
            </button>
            <button
              className={saveClass}
              onClick={() => void props.requestSave()}
              disabled={readOnly || saveState === 'saving'}
            >
              {saveLabel}
            </button>
          </div>

          {/* 运行输入面板：输入作为 {{$start.input}} 传入（LLM/Agent 节点的
              prompt 模板可引用）。点 ▶ 运行先到这里，避免「空跑」。 */}
          {runPanelOpen && runState !== 'running' ? (
            <div
              ref={runPanelRef}
              className="canvas-run-panel"
              role="dialog"
              aria-label={t('运行输入')}
            >
              <div className="canvas-run-panel-title">{t('运行输入')}</div>
              <label className="canvas-run-dir-label">
                {t('项目目录')}
                <span className="canvas-run-dir-row">
                  <select
                    className="canvas-run-dir-select"
                    value={runDirectoryId}
                    onChange={(e) => {
                      setRunDirectoryId(e.target.value)
                      try {
                        window.localStorage.setItem('dagents.canvas.runDir', e.target.value)
                      } catch {
                        /* 忽略 */
                      }
                    }}
                  >
                    {directories.length === 0 ? (
                      <option value="">{t('（无目录 — Agent 在网关目录运行）')}</option>
                    ) : null}
                    {directories.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name || d.path}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="canvas-run-dir-add"
                    onClick={() => void handleAddDirectory()}
                    disabled={addingDir}
                    title={t('添加新的项目目录')}
                  >
                    {addingDir ? '…' : '+'}
                  </button>
                </span>
              </label>
              <div className="canvas-run-dir-hint">
                {t('Agent 将在所选项目目录中读写文件、执行命令')}
              </div>
              {humanSpecs.length > 0 ? (
                <div className="canvas-run-human-answers">
                  <HumanInputAnswerFields
                    specs={humanSpecs}
                    answers={humanAnswers}
                    onAnswer={(nodeId, value) =>
                      setHumanAnswers((prev) => ({ ...prev, [nodeId]: value }))
                    }
                  />
                </div>
              ) : null}
              <textarea
                className="canvas-run-input"
                rows={4}
                autoFocus
                value={runInput}
                placeholder={
                  startInputHint.hint ??
                  t(
                    '输入将作为 {{$start.input}}（等价 {{input}}）传入；节点里可用 {{<节点id>.output}} 或 {{<节点id>.content}} 引用上游产出',
                  )
                }
                onChange={(e) => setRunInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void handleRun(runInput)
                  }
                }}
              />
              {startInputHint.example ? (
                <div className="canvas-run-dir-hint">
                  {t('示例')}：{startInputHint.example}
                </div>
              ) : null}
              <div className="canvas-run-panel-actions">
                <span className="canvas-run-panel-hint">
                  <kbd className="kbd" aria-hidden="true">
                    ⌘⏎
                  </kbd>
                  {t('运行')}
                </span>
                <button
                  type="button"
                  className="canvas-run-panel-cancel"
                  onClick={() => setRunPanelOpen(false)}
                >
                  {t('取消')}
                </button>
                <button
                  type="button"
                  className="canvas-run-panel-go"
                  onClick={() =>
                    void handleRun(runInput, buildHumanInputsState(humanSpecs, humanAnswers))
                  }
                >
                  {t('开始运行')}
                </button>
              </div>
            </div>
          ) : null}

          {firstRunBar ? (
            <div className="canvas-first-run-bar" role="status">
              <span className="canvas-first-run-dot" aria-hidden="true">
                <Icon name="sparkles" style={{ width: 14, height: 14 }} />
              </span>
              <span className="canvas-first-run-text">
                {t('模板已就绪 —— 填入任务输入，跑起来看看效果')}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setFirstRunBar(false)
                  openRunPanel()
                }}
              >
                {t('立即运行')}
              </button>
              <button
                type="button"
                className="canvas-first-run-close"
                aria-label={t('关闭')}
                onClick={() => setFirstRunBar(false)}
              >
                ×
              </button>
            </div>
          ) : null}

          {/* 另存为模板（并入顶栏，2026-08-30） */}
          <SaveFlowTemplateDialog
            open={saveTplOpen}
            onClose={() => setSaveTplOpen(false)}
            flowId={flowId}
            flowName={flowName}
            paramNames={templateParamNames}
          />

          {/* 历史版本（2026-10-04 版本化回滚）：结构保存自动存档，可一键回滚 */}
          <FlowVersionsDialog
            open={versionsOpen}
            onClose={() => setVersionsOpen(false)}
            flowId={flowId}
          />

          {/* 流程上下文（2026-10-04 P2a）：注入 LLM/Agent 节点的常驻上下文 */}
          <FlowContextDialog
            open={contextOpen}
            onClose={() => setContextOpen(false)}
            flowId={flowId}
            initialContext={contextMd}
            onSaved={() => setContextMd((v) => v)}
          />

          {/* 运行结果面板：独立组件（2026-09-22 解耦）—— 展示态内聚，
              执行编排经 props 回调；样式自带 canvas-results.css。
              挂载条件含 runError / 断点续跑 / 挂起应答：零 span 且无 runError
              的失败（如错误被后续 resume 抹掉的旧 run）也要有面板承载
              「从此处继续」等终态动作。 */}
          {resultsOpen &&
          (latestSpans.length > 0 ||
            runError != null ||
            resumeInfo != null ||
            awaitingInfo != null) ? (
            <CanvasResultsPanel
              runState={runState}
              spans={latestSpans}
              runError={runError}
              totalNodes={initialFlow.nodes.length}
              topoOrder={topoOrder}
              runLive={runLive}
              inputSupported={inputSupported}
              terminalDirId={runDirectoryId || spectatedRunDirId || null}
              resumeInfo={resumeInfo}
              awaitingInfo={awaitingInfo}
              onClose={() => setResultsOpen(false)}
              onRerun={handleRerun}
              onResume={handleResume}
              onCancel={cancelRun}
              onSend={sendMessage}
              onSubmitAnswer={submitAnswer}
            />
          ) : null}
        </div>
      )
    },
    [
      flowName,
      saveState,
      readOnly,
      runState,
      runSummary,
      handleRun,
      t,
      runPanelOpen,
      openRunPanel,
      runInput,
      resultsOpen,
      latestSpans,
      runError,
      saveTplOpen,
      versionsOpen,
      contextOpen,
      handleRerun,
      handleResume,
      cancelRun,
      submitAnswer,
      sendMessage,
      resumeInfo,
      awaitingInfo,
      handleAddDirectory,
      firstRunBar,
      templateParamNames,
      topoOrder,
      initialFlow,
      runLive,
      inputSupported,
      runDirectoryId,
      spectatedRunDirId,
    ],
  )

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 520 }}>
      <FlowEditor
        ref={editorRef}
        initialFlow={initialFlow}
        readOnly={readOnly}
        onSaveRequest={() => void handleSave()}
        onLayoutPersist={readOnly ? undefined : persistLayout}
        header={renderHeader}
      />
    </div>
  )
}
