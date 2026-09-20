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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { HumanInputAnswerFields } from '@/components/human-input-answer-fields'
import { extractHumanInputPrompts, buildHumanInputsState } from '@/lib/flow-human-inputs'
import type { FlowData } from '@dagents/workflow'
import { validateFlowTopology } from '@dagents/workflow'
import { useToast } from '@/components/toast'
import { useI18n, readLocalePreference } from '@/i18n'
import { Icon, type IconName } from '@/components/icon'
import { detectRefusal } from '@/lib/refusal-detect'
import { pickDirectory, createDirectory } from '@/lib/directories'
import { fetchRunNodeSpans, type RunNodeSpan } from '@/lib/node-spans'
import { usePolling } from '@/lib/use-polling'
import { SaveFlowTemplateDialog, scanTemplateParamNames } from '@/components/save-flow-template-dialog'
import { FlowEditor, type FlowEditorHandle, type HeaderSlotProps, type NodeRunStatus } from '@/components/flow-canvas'
import { RunTerminal, type TerminalSendResult } from '@/components/run-terminal'
import { spanToTerminalSection, extractOutputText } from '@/lib/run-terminal-format'
import { terminalHrefForDir } from '@/lib/terminal-links'
import { useRunLive } from '@/lib/use-run-live'
import Link from 'next/link'
import { ResultViewer } from '@/components/result-viewer'
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
  /** ?created=1 —— 模板实例化落地：显示一次性首跑引导条。 */
  firstRunHint?: boolean
}

/** span 的 input/output 载荷 → 可读文本（截断），结果面板展示用。 */
function formatSpanPayload(payload: Record<string, unknown> | string | null | undefined, max: number): string {
  if (payload == null) return ''
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1)
  return text.length > max ? text.slice(0, max) + ` …(${text.length})` : text
}

/** 活动流条目类型 —— 与引擎 IStreamActivityKind 对齐（2026-09-06 保真扩展
 *  后新增 tool_result/status/log/error；status/log 不进 activity 环，容错仍认）。 */
type ActivityKind = 'thinking' | 'tool' | 'tool_result' | 'status' | 'log' | 'error' | 'user_input'
const ACTIVITY_KINDS: readonly ActivityKind[] = ['thinking', 'tool', 'tool_result', 'status', 'log', 'error', 'user_input']

/** 节点产出的展示形态：LLM/reply 的 text/content 直出为正文，
 *  其余保持 JSON —— 用户要看的是模型说了什么，不是 JSON 壳。 */
interface SpanDisplay {
  kind: 'text' | 'json'
  text: string
  /** 折叠态摘要（单行截断）。 */
  preview: string
  /** 过程活动流（running 期间的 thinking/工具调用，2026-08-30）——
   *  CLI Agent 干活的大头在思考和调工具而非写正文，没有它旁观端是
   *  「（执行中…）」黑盒。终态 output 无此字段。2026-09-06 起 tool 行
   *  携带 summary（参数/输出单行摘要），全文在终端视图。 */
  activity?: Array<{ kind: ActivityKind; label: string; summary?: string }>
}

/** 从 span.output 提取活动流（容错：形状不符返回空数组）。 */
function spanActivity(
  payload: RunNodeSpan['output'],
): Array<{ kind: ActivityKind; label: string; summary?: string }> {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as Record<string, unknown>).activity
  if (!Array.isArray(raw)) return []
  return raw.flatMap((a): Array<{ kind: ActivityKind; label: string; summary?: string }> => {
    if (!a || typeof a !== 'object') return []
    const e = a as Record<string, unknown>
    const kind = e.kind as ActivityKind
    if (!ACTIVITY_KINDS.includes(kind) || typeof e.label !== 'string') return []
    return [{ kind, label: e.label, ...(typeof e.summary === 'string' ? { summary: e.summary } : {}) }]
  })
}

function spanToDisplay(payload: RunNodeSpan['output']): SpanDisplay | null {
  if (payload == null) return null
  if (typeof payload === 'string') {
    return { kind: 'text', text: payload, preview: oneLine(payload, 90) }
  }
  const obj = payload as Record<string, unknown>
  // 正文提取复用 run-terminal-format 的 extractOutputText 单源实现
  //（text/content 直出 + DirectReply 字符串化 JSON 二次解包），display
  // 特有的活动流/预览/JSON 兜底留在本层。
  const textField = extractOutputText(payload)
  const activity = spanActivity(payload)
  if (textField) {
    return { kind: 'text', text: textField, preview: oneLine(textField, 90), activity }
  }
  // 无正文但有活动流（running 早中期）—— 摘要显示最近的活动行
  if (activity.length > 0) {
    const last = activity[activity.length - 1]!
    return { kind: 'text', text: '', preview: oneLine(activityLine(last), 72), activity }
  }
  const json = JSON.stringify(obj, null, 1)
  return { kind: 'json', text: json, preview: oneLine(json.replace(/[{}"\\]/g, '').trim(), 90) }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** 活动流条目 → 统一 Icon 体系（2026-09-06 设计师裁决：去 emoji 文本标记，
 *  与终端视图 lineIcon 同一语义映射）。 */
function activityIcon(kind: ActivityKind): IconName {
  return kind === 'tool'
    ? 'wrench'
    : kind === 'tool_result'
      ? 'cornerDownRight'
      : kind === 'error'
        ? 'alertTriangle'
        : kind === 'thinking'
          ? 'brain'
          : kind === 'user_input'
            ? 'user'
            : 'point'
}

/** 活动流条目 → 单行文本：tool 行拼参数摘要（旧形状 label 已含参数则原样）。 */
function activityLine(a: { kind: ActivityKind; label: string; summary?: string }): string {
  if ((a.kind === 'tool' || a.kind === 'tool_result') && a.summary) {
    return `${a.label} · ${a.summary}`
  }
  return a.label
}

/** tokens 载荷 → 紧凑徽章（↑输入 ↓输出），无用量返回 null。 */
function tokensBadge(tokens: unknown): string | null {
  if (!tokens || typeof tokens !== 'object') return null
  const u = tokens as { inputTokens?: number; outputTokens?: number }
  if (u.inputTokens == null && u.outputTokens == null) return null
  const fmt = (n?: number): string => (n == null ? '0' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `↑${fmt(u.inputTokens)} ↓${fmt(u.outputTokens)}`
}

/**
 * 拓扑问题清单 → toast 文案片段：展示前 limit 条原文（校验器消息含节点 id），
 * 超出部分折叠为「等 {n} 条」计数。
 */
function formatTopologyIssues(
  issues: ReadonlyArray<{ message: string }>,
  limit: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const shown = issues.slice(0, limit).map((issue) => issue.message).join('；')
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
  const [runState, setRunState] = useState<'idle' | 'running' | 'done' | 'failed' | 'awaiting'>('idle')
  // 断点续跑（2026-09-18）：失败终态拉 checkpoint 判 resumable；awaiting 挂起载荷
  const [resumeInfo, setResumeInfo] = useState<{ runId: string; completedCount: number } | null>(null)
  const [awaitingInfo, setAwaitingInfo] = useState<{ nodeId: string; prompt: string; inputType: string; options: string[] } | null>(null)
  const [answerText, setAnswerText] = useState('')
  const [answerBusy, setAnswerBusy] = useState(false)
  const [runSummary, setRunSummary] = useState<string | null>(null)
  const pollRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearInterval(pollRef.current), [])
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
  // 结果列表跟随（优化点 11）：spans 更新时把 running 节点滚进视口 ——
  // 列表超高后用户不必手动去找「现在跑到哪了」。
  const resultsListRef = useRef<HTMLDivElement | null>(null)

  // 运行输入 + 运行结果：点「▶ 运行」先弹输入面板（作为 {{$start.input}}
  // 传入 —— 没有输入的运行对 LLM/Agent 节点毫无意义）；spans 驱动顶栏的
  // 「运行结果」面板，逐节点展示状态/耗时/产出。
  const [runPanelOpen, setRunPanelOpen] = useState(false)
  // 另存为模板（2026-08-30 从页面级 CanvasTopBar 并入 —— 消灭双标题）
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  // 首跑引导条（模板落地）：显示一次即清 URL 参数，刷新不再打扰
  const [firstRunBar, setFirstRunBar] = useState(firstRunHint)
  useEffect(() => {
    if (!firstRunBar) return
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch { /* 忽略 */ }
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
  const humanSpecs = useMemo(
    () => extractHumanInputPrompts(initialFlow),
    [initialFlow],
  )
  const [humanAnswers, setHumanAnswers] = useState<Record<string, string>>({})
  const persistRunInput = useCallback(
    (input: string): void => {
      try {
        window.localStorage.setItem(`dagents.canvas.runInput.${flowId}`, input)
      } catch { /* 忽略 */ }
    },
    [flowId],
  )
  const [resultsOpen, setResultsOpen] = useState(false)
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
  // 结果列表跟随（优化点 11）：spans 更新时把 running 节点滚进视口 ——
  // 列表超高后用户不必手动去找「现在跑到哪了」。
  useEffect(() => {
    resultsListRef.current
      ?.querySelector('.canvas-result-row.status-running')
      ?.scrollIntoView({ block: 'nearest' })
  }, [latestSpans])
  /** 结果面板里手动折叠过的节点（用户显式收起 → 不再自动展开）。 */
  const manualCollapseRef = useRef<Set<string>>(new Set())
  // 摘要视图元数据底行的展开态（2026-09-06）：输入/原始数据一次只开一个
  const [ioOpen, setIoOpen] = useState<{ id: string; kind: 'input' | 'raw' } | null>(null)
  // 结果面板视图（2026-09-06 终端视图 PRD）：摘要（默认，策展卡片）/
  // 终端（保真回放 —— span-writer events 全量过程日志的单流渲染）。
  // 用户裁决：切换式而非替换默认；记忆在 localStorage。
  const [resultView, setResultView] = useState<'summary' | 'terminal'>(() => {
    try {
      return window.localStorage.getItem('dagents.canvas.resultView') === 'terminal'
        ? 'terminal'
        : 'summary'
    } catch {
      return 'summary'
    }
  })
  const switchResultView = useCallback((v: 'summary' | 'terminal'): void => {
    setResultView(v)
    try {
      window.localStorage.setItem('dagents.canvas.resultView', v)
    } catch { /* 忽略 */ }
  }, [])
  // 项目目录：Agent/LLM 节点的 CLI 在这个目录里干活。选择记忆在
  // localStorage（dagents.canvas.runDir），跨刷新保留。
  const [directories, setDirectories] = useState<Array<{ id: string; path: string; name?: string }>>([])
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
        } catch { /* 无 localStorage 则默认选第一个 */ }
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
      } catch { /* 忽略 */ }
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
    ): Promise<{ runStatus: string | null; hasRunning: boolean; hasSpans: boolean; spans: RunNodeSpan[] }> => {
      const r = await fetchRunNodeSpans(runId)
      // !ok（含 404 = 尚未落库）→ 下轮再试；轮询失败静默，最终状态以
      // run POST 的返回为准
      if (!r.ok) return { runStatus: null, hasRunning: false, hasSpans: false, spans: [] }
      applySpans(r.spans)
      setLatestSpans(r.spans)
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
  const watchTick = useCallback(
    async (): Promise<boolean> => {
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
        toast.error(t('节点 {node} 失败 — 展开运行结果查看详情', { node: failed.nodeLabel || failed.nodeId || '?' }), 8000)
        return false
      }
      return true
    },
    [watch, fetchSpans, toast, t],
  )
  // watch 置位即轮询（restartKey=runId：连跑第二次也立即重入）
  usePolling(watch ? watchTick : null, { intervalMs: 700, visibilityPause: true, restartKey: watch?.runId })

  const handleRun = useCallback(
    async (input: string, humanInputs?: Record<string, string>): Promise<void> => {
      if (runState === 'running') return
      // 断点续跑模式（2026-09-18）：resumeInfo 在场 → 提交到 resume 端点
      const isResume = resumeInfo != null
      setRunPanelOpen(false)
      setResultsOpen(true)
      setLatestSpans([])
      manualCollapseRef.current.clear()
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
        const res = await fetch(
          isResume
            ? `/api/workflows/runs/${encodeURIComponent(resumeInfo.runId)}/resume`
            : `/api/workflows/${encodeURIComponent(flowId)}/run?async=1`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(!isResume ? { 'x-run-id': clientRunId } : {}) },
            body: JSON.stringify({
          ...(input.trim() ? { input: input.trim() } : {}),
          ...(runDirectoryId ? { directoryId: runDirectoryId } : {}),
          // HumanInput 预供答案（2026-09-18）：与列表运行面板同契约
          ...(humanInputs ? { humanInputs } : {}),
        }),
          },
        )
        const json = (await res.json().catch(() => null)) as {
          success?: boolean
          error?: string
          data?: { runId?: string }
        } | null
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
        if (isResume) {
          setResumeInfo(null)
          toast.info(t('已从断点继续 —— 跳过 {n} 个已完成节点', { n: String(resumeInfo.completedCount) }), 5000)
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
        const res = await fetch(
          `/api/workflows/runs/${encodeURIComponent(activeRunId)}/message`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nodeId, text }),
          },
        )
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
          awaiting?: { nodeId: string; prompt: string; inputType: string; options?: unknown[] } | null
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
          options: (json.data.awaiting.options ?? []).filter((o): o is string => typeof o === 'string'),
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

  /** 从此处继续（§6.6）：走 resume 端点 —— 新 runId，种子跳过已完成节点。 */
  const handleResume = useCallback((): void => {
    if (!resumeInfo || runState === 'running') return
    setRunPanelOpen(true)
  }, [resumeInfo, runState])

  /** 应答提交（P2）：同 runId 原地续跑，回到 running 继续旁观。 */
  const submitAnswer = useCallback(async (): Promise<void> => {
    if (!activeRunId || !answerText.trim() || answerBusy) return
    setAnswerBusy(true)
    try {
      const res = await fetch(`/api/workflows/runs/${encodeURIComponent(activeRunId)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: answerText.trim() }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) {
        toast.error(json.error ?? t('提交答案失败'), 6000)
        return
      }
      setAnswerText('')
      setAwaitingInfo(null)
      setRunState('running')
      manualWatchRef.current = true
      setWatch({ runId: activeRunId, startedAt: Date.now() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), 6000)
    } finally {
      setAnswerBusy(false)
    }
  }, [activeRunId, answerText, answerBusy, toast, t])

  /** stdin 行结束态的「重跑」入口（就近原则）：打开运行输入面板 ——
   *  输入已在面板初始化时从记忆预填（persistRunInput），⬆ 语义。 */
  const handleRerun = useCallback((): void => {
    setRunPanelOpen(true)
  }, [])

  // ── 旁观模式（canvas?run=<runId>）：自动轮询并点亮节点/连线 ──
  // 典型来源：chat @flow 触发的运行（chat 面板「在画布中查看」链接）。
  // 终止条件：runs 行的 runStatus（completed/failed/cancelled）；没有
  // runs 行时退化为启发式 —— 连续 8 轮无 running span 且已有 span 视为结束。
  useEffect(() => {
    // TODO(轮询收敛,2026-09-17): 本轮未迁移（画布直跑 watchLoop 已迁 usePolling）—— 旁观轮询同款可换 @/lib/use-polling。
    if (!watchRunId) return
    let stablePolls = 0
    let cancelled = false
    setActiveRunId(watchRunId)
    setRunState('running')
    setRunSummary(null)
    // 旁观即看流：结果面板默认打开 + 清掉手动收起记忆 —— 否则徽章在亮、
    // 面板却关着，流式 live tail 默认不可见（2026-08-30 修复）。
    setResultsOpen(true)
    manualCollapseRef.current.clear()
    editorRef.current?.clearRunState()
    const tick = async (): Promise<void> => {
      // 画布直跑已接管轮询（watchTick 700ms 循环）—— 旁观循环退位
      if (manualWatchRef.current) {
        window.clearInterval(pollRef.current)
        return
      }
      const { runStatus, hasRunning, hasSpans } = await fetchSpans(watchRunId)
      if (cancelled) return
      // 持久挂起（2026-09-19 行为测试逮出）：深链旁观此前把 awaiting_input
      // 当「运行中」无限转圈 —— 没有任何应答入口，用户只能等超时。与
      // watchTick 同款：亮应答面板、继续轮询（应答后 submitAnswer 会把
      // 接力棒交给 watchTick 收尾）。
      if (runStatus === 'awaiting_input') {
        setRunState('awaiting')
        void refreshCheckpointState(watchRunId)
        return
      }
      if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
        window.clearInterval(pollRef.current)
        summarizeWatch(runStatus)
        return
      }
      // 启发式（无 runs 行的旧运行 / 查询失败）：已有 span、无 running、
      // 且连续多轮无进展才收尾 —— 有节点在跑（hasRunning）绝不误判。
      if (!runStatus && hasSpans && !hasRunning) {
        stablePolls += 1
        if (stablePolls >= 8) {
          window.clearInterval(pollRef.current)
          summarizeWatch(null)
        }
      } else {
        stablePolls = 0
      }
    }
    void tick()
    pollRef.current = window.setInterval(() => void tick(), 900)
    return () => {
      cancelled = true
      window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchRunId])

  // 布局自动保存（2026-09-06 画布优化）：拖拽停/视口停后 FlowEditor debounce
  // 调用 —— 静默 merge 到 flow_data（只动坐标与视口）。失败不打扰：布局
  // 无语义价值，下次拖动自然重试；配置编辑仍走显式「保存」管线。
  const persistLayout = useCallback(
    (layout: { positions: Record<string, { x: number; y: number }>; viewport: { x: number; y: number; zoom: number } }): void => {
      void fetch(`/api/workflows/${encodeURIComponent(flowId)}/layout`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(layout),
      }).catch(() => {})
    },
    [flowId],
  )

  const handleSave = useCallback(async (): Promise<void> => {    const flowData = editorRef.current?.getDocument()
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
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return
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
        <div className='canvas-header'>
          <span className='canvas-header-title' title={flowName}>
            {flowName}
            {props.isDirty && ' *'}
          </span>
          <div className='canvas-header-actions'>
            {runSummary ? (
              <span
                className={`canvas-run-summary canvas-run-summary--${runState}`}
                role='status'
              >
                {runSummary}
              </span>
            ) : null}
            {latestSpans.length > 0 ? (
              <button
                className='canvas-results-btn'
                onClick={() => setResultsOpen((v) => !v)}
                title={t('查看每个节点的执行状态与产出')}
              >
                {t('运行结果（{n}）', { n: latestSpans.length })}
              </button>
            ) : null}
            <button
              className='canvas-save-tpl-btn'
              onClick={() => setSaveTplOpen(true)}
              title={t('把这个流程的当前配置存为可复用模板')}
            >
              {t('另存为模板')}
            </button>
            <button
              className='canvas-run-btn'
              onClick={() => setRunPanelOpen((v) => !v)}
              disabled={runState === 'running' || runState === 'awaiting'}
              title={t('在画布上运行此工作流，节点将实时显示执行进度')}
            >
              {runState === 'running' ? <span className='canvas-run-spin' aria-hidden='true' /> : null}
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
            <div ref={runPanelRef} className='canvas-run-panel' role='dialog' aria-label={t('运行输入')}>
              <div className='canvas-run-panel-title'>{t('运行输入')}</div>
              <label className='canvas-run-dir-label'>
                {t('项目目录')}
                <span className='canvas-run-dir-row'>
                <select
                  className='canvas-run-dir-select'
                  value={runDirectoryId}
                  onChange={(e) => {
                    setRunDirectoryId(e.target.value)
                    try { window.localStorage.setItem('dagents.canvas.runDir', e.target.value) } catch { /* 忽略 */ }
                  }}
                >
                  {directories.length === 0 ? <option value=''>{t('（无目录 — Agent 在网关目录运行）')}</option> : null}
                  {directories.map((d) => (
                    <option key={d.id} value={d.id}>{d.name || d.path}</option>
                  ))}
                </select>
                <button
                  type='button'
                  className='canvas-run-dir-add'
                  onClick={() => void handleAddDirectory()}
                  disabled={addingDir}
                  title={t('添加新的项目目录')}
                >
                  {addingDir ? '…' : '+'}
                </button>
                </span>
              </label>
              <div className='canvas-run-dir-hint'>{t('Agent 将在所选项目目录中读写文件、执行命令')}</div>
              {humanSpecs.length > 0 ? (
                <div className='canvas-run-human-answers'>
                  <HumanInputAnswerFields
                    specs={humanSpecs}
                    answers={humanAnswers}
                    onAnswer={(nodeId, value) => setHumanAnswers((prev) => ({ ...prev, [nodeId]: value }))}
                  />
                </div>
              ) : null}
              <textarea
                className='canvas-run-input'
                rows={4}
                autoFocus
                value={runInput}
                placeholder={startInputHint.hint ?? t('输入将作为 {{$start.input}}（等价 {{input}}）传入；节点里可用 {{<节点id>.output}} 或 {{<节点id>.content}} 引用上游产出')}
                onChange={(e) => setRunInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void handleRun(runInput)
                  }
                }}
              />
              {startInputHint.example ? (
                <div className='canvas-run-dir-hint'>{t('示例')}：{startInputHint.example}</div>
              ) : null}
              <div className='canvas-run-panel-actions'>
                <span className='canvas-run-panel-hint'>
                  <kbd className='kbd' aria-hidden='true'>⌘⏎</kbd>
                  {t('运行')}
                </span>
                <button type='button' className='canvas-run-panel-cancel' onClick={() => setRunPanelOpen(false)}>
                  {t('取消')}
                </button>
                <button type='button' className='canvas-run-panel-go' onClick={() => void handleRun(runInput, buildHumanInputsState(humanSpecs, humanAnswers))}>
                  {t('开始运行')}
                </button>
              </div>
            </div>
          ) : null}

          {firstRunBar ? (
            <div className='canvas-first-run-bar' role='status'>
              <span className='canvas-first-run-dot' aria-hidden='true'><Icon name='sparkles' style={{ width: 14, height: 14 }} /></span>
              <span className='canvas-first-run-text'>
                {t('模板已就绪 —— 填入任务输入，跑起来看看效果')}
              </span>
              <button
                type='button'
                className='btn btn-primary btn-sm'
                onClick={() => {
                  setFirstRunBar(false)
                  setRunPanelOpen(true)
                }}
              >
                {t('立即运行')}
              </button>
              <button
                type='button'
                className='canvas-first-run-close'
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

          {/* 运行结果面板：逐节点状态/耗时/产出（spans 实时刷新）。
              摘要 = 策展卡片（默认）；终端 = 保真回放（单流分段，全文直出）。 */}
          {resultsOpen && latestSpans.length > 0 ? (
            <div className='canvas-results-panel' role='region' aria-label={t('运行结果')}>
              {/* 持久挂起应答（P2 §6.6）：prompt + 输入/选择 + 提交 →
                  同 runId 原地续跑（聊天里直接回复也可）。 */}
              {runState === 'awaiting' && awaitingInfo ? (
                <div className='canvas-awaiting-bar'>
                  <span className='canvas-awaiting-prompt'>{awaitingInfo.prompt}</span>
                  {awaitingInfo.options.length > 0 ? (
                    <select
                      className='input canvas-awaiting-input'
                      value={answerText}
                      onChange={(e) => setAnswerText(e.target.value)}
                      aria-label={awaitingInfo.prompt}
                    >
                      <option value=''>{t('（待选择）')}</option>
                      {awaitingInfo.options.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className='input canvas-awaiting-input'
                      type='text'
                      value={answerText}
                      placeholder={t('输入答案后继续')}
                      onChange={(e) => setAnswerText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitAnswer()
                      }}
                    />
                  )}
                  <button
                    type='button'
                    className='btn btn-primary btn-compact'
                    onClick={() => void submitAnswer()}
                    disabled={answerBusy || !answerText.trim()}
                  >
                    {t('继续运行')}
                  </button>
                </div>
              ) : null}
              <div className='canvas-run-panel-title'>
                <span className='canvas-results-title-row'>
                  {t('运行结果')}
                  {/* 断点续跑（2026-09-18 §6.6）：失败 + checkpoint resumable →
                      从此处继续（提交走 resume 端点，种子跳过已完成节点）。 */}
                  {runState === 'failed' && resumeInfo ? (
                    <button
                      type='button'
                      className='canvas-results-rerun canvas-results-resume'
                      onClick={handleResume}
                      title={t('跳过 {n} 个已完成节点，从失败处继续', { n: String(resumeInfo.completedCount) })}
                    >
                      {t('从此处继续')}（{t('跳过 {n} 个节点', { n: String(resumeInfo.completedCount) })}）
                    </button>
                  ) : null}
                  {/* 终态「重跑」直达（2026-09-18 PM）：失败现场就近挽回 ——
                      与终端 stdin 行同款 handleRerun（打开输入面板，⬆ 预填）。 */}
                  {runState === 'failed' || runState === 'done' || runState === 'idle' ? (
                    <button
                      type='button'
                      className='canvas-results-rerun'
                      onClick={handleRerun}
                      title={t('用相同输入重跑（可修改后提交）')}
                    >
                      {t('重跑')}
                    </button>
                  ) : null}
                  {/* 双锚点 P1（2026-09-19）：失败 + 目录锚 → 深链终端排查；
                      本会话发起用输入面板目录，旁观 run 用 node-spans 回传锚；
                      解析不到目录不渲染（不回落主目录）。 */}
                  {runState === 'failed' && (runDirectoryId || spectatedRunDirId) ? (
                    <Link
                      href={terminalHrefForDir((runDirectoryId || spectatedRunDirId) as string)}
                      className='canvas-results-rerun'
                    >
                      {t('在项目目录打开终端')}
                    </Link>
                  ) : null}
                  <span className='canvas-results-view' role='tablist' aria-label={t('结果视图')}>
                  <button
                    type='button'
                    role='tab'
                    aria-selected={resultView === 'summary'}
                    className={`canvas-results-view-btn${resultView === 'summary' ? ' active' : ''}`}
                    onClick={() => switchResultView('summary')}
                  >
                    {t('摘要')}
                  </button>
                  <button
                    type='button'
                    role='tab'
                    aria-selected={resultView === 'terminal'}
                    className={`canvas-results-view-btn${resultView === 'terminal' ? ' active' : ''}`}
                    onClick={() => switchResultView('terminal')}
                    title={t('以终端形式查看完整过程（thinking/工具调用/输出全文）')}
                  >
                    {t('终端')}
                  </button>
                  </span>
                </span>
                <button
                  type='button'
                  className='canvas-results-close'
                  aria-label={t('关闭')}
                  onClick={() => setResultsOpen(false)}
                >
                  ×
                </button>
              </div>
              {runState === 'running' ? (
                /* 状态行结构化（2026-09-19 走查优化点 1-3）：长句改为指标行
                   「运行中 · n/m · 失败 k · ⏱ 12.4s」+ 迷你进度条 —— 总耗时
                   此前完全缺失，是盯面板用户最想知道的数字；正在执行的节点
                   名由列表中 running 行的高亮承担，不再重复此处。 */
                <div className='canvas-results-live'>
                  <div className='canvas-results-live-line'>
                    <span className='canvas-results-live-state'>{t('运行中')}</span>
                    <span className='canvas-results-live-sep'>·</span>
                    {(() => {
                      const doneN = latestSpans.filter(
                        (sp) => sp.status === 'done' || sp.status === 'completed',
                      ).length
                      const failedN = latestSpans.filter((sp) => sp.status === 'failed').length
                      // 分母 = 流程总节点数（initialFlow），不是已出现的 span 数 ——
                      // 早期只有 1-2 个 span，用 span 数会把 5 节点流程显示成「1/2」，
                      // 跑着跑着分母再变大，非常误导。
                      const total = initialFlow.nodes.length
                      const startMs = latestSpans.reduce<number | null>((acc, sp) => {
                        const tt = sp.startedAt ? Date.parse(sp.startedAt) : NaN
                        return Number.isNaN(tt) ? acc : acc == null ? tt : Math.min(acc, tt)
                      }, null)
                      const elapsedS =
                        startMs != null ? ((Date.now() - startMs) / 1000).toFixed(1) : null
                      const donePct = total > 0 ? (doneN / total) * 100 : 0
                      const failPct = total > 0 ? (failedN / total) * 100 : 0
                      return (
                        <>
                          <span className='tnum'>
                            {doneN}/{total}
                          </span>
                          {failedN > 0 ? (
                            <>
                              <span className='canvas-results-live-sep'>·</span>
                              <span className='canvas-results-live-fail tnum'>
                                {t('失败')} {failedN}
                              </span>
                            </>
                          ) : null}
                          {elapsedS && startMs != null ? (
                            <>
                              <span className='canvas-results-live-sep'>·</span>
                              <LiveElapsed
                                startedAt={new Date(startMs).toISOString()}
                                className='canvas-results-live-elapsed tnum'
                                prefix='⏱ '
                              />
                            </>
                          ) : null}
                          <div className='canvas-results-live-bar'>
                            <div
                              className='canvas-results-live-bar-done'
                              style={{ width: `${donePct}%` }}
                            />
                            <div
                              className='canvas-results-live-bar-fail'
                              style={{ width: `${failPct}%` }}
                            />
                          </div>
                        </>
                      )
                    })()}
                  </div>
                </div>
              ) : null}
              {resultView === 'terminal' ? (
                /* 终端视图：全量过程日志单流分段（拓扑序同摘要视图），保真回放。
                    stdin 行（可操作终端 2026-09-08）：运行中可对 running 节点插话，
                    结束后原位变重跑入口。 */
                (() => {
                  // live 优先（执行序 + 逐帧）；回退 = node-spans 快照（拓扑序）。
                  // live 内容仅在直播/干净收口时采用 —— connecting/unavailable
                  // 保持既有渲染，零回归。
                  const liveActive =
                    (runLive.mode === 'live' || runLive.mode === 'closed') &&
                    runLive.sections.length > 0
                  const sections = liveActive
                    ? runLive.sections
                    : [...latestSpans]
                        .sort(
                          (a, b) =>
                            (topoOrder.get(a.nodeId) ?? 1e9) - (topoOrder.get(b.nodeId) ?? 1e9),
                        )
                        .map(spanToTerminalSection)
                  const activeNodes = liveActive
                    ? runLive.sections
                        .filter((s) => s.status === 'running')
                        .map((s) => ({ id: s.id, label: s.title || s.id }))
                    : latestSpans
                        .filter((sp) => sp.status === 'running')
                        .map((sp) => ({ id: sp.nodeId, label: sp.nodeLabel || sp.nodeId || '?' }))
                  return (
                    <RunTerminal
                      sections={sections}
                      running={runState === 'running'}
                      inputSupported={inputSupported}
                      activeNodes={activeNodes}
                      onSend={sendMessage}
                      onRerun={handleRerun}
                    />
                  )
                })()
              ) : (
              <div className='canvas-results-list' ref={resultsListRef}>
                {/* FR-15（PRD 决议 D9）：行序按流程拓扑（initialFlow 节点
                    顺序），不再按 span 返回序（完成时间倒序会把 start 排最后，
                    违背阅读直觉）；未知节点（理论不该有）排在末尾 */}
                {(() => {
                  return [...latestSpans]
                    .sort(
                      (a, b) =>
                        (topoOrder.get(a.nodeId) ?? 1e9) - (topoOrder.get(b.nodeId) ?? 1e9),
                    )
                    .map((sp) => {
                      const id = sp.nodeId || '?'
                      const displayForWarn = spanToDisplay(sp.output)
                      let st = sp.status ?? ''
                      // 诚实标注：done 但内容是权限拒绝 → 黄警（同聊天执行卡）
                      if (st === 'done' && detectRefusal(displayForWarn?.text)) st = 'warn'
                      const terminal = st === 'done' || st === 'completed' || st === 'failed' || st === 'warn'
                      // 运行中：已完成/已有增量产出的节点自动展开（用户手动收起的除外）；失败必展开
                      const autoOpen =
                        runState === 'running' &&
                        !manualCollapseRef.current.has(id) &&
                        (terminal || (st === 'running' && displayForWarn?.preview != null))
                      const display = spanToDisplay(sp.output)
                      const badge = tokensBadge(sp.tokens)
                      return (
                        <details
                          key={id}
                          className={`canvas-result-row status-${st}`}
                          open={st === 'failed' || st === 'warn' || autoOpen || undefined}
                          onToggle={(e) => {
                            // 手动收起 → 记住，不再自动展开
                            if (!(e.target as HTMLDetailsElement).open) manualCollapseRef.current.add(id)
                          }}
                        >
                          <summary>
                            <span className={`canvas-result-dot dot-${st}`} aria-hidden='true' />
                            <span className='canvas-result-label'>{sp.nodeLabel || id}</span>
                            {display && display.preview && st !== 'running' ? (
                              <span className='canvas-result-preview' title={display.preview}>{display.preview}</span>
                            ) : st === 'running' && display?.preview ? (
                              // live tail 单行预览（流式落库的 partial）
                              <span className='canvas-result-preview canvas-result-preview-live' title={display.preview}>
                                {display.preview}
                              </span>
                            ) : null}
                            {badge ? (
                              <span className='canvas-result-tokens' title={t('token 用量（输入/输出）')}>{badge}</span>
                            ) : null}
                            <span className='canvas-result-meta'>
                              {st === 'warn' ? (
                                <>⚠ {t('疑似权限受限')}{sp.durationMs != null ? ` · ${(sp.durationMs / 1000).toFixed(1)}s` : ''}</>
                              ) : st === 'running' ? (
                                // 实时已耗时（优化点 2）：LiveElapsed 自带秒级心跳，逐秒跳动
                                <>{t('运行中')} · <LiveElapsed startedAt={sp.startedAt} /></>
                              ) : st === 'failed' ? (
                                <>{t('失败')}{sp.durationMs != null ? ` · ${(sp.durationMs / 1000).toFixed(1)}s` : ''}</>
                              ) : st === 'done' || st === 'completed' ? (
                                // done 去冗词（优化点 9）：状态由点色表达，meta 只留时长
                                sp.durationMs != null ? `${(sp.durationMs / 1000).toFixed(1)}s` : t('完成')
                              ) : (
                                st
                              )}
                            </span>
                          </summary>
                          <div className='canvas-result-body'>
                            {sp.error ? <div className='canvas-result-error'>{sp.error}</div> : null}
                            {display?.activity && display.activity.length > 0 ? (
                              <div className='canvas-result-activity' aria-label={t('执行活动')}>
                                {display.activity.slice(-6).map((a, idx) => (
                                  <div key={idx} className={`canvas-act act-${a.kind}`}>
                                    <span className='canvas-act-icon'><Icon name={activityIcon(a.kind)} style={{ width: 11, height: 11 }} /></span>
                                    <span className='canvas-act-label' title={activityLine(a)}>{activityLine(a)}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {display ? (
                              display.kind === 'text' ? (
                                <ResultViewer title={sp.nodeLabel || id} text={display.text}>
                                  <div className={`canvas-result-text${st === 'running' ? ' streaming' : ''}`}>
                                    {display.text}
                                  </div>
                                </ResultViewer>
                              ) : (
                                <ResultViewer
                                  title={`${sp.nodeLabel || id} · ${t('产出')}`}
                                  text={sp.output ? JSON.stringify(sp.output, null, 2) : ''}
                                  mono
                                >
                                  <div className='canvas-result-io'>
                                    <div className='canvas-result-io-label'>{t('产出')}</div>
                                    <pre>{formatSpanPayload(sp.output, 900)}</pre>
                                  </div>
                                </ResultViewer>
                              )
                            ) : (
                              <div className='canvas-result-io muted' style={{ fontSize: 11 }}>
                                {st === 'running' ? t('（执行中…）') : t('（无产出）')}
                              </div>
                            )}
                            {/* 元数据底行（2026-09-06 PM/设计师裁决）：输入/原始数据
                                统一收进卡片底部的安静小行 —— 成品正文优先，调试入口垫底
                                （此前一个在正文上方一个在下方包夹内容，且原始数据是正文
                                的 JSON 复读）；一次只开一个，保真回放走「终端」视图 */}
                            {(() => {
                              const hasInput = sp.input != null && Object.keys(sp.input as object).length > 0
                              const hasRaw = display?.kind === 'text'
                              if (!hasInput && !hasRaw) return null
                              const cur = ioOpen?.id === id ? ioOpen.kind : null
                              return (
                                <div className='canvas-result-meta-row'>
                                  <div className='canvas-result-meta-links'>
                                    {hasInput ? (
                                      <button
                                        type='button'
                                        className={`canvas-result-meta-link${cur === 'input' ? ' active' : ''}`}
                                        aria-expanded={cur === 'input'}
                                        onClick={() => setIoOpen(cur === 'input' ? null : { id, kind: 'input' })}
                                      >
                                        {t('输入')}
                                      </button>
                                    ) : null}
                                    {hasRaw ? (
                                      <button
                                        type='button'
                                        className={`canvas-result-meta-link${cur === 'raw' ? ' active' : ''}`}
                                        aria-expanded={cur === 'raw'}
                                        onClick={() => setIoOpen(cur === 'raw' ? null : { id, kind: 'raw' })}
                                      >
                                        {t('原始数据')}
                                      </button>
                                    ) : null}
                                  </div>
                                  {cur === 'input' ? (
                                    <ResultViewer
                                      title={`${sp.nodeLabel || id} · ${t('输入')}`}
                                      text={sp.input ? JSON.stringify(sp.input, null, 2) : ''}
                                      mono
                                    >
                                      <pre className='canvas-result-meta-pre'>{formatSpanPayload(sp.input, 500)}</pre>
                                    </ResultViewer>
                                  ) : null}
                                  {cur === 'raw' ? (
                                    <ResultViewer
                                      title={`${sp.nodeLabel || id} · ${t('原始数据')}`}
                                      text={sp.output ? JSON.stringify(sp.output, null, 2) : ''}
                                      mono
                                    >
                                      <pre className='canvas-result-meta-pre'>{formatSpanPayload(sp.output, 900)}</pre>
                                    </ResultViewer>
                                  ) : null}
                                </div>
                              )
                            })()}
                          </div>
                        </details>
                      )
                    })
                })()
                }
              </div>
              )}
            </div>
          ) : null}
        </div>
      )
    },
    [flowName, saveState, readOnly, runState, runSummary, handleRun, t, runPanelOpen, runInput, resultsOpen, latestSpans, saveTplOpen, handleRerun, handleResume, submitAnswer, resumeInfo, awaitingInfo, answerText, answerBusy, handleAddDirectory, firstRunBar, templateParamNames, topoOrder, initialFlow, resultView, switchResultView, ioOpen],
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

/** 实时已耗时（走查优化点 1/2 的载体）：自带秒级心跳的叶子组件。
 *  计时状态局部于本组件 —— 若把心跳放页面级，整棵画布树（React Flow
 *  图 + 面板）会被拖进每秒重渲（架构自审 2026-09-20）。 */
function LiveElapsed({
  startedAt,
  className,
  prefix = '',
}: {
  startedAt: string | null
  className?: string
  prefix?: string
}): React.ReactElement {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const t = setInterval(() => tick(), 1000)
    return () => clearInterval(t)
  }, [])
  const t0 = startedAt ? Date.parse(startedAt) : NaN
  const s = Number.isNaN(t0) ? '0.0' : Math.max(0, (Date.now() - t0) / 1000).toFixed(1)
  return (
    <span className={className}>
      {prefix}
      {s}s
    </span>
  )
}
