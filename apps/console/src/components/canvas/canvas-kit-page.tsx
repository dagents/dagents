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
import type { FlowData } from '@dagents/workflow'
import { validateFlowTopology } from '@dagents/workflow'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import { Icon, type IconName } from '@/components/icon'
import { detectRefusal } from '@/lib/refusal-detect'
import { pickDirectory, createDirectory } from '@/lib/directories'
import { SaveFlowTemplateDialog, scanTemplateParamNames } from '@/components/save-flow-template-dialog'
import { FlowEditor, type FlowEditorHandle, type HeaderSlotProps, type NodeRunStatus } from '@/components/flow-canvas'
import { RunTerminal, type TerminalSendResult } from '@/components/run-terminal'
import { spanToTerminalSection } from '@/lib/run-terminal-format'
import { ResultViewer } from '@/components/result-viewer'
// .kbd（统一 kbd 键帽，shortcuts.css 单一定义、GL03/GL06 全站共用）
import '@/styles/shortcuts.css'
import '@/styles/flow-canvas.css'
import './canvas.css'

/** 未保存守卫的 confirm 文案（confirm 是原生弹窗，走不了 React i18n ——
 *  读当前 locale 给双语；默认中文）。 */
function unsavedMessage(): string {
  try {
    return window.localStorage.getItem('dagents.locale') === 'en'
      ? 'Canvas has unsaved changes. Leave anyway?'
      : '画布有未保存的修改，确定离开吗？'
  } catch {
    return '画布有未保存的修改，确定离开吗？'
  }
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

/** 运行结果面板的单节点行（gateway node-spans 读端点的 camelCase 形状）。 */
interface CanvasSpanRow {
  nodeId?: string
  node_id?: string
  nodeLabel?: string | null
  status?: string
  error?: string | null
  durationMs?: number | null
  tokens?: unknown
  startedAt?: string | null
  input?: Record<string, unknown> | string | null
  output?: Record<string, unknown> | string | null
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
  payload: CanvasSpanRow['output'],
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

function spanToDisplay(payload: CanvasSpanRow['output']): SpanDisplay | null {
  if (payload == null) return null
  if (typeof payload === 'string') {
    return { kind: 'text', text: payload, preview: oneLine(payload, 90) }
  }
  const obj = payload as Record<string, unknown>
  let textField = typeof obj.text === 'string' && obj.text ? obj.text
    : typeof obj.content === 'string' && obj.content ? obj.content
    : null
  // DirectReply 的 content 常是「字符串化的上游 JSON」—— 二次解包取 text
  if (textField && textField.trimStart().startsWith('{')) {
    try {
      const inner = JSON.parse(textField) as Record<string, unknown>
      if (typeof inner.text === 'string' && inner.text) textField = inner.text
      else if (typeof inner.content === 'string' && inner.content) textField = inner.content
    } catch { /* 保持原样 */ }
  }
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
  const [runState, setRunState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [runSummary, setRunSummary] = useState<string | null>(null)
  const pollRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearInterval(pollRef.current), [])

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
  const [latestSpans, setLatestSpans] = useState<CanvasSpanRow[]>([])
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

  const applySpans = useCallback((spans: ReadonlyArray<CanvasSpanRow>): void => {
    const nodeStates: Record<string, { status: NodeRunStatus; error?: string }> = {}
    for (const s of spans) {
      const nodeId = s.node_id ?? s.nodeId
      const status = s.status ? SPAN_STATUS_MAP[s.status] : undefined
      if (nodeId && status) nodeStates[nodeId] = { status, error: s.error ?? undefined }
    }
    editorRef.current?.applyRunStates(nodeStates)
  }, [])

  /** 轮询一次 spans + run 终态。返回 runStatus（无 runs 行时为 null）及
   *  span 概况 —— 旁观模式的启发式收尾需要区分「执行中」和「查不到」。 */
  const fetchSpans = useCallback(
    async (
      runId: string,
    ): Promise<{ runStatus: string | null; hasRunning: boolean; hasSpans: boolean }> => {
      try {
        const res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/node-spans`, { cache: 'no-store' })
        if (!res.ok) return { runStatus: null, hasRunning: false, hasSpans: false } // 404 = 尚未落库，下轮再试
        const body = (await res.json()) as {
          data?: {
            runStatus?: string | null
            inputSupported?: boolean
            spans?: CanvasSpanRow[]
          }
        }
        const spans = body?.data?.spans ?? []
        applySpans(spans)
        setLatestSpans(spans)
        if (body?.data?.inputSupported != null) setInputSupported(body.data.inputSupported)
        return {
          runStatus: body?.data?.runStatus ?? null,
          hasRunning: spans.some((sp) => (sp.status ?? '') === 'running'),
          hasSpans: spans.length > 0,
        }
      } catch {
        // 轮询失败静默 —— 最终状态以 run POST 的返回为准
        return { runStatus: null, hasRunning: false, hasSpans: false }
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

  /** 统一的运行旁观循环：轮询 spans/runStatus 直到终态；任一 span 失败
   *  立即置失败（不等 POST/runs 行）—— 引擎失败后可能还有长收尾。 */
  const watchLoop = useCallback(
    (runId: string, startedAt: number): void => {
      window.clearInterval(pollRef.current)
      const tick = async (): Promise<void> => {
        const { runStatus } = await fetchSpans(runId)
        if (runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled') {
          window.clearInterval(pollRef.current)
          await fetchSpans(runId) // 收尾定格：终态徽章齐全
          const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
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
          return
        }
        // 失败即时检测：span 已 failed 但 runs 行还没落 —— 立即置失败，
        // 不再让按钮转圈（此前用户会看到「失败」却还在「运行中」）。
        setLatestSpans((prev) => {
          const failed = prev.find((sp) => sp.status === 'failed')
          if (failed) {
            window.clearInterval(pollRef.current)
            setRunState('failed')
            setRunSummary(
              t('运行失败 · {node}', { node: failed.nodeLabel || failed.nodeId || '?' }) +
                (failed.error ? `：${String(failed.error).slice(0, 60)}` : ''),
            )
            toast.error(t('节点 {node} 失败 — 展开运行结果查看详情', { node: failed.nodeLabel || failed.nodeId || '?' }), 8000)
          }
          return prev
        })
      }
      void tick()
      pollRef.current = window.setInterval(() => void tick(), 700)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchSpans, toast, t],
  )

  const handleRun = useCallback(
    async (input: string): Promise<void> => {
      if (runState === 'running') return
      setRunPanelOpen(false)
      setResultsOpen(true)
      setLatestSpans([])
      manualCollapseRef.current.clear()
      editorRef.current?.clearRunState()
      setRunState('running')
      setRunSummary(null)
      // 输入记忆（⬆ 语义）：提交即记，⌘⏎ 重跑时预填
      persistRunInput(input)

      const runId = crypto.randomUUID()
      setActiveRunId(runId)
      const startedAt = Date.now()
      try {
        // 异步模式：立即返回 runId，进度全靠轮询 —— 同步等待会让长流程
        //（如 5-9 分钟的多 Agent 链）撞上代理层 300s 超时，客户端误报失败。
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(flowId)}/run?async=1`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-run-id': runId },
            body: JSON.stringify({
          ...(input.trim() ? { input: input.trim() } : {}),
          ...(runDirectoryId ? { directoryId: runDirectoryId } : {}),
        }),
          },
        )
        const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null
        if (!res.ok || !json?.success) {
          setRunState('failed')
          const reason = json?.error ?? `HTTP ${res.status}`
          setRunSummary(t('启动失败 · {reason}', { reason: reason.slice(0, 80) }))
          toast.error(t('启动失败：{reason}', { reason: reason.slice(0, 120) }), 8000)
          return
        }
        watchLoop(runId, startedAt)
      } catch (err) {
        setRunState('failed')
        const reason = err instanceof Error ? err.message : String(err)
        setRunSummary(t('启动失败 · {reason}', { reason: reason.slice(0, 80) }))
        toast.error(t('启动失败：{reason}', { reason: reason.slice(0, 120) }), 8000)
      }
    },
    [runState, flowId, watchLoop, toast, t, runDirectoryId, persistRunInput],
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
      const { runStatus, hasRunning, hasSpans } = await fetchSpans(watchRunId)
      if (cancelled) return
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
              disabled={runState === 'running'}
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
                <button type='button' className='canvas-run-panel-go' onClick={() => void handleRun(runInput)}>
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
              <div className='canvas-run-panel-title'>
                <span className='canvas-results-title-row'>
                  {t('运行结果')}
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
                <div className='canvas-results-live'>
                  {(() => {
                    const active = latestSpans.filter((sp) => sp.status === 'running')
                    const doneN = latestSpans.filter(
                      (sp) => sp.status === 'done' || sp.status === 'completed',
                    ).length
                    const failedN = latestSpans.filter((sp) => sp.status === 'failed').length
                    // 分母 = 流程总节点数（initialFlow），不是已出现的 span 数 ——
                    // 早期只有 1-2 个 span，用 span 数会把 5 节点流程显示成「1/2」，
                    // 跑着跑着分母再变大，非常误导。
                    const total = initialFlow.nodes.length
                    const progress = `${doneN}/${total} ${t('完成')}${failedN > 0 ? ` · ${failedN} ${t('失败')}` : ''}`
                    return active.length > 0
                      ? `${t('正在执行')}：${active.map((sp) => sp.nodeLabel || sp.nodeId).join('、')}（${progress}）`
                      : `${doneN >= total ? t('收尾中') : t('准备中')}…（${progress}）`
                  })()}
                </div>
              ) : null}
              {resultView === 'terminal' ? (
                /* 终端视图：全量过程日志单流分段（拓扑序同摘要视图），保真回放。
                    stdin 行（可操作终端 2026-09-08）：运行中可对 running 节点插话，
                    结束后原位变重跑入口。 */
                (() => {
                  const topoOrder = new Map(initialFlow.nodes.map((n, i) => [n.id as string, i]))
                  const sections = [...latestSpans]
                    .sort(
                      (a, b) =>
                        (topoOrder.get(a.nodeId ?? '') ?? 1e9) - (topoOrder.get(b.nodeId ?? '') ?? 1e9),
                    )
                    .map(spanToTerminalSection)
                  const activeNodes = latestSpans
                    .filter((sp) => sp.status === 'running')
                    .map((sp) => ({ id: sp.nodeId ?? sp.node_id ?? '', label: sp.nodeLabel || sp.nodeId || '?' }))
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
              <div className='canvas-results-list'>
                {/* FR-15（PRD 决议 D9）：行序按流程拓扑（initialFlow 节点
                    顺序），不再按 span 返回序（完成时间倒序会把 start 排最后，
                    违背阅读直觉）；未知节点（理论不该有）排在末尾 */}
                {(() => {
                  const topoOrder = new Map(initialFlow.nodes.map((n, i) => [n.id as string, i]))
                  return [...latestSpans]
                    .sort(
                      (a, b) =>
                        (topoOrder.get(a.nodeId ?? '') ?? 1e9) - (topoOrder.get(b.nodeId ?? '') ?? 1e9),
                    )
                    .map((sp) => {
                      const id = sp.nodeId ?? sp.node_id ?? '?'
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
                              {st === 'warn' ? `⚠ ${t('疑似权限受限')}` : st === 'running' ? t('运行中') : st === 'done' || st === 'completed' ? t('完成') : st === 'failed' ? t('失败') : st}
                              {sp.durationMs != null ? ` · ${(sp.durationMs / 1000).toFixed(1)}s` : ''}
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
    [flowName, saveState, readOnly, runState, runSummary, handleRun, t, runPanelOpen, runInput, resultsOpen, latestSpans, saveTplOpen, handleAddDirectory, firstRunBar, templateParamNames, initialFlow, resultView, switchResultView, ioOpen],
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
