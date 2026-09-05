'use client'

/* eslint-disable @typescript-eslint/no-explicit-any -- adapter for @dagents/agentflow React Flow node/edge shapes that aren't exported as concrete types */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Agentflow } from '@dagents/agentflow'
import type { AgentFlowInstance, ExecutionStatus, FlowData, HeaderRenderProps } from '@dagents/agentflow'
import { getNodeMeta, validateFlowTopology } from '@dagents/workflow'
import { useToast } from '@/components/toast'
import { useI18n } from '@/i18n'
import { detectRefusal } from '@/lib/refusal-detect'
import { pickDirectory, createDirectory } from '@/lib/directories'
import { SaveFlowTemplateDialog, scanTemplateParamNames } from '@/components/save-flow-template-dialog'
// flowise.css 是 vendor 画布的基础样式（节点 max-content 尺寸规则 + React Flow
// 定位/handle/edge 基类），canvas.css 只在其上做主题变量覆盖。此前 base 缺失，
// 节点量不出尺寸 → React Flow 永久 visibility:hidden → 边被静默丢弃，
// 画布表现为空白只剩工具栏。必须在 canvas.css 之前引入。
import '@dagents/agentflow/flowise.css'
import './canvas.css'
// .kbd（统一 kbd 键帽，shortcuts.css 单一定义、GL03/GL06 全站共用）
import '@/styles/shortcuts.css'

export interface FlowiseCanvasProps {
  flowId: string
  flowName?: string
  initialFlow: {
    nodes: any[]
    edges: any[]
    viewport?: any
  }
  onSave?: (data: any) => Promise<void>
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

/**
 * 将后端存储的 flowData 转换为 Flowise Agentflow 期望的 FlowData 格式。
 *
 * 关键处理：补全 outputAnchors。从列表 API 读取的老数据可能缺少
 * outputAnchors 字段，这里根据 @dagents/workflow 注册表的 meta.outputs
 * 生成默认输出锚点，保证 Flowise 原生 AgentFlowNode 的 NodeOutputHandles
 * 能正确渲染连线端口。
 */
export function convertToFlowiseFormat(initialFlow: FlowiseCanvasProps['initialFlow']): FlowData {
  const nodes = initialFlow.nodes.map((node) => {
    const name = node.data?.name || node.name || 'startAgentflow'
    const meta = getNodeMeta(name)

    // 补全 outputAnchors：老数据可能缺这个字段
    // id 用 name（如 "true"/"false"），使其与边的 sourceHandle 匹配
    let outputAnchors = node.data?.outputAnchors
    if (!outputAnchors || !Array.isArray(outputAnchors)) {
      if (meta?.outputs && Array.isArray(meta.outputs) && meta.outputs.length > 0) {
        outputAnchors = meta.outputs.map((o: any) => {
          const oName = typeof o === 'string' ? o : o.name ?? 'output'
          return {
            id: oName,
            name: oName,
            label: typeof o === 'string' ? o : o.label ?? oName,
            type: typeof o === 'string' ? 'string' : o.type ?? 'string',
          }
        })
      } else {
        outputAnchors = [
          {
            id: 'output',
            name: 'output',
            label: 'Output',
            type: 'string',
          },
        ]
      }
    }

    // 确保节点 type 被正确设置为 Flowise 原生类型
    // 后端存储的 type 可能是 'default' 或 undefined，需统一映射
    const rawType = node.type ?? ''
    const flowiseType =
      rawType === 'stickyNote' || rawType === 'iteration'
        ? rawType
        : rawType === 'agentflowNode'
          ? rawType
          : 'agentflowNode'

    return {
      ...node,
      type: flowiseType,
      data: {
        ...node.data,
        id: node.id,
        name,
        // 显示名优先级：存量 label → meta.label（Start / LLM / Direct Reply 等
        // 注册表显示名）→ 内部 name。老数据只有 data.name，缺少 label 与
        // handle 字段，若直接回退成 'Start' 会让所有节点看起来一模一样。
        label: node.data?.label || node.label || meta?.label || name,
        outputAnchors,
        inputs: node.data?.inputs ?? {},
        hideInput: node.data?.hideInput ?? meta?.category === 'start',
        // 注入 version，避免 Flowise NodeWarningIndicator 显示 "Node outdated" 橙色感叹号
        version: node.data?.version ?? 1,
      },
    }
  })

  // NodeInputHandle 的 target handle id 约定为「目标节点自身 id」，
  // NodeOutputHandles 的 source handle id 约定为「输出锚点 id」。存量/AI 生成的
  // 边只有 source/target，缺 handle 字段 —— React Flow 匹配不到 handle 会静默
  // 丢弃这些边，因此这里按约定补全。type/data 也对齐 handleConnect 生成的
  // agentflowEdge 形状，保证加载的边与手工连线渲染一致。
  const sourceAnchorByNodeId = new Map(
    nodes.map((n) => [n.id, n.data.outputAnchors?.[0]?.id ?? 'output']),
  )
  const edges = initialFlow.edges.map((edge) => ({
    ...edge,
    sourceHandle: edge.sourceHandle ?? sourceAnchorByNodeId.get(edge.source) ?? 'output',
    targetHandle: edge.targetHandle ?? edge.target,
    type: edge.type ?? 'agentflowEdge',
    animated: edge.animated ?? false,
    data: edge.data ?? {
      sourceColor: '#10b981',
      targetColor: '#10b981',
      edgeLabel: undefined,
      isHumanInput: false,
    },
  }))

  return {
    nodes,
    edges,
    viewport: initialFlow.viewport || { x: 0, y: 0, zoom: 1 },
  }
}

/** span 的 input/output 载荷 → 可读文本（截断），结果面板展示用。 */
function formatSpanPayload(payload: Record<string, unknown> | string | null | undefined, max: number): string {
  if (payload == null) return ''
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1)
  return text.length > max ? text.slice(0, max) + ` …(${text.length})` : text
}

/** 节点产出的展示形态：LLM/reply 的 text/content 直出为正文，
 *  其余保持 JSON —— 用户要看的是模型说了什么，不是 JSON 壳。 */
interface SpanDisplay {
  kind: 'text' | 'json'
  text: string
  /** 折叠态摘要（单行截断）。 */
  preview: string
  /** 过程活动流（running 期间的 thinking/工具调用，2026-08-30）——
   * CLI Agent 干活的大头在思考和调工具而非写正文，没有它旁观端是
   * 「（执行中…）」黑盒。终态 output 无此字段。 */
  activity?: Array<{ kind: 'thinking' | 'tool'; label: string }>
}

/** 从 span.output 提取活动流（容错：形状不符返回空数组）。 */
function spanActivity(payload: CanvasSpanRow['output']): Array<{ kind: 'thinking' | 'tool'; label: string }> {
  if (!payload || typeof payload !== 'object') return []
  const raw = (payload as Record<string, unknown>).activity
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (a): a is { kind: 'thinking' | 'tool'; label: string } =>
      !!a && typeof a === 'object' &&
      ((a as Record<string, unknown>).kind === 'thinking' || (a as Record<string, unknown>).kind === 'tool') &&
      typeof (a as Record<string, unknown>).label === 'string',
  )
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
    return { kind: 'text', text: '', preview: `${last.kind === 'tool' ? '🔧' : '💭'} ${oneLine(last.label, 70)}`, activity }
  }
  const json = JSON.stringify(obj, null, 1)
  return { kind: 'json', text: json, preview: oneLine(json.replace(/[{}"\\]/g, '').trim(), 90) }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
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

export function FlowiseCanvas({
  flowId,
  flowName = 'Untitled',
  initialFlow,
  onSave,
  readOnly = false,
  watchRunId = null,
  firstRunHint = false,
}: FlowiseCanvasProps): React.ReactElement {
  const agentflowRef = useRef<AgentFlowInstance>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const toast = useToast()
  const { t } = useI18n()

  // ── 画布内运行 + 节点实时进度 ──
  // run POST 是同步执行完才返回，但网关接受客户端自带的 x-run-id 请求头，
  // 因此画布自己生成 runId、带着头发起运行，同时轮询 node-spans 把
  // 每个节点的 status 实时刷到 vendor 的执行徽章上（INPROGRESS = 旋转加载
  // 图标，FINISHED = 绿色对勾，ERROR = 红色叉 + 错误提示）。
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
  const [runInput, setRunInput] = useState('')
  const [resultsOpen, setResultsOpen] = useState(false)
  const [latestSpans, setLatestSpans] = useState<CanvasSpanRow[]>([])
  /** 结果面板里手动折叠过的节点（用户显式收起 → 不再自动展开）。 */
  const manualCollapseRef = useRef<Set<string>>(new Set())
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

  /** 原始边数据（运行结束后恢复连线配色用）— 初始化见 initialFlowData 之后。 */
  const originalEdgesRef = useRef<FlowData['edges'] | null>(null)

  const initialFlowData = useMemo(
    () => convertToFlowiseFormat(initialFlow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlow],
  )

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
  if (originalEdgesRef.current === null) originalEdgesRef.current = initialFlowData.edges

  /** 模板参数预扫描（PX-CV04）：另存为模板对话框的 {{变量}} chip 网格数据源。 */
  const templateParamNames = useMemo(
    () => scanTemplateParamNames(initialFlowData.nodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialFlowData],
  )

  /** 完成段的连线颜色（两端节点都 done 时整段点亮）。 */
  const EDGE_DONE_COLOR = '#16a34a'

  /** 连线随节点进度点亮：完成段变绿渐变，活动段（源完成→目标运行中）流动动画。 */
  const applyEdgeStates = useCallback((spans: ReadonlyArray<{ node_id?: string; nodeId?: string; status?: string }>): void => {
    const rf = agentflowRef.current?.getReactFlowInstance?.()
    if (!rf) return
    const st = new Map(spans.map((s) => [s.node_id ?? s.nodeId ?? '', s.status ?? '']))
    const isDone = (id: string): boolean => st.get(id) === 'done' || st.get(id) === 'completed'
    const isRunning = (id: string): boolean => st.get(id) === 'running'
    rf.setEdges((edges) =>
      edges.map((e) => {
        if (isDone(e.source) && isDone(e.target)) {
          return {
            ...e,
            animated: false,
            data: { ...e.data, sourceColor: EDGE_DONE_COLOR, targetColor: EDGE_DONE_COLOR },
          }
        }
        if (isDone(e.source) && isRunning(e.target)) {
          return { ...e, animated: true }
        }
        return e
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 恢复连线初始状态（新一轮运行前）。 */
  const resetEdges = useCallback((): void => {
    const rf = agentflowRef.current?.getReactFlowInstance?.()
    if (!rf) return
    const orig = new Map((originalEdgesRef.current ?? []).map((e) => [e.id, e]))
    rf.setEdges((edges) =>
      edges.map((e) => ({ ...e, animated: false, data: { ...(orig.get(e.id)?.data ?? e.data) } })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** gateway run_node_spans.status → vendor ExecutionStatus。 */
  const SPAN_STATUS_MAP: Record<string, ExecutionStatus> = {
    running: 'INPROGRESS',
    completed: 'FINISHED',
    done: 'FINISHED',
    failed: 'ERROR',
    error: 'ERROR',
    paused: 'WAITING_FOR_INPUT',
  }

  const applySpans = useCallback(
    (spans: ReadonlyArray<CanvasSpanRow>): void => {
      const inst = agentflowRef.current
      if (!inst) return
      for (const s of spans) {
        const nodeId = s.node_id ?? s.nodeId
        const status = s.status ? SPAN_STATUS_MAP[s.status] : undefined
        if (nodeId && status) inst.setNodeExecutionStatus(nodeId, status, s.error ?? undefined)
      }
      applyEdgeStates(spans)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyEdgeStates],
  )

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
            spans?: CanvasSpanRow[]
          }
        }
        const spans = body?.data?.spans ?? []
        applySpans(spans)
        setLatestSpans(spans)
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
      const inst = agentflowRef.current
      inst?.clearExecutionState()
      resetEdges()
      setRunState('running')
      setRunSummary(null)

      const runId = crypto.randomUUID()
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
    [runState, flowId, resetEdges, watchLoop, toast, t, runDirectoryId],
  )

  // ── 旁观模式（canvas?run=<runId>）：自动轮询并点亮节点/连线 ──
  // 典型来源：chat @flow 触发的运行（chat 面板「在画布中查看」链接）。
  // 终止条件：runs 行的 runStatus（completed/failed/cancelled）；没有
  // runs 行时退化为启发式 —— 连续 4 轮无 running span 且已有 span 视为结束。
  useEffect(() => {
    if (!watchRunId) return
    let stablePolls = 0
    let cancelled = false
    setRunState('running')
    setRunSummary(null)
    // 旁观即看流：结果面板默认打开 + 清掉手动收起记忆 —— 否则徽章在亮、
    // 面板却关着，流式 live tail 默认不可见（2026-08-30 修复）。
    setResultsOpen(true)
    manualCollapseRef.current.clear()
    agentflowRef.current?.clearExecutionState()
    resetEdges()
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


  const handleSave = useCallback(
    async (flowData: FlowData) => {
      // 保存前拓扑干跑（docs/product-plan.md 方案 A4）：errors=不可执行 /
      // warnings=可疑，全部不阻断保存 —— 尊重草稿自由，把「执行时才爆炸」
      // 提前到「保存时就看见」。校验器是 @dagents/workflow 的 AD-2 单源
      // 实现，vendor 画布形状（data.name 优先、type 回退）直接喂即可。
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

      // 优先使用外部 onSave，否则走默认持久化逻辑（PUT /api/workflows/:id）
      if (onSave) {
        setSaveState('saving')
        try {
          await onSave(flowData)
          setSaveState('saved')
          notifyTopologyAfterSave()
          setTimeout(() => setSaveState('idle'), 2000)
        } catch {
          setSaveState('error')
          setTimeout(() => setSaveState('idle'), 3000)
        }
        return
      }

      setSaveState('saving')
      try {
        const res = await fetch(`/api/workflows/${flowId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flowData }),
        })
        if (!res.ok) {
          throw new Error(`保存失败: ${res.status}`)
        }
        setSaveState('saved')
        notifyTopologyAfterSave()
        setTimeout(() => setSaveState('idle'), 2000)
      } catch (err) {
        console.error('保存工作流失败:', err)
        setSaveState('error')
        setTimeout(() => setSaveState('idle'), 3000)
      }
    },
    [onSave, flowId, toast, t],
  )

  // 自定义 header：flowName + 运行（带节点实时进度徽章）+ 保存
  const renderHeader = useCallback(
    (props: HeaderRenderProps) => {
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
        <div className='agentflow-header' style={{ position: 'relative' }}>
          <span className='agentflow-title' title={flowName}>
            {flowName}
            {props.isDirty && ' *'}
          </span>
          <div className='agentflow-header-actions'>
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
              onClick={props.onSave}
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
              <span className='canvas-first-run-dot' aria-hidden='true'>✨</span>
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

          {/* 运行结果面板：逐节点状态/耗时/产出（spans 实时刷新） */}
          {resultsOpen && latestSpans.length > 0 ? (
            <div className='canvas-results-panel' role='region' aria-label={t('运行结果')}>
              <div className='canvas-run-panel-title'>
                {t('运行结果')}
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
                    // 分母 = 流程总节点数（initialFlowData），不是已出现的 span 数 ——
                    // 早期只有 1-2 个 span，用 span 数会把 5 节点流程显示成「1/2」，
                    // 跑着跑着分母再变大，非常误导。
                    const total = initialFlowData.nodes.length
                    const progress = `${doneN}/${total} ${t('完成')}${failedN > 0 ? ` · ${failedN} ${t('失败')}` : ''}`
                    return active.length > 0
                      ? `${t('正在执行')}：${active.map((sp) => sp.nodeLabel || sp.nodeId).join('、')}（${progress}）`
                      : `${doneN >= total ? t('收尾中') : t('准备中')}…（${progress}）`
                  })()}
                </div>
              ) : null}
              <div className='canvas-results-list'>
                {/* FR-15（PRD 决议 D9）：行序按流程拓扑（initialFlowData 节点
                    顺序），不再按 span 返回序（完成时间倒序会把 start 排最后，
                    违背阅读直觉）；未知节点（理论不该有）排在末尾 */}
                {(() => {
                  const topoOrder = new Map(initialFlowData.nodes.map((n, i) => [n.id, i]))
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
                                <span className='canvas-act-icon' aria-hidden='true'>{a.kind === 'tool' ? '🔧' : '💭'}</span>
                                <span className='canvas-act-label'>{a.label}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {sp.input != null && Object.keys(sp.input as object).length > 0 ? (
                          <details className='canvas-result-io'>
                            <summary className='canvas-result-io-label'>{t('输入')}</summary>
                            <pre>{formatSpanPayload(sp.input, 500)}</pre>
                          </details>
                        ) : null}
                        {display ? (
                          display.kind === 'text' ? (
                            <div className={`canvas-result-text${st === 'running' ? ' streaming' : ''}`}>
                              {display.text}
                            </div>
                          ) : (
                            <div className='canvas-result-io'>
                              <div className='canvas-result-io-label'>{t('产出')}</div>
                              <pre>{formatSpanPayload(sp.output, 900)}</pre>
                            </div>
                          )
                        ) : (
                          <div className='canvas-result-io muted' style={{ fontSize: 11 }}>
                            {st === 'running' ? t('（执行中…）') : t('（无产出）')}
                          </div>
                        )}
                        {display?.kind === 'text' ? (
                          <details className='canvas-result-io'>
                            <summary className='canvas-result-io-label'>{t('原始数据')}</summary>
                            <pre>{formatSpanPayload(sp.output, 900)}</pre>
                          </details>
                        ) : null}
                      </div>
                    </details>
                  )
                })
                })()
                }
              </div>
            </div>
          ) : null}
        </div>
      )
    },
    [flowName, saveState, readOnly, runState, runSummary, handleRun, t, runPanelOpen, runInput, resultsOpen, latestSpans, saveTplOpen, handleAddDirectory, firstRunBar, templateParamNames],
  )

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 520 }}>
      <Agentflow
        ref={agentflowRef}
        apiBaseUrl='/api/flowise'
        flowId={flowId}
        initialFlow={initialFlowData}
        onSave={handleSave}
        readOnly={readOnly}
        showDefaultHeader={false}
        renderHeader={renderHeader}
        showDefaultPalette={true}
        enableGenerator={true}
      />
    </div>
  )
}
