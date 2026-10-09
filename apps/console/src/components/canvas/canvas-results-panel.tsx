'use client'

/**
 * CanvasResultsPanel —— 画布运行结果面板（独立组件，2026-09-22 架构解耦）。
 *
 * 为什么独立：此前约 390 行面板 JSX 内联在 canvas-kit-page（1460 行）里，
 * 面板样式散在两个 css 文件 —— 其中 src/styles/canvas.css 从未被任何组件
 * import，「重跑/停止/从此处继续」按钮以浏览器原生样式裸渲染了四天才被
 * 发现（2026-09-22 修复）。拆分契约：
 *   - 样式自带：本组件 import './canvas-results.css'，加载跟随组件引用，
 *     不再依赖页面统一引一个大 css 的隐式约定（孤儿样式防复发的结构前提）；
 *   - 展示态归组件：视图切换（摘要/终端，localStorage 记忆）、行内
 *     ioOpen、手动折叠记忆、挂起应答输入态 —— 全部内聚于此；
 *   - 执行编排归页面：run/watch/toast/checkpoint 等副作用经 props 回调
 *     注入（onRerun/onResume/onCancel/onSend/onSubmitAnswer）。
 * DOM 类名（.canvas-results-panel 等）原样保留 —— e2e 选择器契约不变。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { Icon, type IconName } from '@/components/icon'
import { detectRefusal } from '@/lib/refusal-detect'
import type { RunNodeSpan } from '@/lib/node-spans'
import { RunTerminal, type TerminalSendResult } from '@/components/run-terminal'
import {
  spanToTerminalSection,
  extractOutputText,
  buildDeliverablesTranscript,
  type TerminalSection,
} from '@/lib/run-terminal-format'
import type { DeliverableItem } from '@dagents/contracts'
import { buildTraceFromSpans, type RunTraceModel } from '@/lib/run-trace-model'
import { CanvasTraceView } from '@/components/canvas/canvas-trace-view'
import type { RunLiveMode } from '@/lib/use-run-live'
import { terminalHrefForDir } from '@/lib/terminal-links'
import { ResultViewer } from '@/components/result-viewer'
import { useI18n } from '@/i18n'
import { dualBasisTokens } from '@/lib/run-tokens'
import './canvas-results.css'

/** 页面 runState 的共享联合（页面 useState 与本组件 props 同一形状）。
 *  `stopped`（2026-10-07 R3/R1，design-recover §4.1）：中止终态——中性色
 *  （非失败红）；interrupted + resumable 由页面派生 resumeInfo 亮「从此处
 *  继续」，user → 「已停止」（AC-R1-6/AC-R3-4）。 */
export type CanvasRunState = 'idle' | 'running' | 'done' | 'failed' | 'awaiting' | 'stopped'
/** 断点续跑入口判定（failed + resumable 才亮「从此处继续」）。 */
export interface CanvasResumeInfo {
  runId: string
  completedCount: number
}
/** HumanInput 挂起载荷（awaiting 态应答条）。 */
export interface CanvasAwaitingInfo {
  nodeId: string
  prompt: string
  inputType: string
  options: string[]
}

export interface CanvasResultsPanelProps {
  runState: CanvasRunState
  /** 本轮 run 的节点 spans（增量刷新由页面轮询驱动）。 */
  spans: RunNodeSpan[]
  /** run 级失败原因（2026-09-22）：零 span 的整体失败（拓扑成环 / 启动即挂）
   *  唯一的失败线索 —— 顶部横幅展示；成功 / 旧网关为 null。 */
  runError?: string | null
  /** 流程总节点数（进度分母 —— 早期 span 数少，不能拿 spans.length 当分母）。 */
  totalNodes: number
  /** 拓扑序（initialFlow 节点顺序）—— 行序与终端分段排序用。 */
  topoOrder: Map<string, number>
  /** 全图节点清单（R6 渐进产物）：聚合区「未完成节点显式标注」的数据源
   *  （label 与 gateway nodeLabelById 同语义：data.label ?? id）。 */
  flowNodes: Array<{ id: string; label: string }>
  /** 当前 run id（R6 下载文件名用；旁观/无 run 为 null）。 */
  runId: string | null
  /** 产出清单（R6 渐进产物，2026-10-07）：node-spans 信封的服务端投影
   *  （journal 主路 + 继承标注）。null = 字段缺席（旧网关 / 投影读失败）
   *  → 聚合区整体不渲染（诚实降级）；[] = 新网关零产出。聚合区只吃服务端
   *  投影，不做客户端兜底 —— 继承语义只在服务端有（决策 F）。 */
  deliverables: DeliverableItem[] | null
  /** live 直播帧流（useRunLive）；回退 node-spans 快照渲染。 */
  runLive: { mode: RunLiveMode; sections: TerminalSection[]; trace: RunTraceModel | null }
  /** 运行中插话能力位（node-spans inputSupported）。 */
  inputSupported: boolean
  /** 失败深链终端的目录锚（本会话发起或旁观回传），null 不渲染入口。 */
  terminalDirId: string | null
  resumeInfo: CanvasResumeInfo | null
  awaitingInfo: CanvasAwaitingInfo | null
  /** 谱系继承累计 token（R2.3 双口径）：null = 根运行（不渲染双口径行）。 */
  lineageTokens?: number | null
  onClose(): void
  /** 打开运行输入面板（⬆ 预填语义由页面持有）。mode（2026-10-07 R2，
   *  design-recover §4.2 重跑分叉）：'warm' = 暖缓存重跑（默认——body 带
   *  warmFromRunId=当前 run，沿谱系链种子匹配）；'fresh' = 全新重跑
   *  （零缓存零谱系）。 */
  onRerun(mode: 'warm' | 'fresh'): void
  onResume(): void
  onCancel(): void | Promise<void>
  onSend(nodeId: string, text: string): Promise<TerminalSendResult>
  /** 挂起应答提交：回 true 才清空输入（不做假乐观）。 */
  onSubmitAnswer(answer: string): Promise<boolean>
}

/** span 的 input/output 载荷 → 可读文本（截断），结果面板展示用。 */
function formatSpanPayload(payload: Record<string, unknown> | string | null | undefined, max: number): string {
  if (payload == null) return ''
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1)
  return text.length > max ? text.slice(0, max) + ` …(${text.length})` : text
}

/** 活动流条目类型 —— 与引擎 IStreamActivityKind 对齐（2026-09-06 保真扩展
 *  后新增 tool_result/status/log/error；status/log 不进 activity 环，容错仍认；
 *  verdict = R5 三值裁决审计行，2026-10-07）。 */
type ActivityKind =
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'status'
  | 'log'
  | 'error'
  | 'user_input'
  | 'verdict'
const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'thinking',
  'tool',
  'tool_result',
  'status',
  'log',
  'error',
  'user_input',
  'verdict',
]

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
            : kind === 'verdict'
              ? 'check'
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

/** 实时已耗时（走查优化点 1/2 的载体）：自带秒级心跳的叶子组件。
 * 计时状态局部于本组件 —— 心跳放页面级会把整棵画布树拖进每秒重渲
 * （架构自审 2026-09-20，随本组件一并迁出页面）。 */
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

/* ── 产出清单聚合区（R6 渐进产物，2026-10-07，design-artifacts.md §④）──
 *
 * 摘要视图顶部的可折叠聚合卡（非第四 tab——三视图框架已稳定，聚合区是
 * 「先看全部产物，再逐节点细读」的阅读序前置）。渐进语义：running/
 * awaiting 态即渲染（随 spans 轮询增量刷新，props 由页面同节拍供给）；
 * 终态定格（watchTick 收尾再 fetchSpans 一次已保证数据齐全）。
 * 行结构：拓扑序（服务端按实例键序返回，本侧重排——拓扑知识天然在画布
 * 侧）；迭代体同 nodeId 多 ordinal 聚合一行、行内列各项；提取预览与单节
 * 点行同一单源（extractOutputText → @dagents/contracts）。 */

/** 机器面条目（实例键）→ 人行粒度（节点）的聚合形态。 */
export interface DeliverableGroup {
  nodeId: string
  label: string
  items: DeliverableItem[]
}

/** 按节点聚合 + 拓扑序重排（继承行与真实执行行同规则参与排序——种子
 *  节点排在其拓扑位，阅读序与图结构一致）。导出供组件测试直测纯逻辑。 */
export function groupDeliverables(
  deliverables: DeliverableItem[],
  topoOrder: Map<string, number>,
): DeliverableGroup[] {
  const byNode = new Map<string, DeliverableItem[]>()
  for (const item of deliverables) {
    const list = byNode.get(item.nodeId)
    if (list) list.push(item)
    else byNode.set(item.nodeId, [item])
  }
  return [...byNode.entries()]
    .map(([nodeId, items]) => ({
      nodeId,
      label: items.find((i) => i.nodeLabel)?.nodeLabel || nodeId,
      items: [...items].sort((a, b) => a.ordinal - b.ordinal),
    }))
    .sort(
      (a, b) => (topoOrder.get(a.nodeId) ?? 1e9) - (topoOrder.get(b.nodeId) ?? 1e9),
    )
}

/** 组内 tokens 求和 → 单一徽章（多 ordinal 项的用量合并呈现）。导出供
 *  组件测试直测纯逻辑。 */
export function sumTokensBadge(items: DeliverableItem[]): string | null {
  let seen = false
  let inputTokens = 0
  let outputTokens = 0
  for (const it of items) {
    const u = it.tokens as { inputTokens?: unknown; outputTokens?: unknown } | null
    if (!u || typeof u !== 'object') continue
    if (typeof u.inputTokens === 'number') {
      inputTokens += u.inputTokens
      seen = true
    }
    if (typeof u.outputTokens === 'number') {
      outputTokens += u.outputTokens
      seen = true
    }
  }
  return seen ? tokensBadge({ inputTokens, outputTokens }) : null
}

/** 导出供组件测试直渲染（生产消费方仍是 CanvasResultsPanel 内部装配）。 */
export function DeliverablesCard({
  runId,
  deliverables,
  flowNodes,
  spans,
  topoOrder,
  runState,
  awaitingInfo,
  onJumpToTerminal,
}: {
  runId: string | null
  deliverables: DeliverableItem[]
  flowNodes: Array<{ id: string; label: string }>
  spans: RunNodeSpan[]
  topoOrder: Map<string, number>
  runState: CanvasRunState
  awaitingInfo: CanvasAwaitingInfo | null
  onJumpToTerminal: (nodeId: string) => void
}): React.ReactElement | null {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const groups = groupDeliverables(deliverables, topoOrder)
  const deliveredNodeIds = new Set(deliverables.map((d) => d.nodeId))
  const spanStatusOf = (nodeId: string): string | null =>
    spans.find((sp) => sp.nodeId === nodeId)?.status ?? null
  // 未完成标注（≠失败）：失败节点不进「未执行」灰行——它执行过了，失败态
  // 由下方逐节点行呈现；这里只标真正没跑 / 在跑 / 挂起等待的节点。
  const pending = flowNodes.filter(
    (n) => !deliveredNodeIds.has(n.id) && spanStatusOf(n.id) !== 'failed',
  )
  if (deliverables.length === 0 && pending.length === 0) return null

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildDeliverablesTranscript(deliverables))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 剪贴板不可用（非安全上下文等）—— 静默，下载入口仍在 */
    }
  }
  const download = (): void => {
    const blob = new Blob([buildDeliverablesTranscript(deliverables)], {
      type: 'text/markdown',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `deliverables-${(runId ?? 'run').slice(0, 8)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <details className='canvas-deliverables-card' open>
      <summary>
        <span className='canvas-delv-title'>{t('产出清单')}</span>
        {deliverables.length > 0 ? (
          <span className='canvas-delv-count tnum'>
            {t('共 {n} 项产出', { n: deliverables.length })}
          </span>
        ) : null}
        <span className='canvas-delv-actions'>
          {copied ? <span className='canvas-delv-copied'>✓ {t('已复制')}</span> : null}
          <button
            type='button'
            className='canvas-delv-btn'
            onClick={() => void copyAll()}
            disabled={deliverables.length === 0}
          >
            {t('复制产出清单')}
          </button>
          <button
            type='button'
            className='canvas-delv-btn'
            onClick={download}
            disabled={deliverables.length === 0}
          >
            {t('下载产出')}
          </button>
        </span>
      </summary>
      <div className='canvas-delv-rows'>
        {groups.map((g) => {
          const badge = sumTokensBadge(g.items)
          const inherited = g.items.find((i) => i.inheritedFromRunId)?.inheritedFromRunId
          const subflow = g.items.find((i) => i.subflowName)?.subflowName
          const firstPreview = (() => {
            for (const item of g.items) {
              const text = extractOutputText(item.output)
              if (text) return oneLine(text, 90)
            }
            return null
          })()
          return (
            <details className='canvas-delv-row' key={g.nodeId}>
              <summary>
                <span className='canvas-delv-name' title={g.nodeId}>
                  {g.label}
                </span>
                {g.items.length > 1 ? (
                  <span className='canvas-delv-items-n tnum'>
                    {t('{n} 项', { n: g.items.length })}
                  </span>
                ) : firstPreview ? (
                  <span className='canvas-delv-preview' title={firstPreview}>
                    {firstPreview}
                  </span>
                ) : null}
                {inherited ? (
                  <span className='canvas-delv-chip' title={inherited}>
                    {t('继承自前次运行')} {inherited.slice(0, 8)}
                  </span>
                ) : null}
                {subflow ? (
                  <span className='canvas-delv-chip canvas-delv-chip-subflow'>
                    {t('子流程')} · {subflow}
                  </span>
                ) : null}
                {badge ? (
                  <span className='canvas-delv-tokens' title={t('token 用量（输入/输出）')}>
                    {badge}
                  </span>
                ) : null}
                <button
                  type='button'
                  className='canvas-delv-term-btn'
                  onClick={(e) => {
                    e.stopPropagation()
                    onJumpToTerminal(g.nodeId)
                  }}
                  title={t('在终端视图中查看该节点的完整过程')}
                >
                  {t('终端')}
                </button>
              </summary>
              <div className='canvas-delv-items'>
                {g.items.map((item, idx) => {
                  const text = extractOutputText(item.output)
                  const full = text ?? (item.output != null ? JSON.stringify(item.output, null, 2) : '')
                  return (
                    <div className='canvas-delv-item' key={`${item.nodeId}#${item.ordinal}`}>
                      {g.items.length > 1 ? (
                        <span className='canvas-delv-ordinal tnum'>
                          {t('第 {k}/{n} 项', { k: idx + 1, n: g.items.length })}
                        </span>
                      ) : null}
                      <ResultViewer title={`${g.label} · ${t('产出')}`} text={full} mono={text == null}>
                        <span className='canvas-delv-item-text'>
                          {text ? oneLine(text, 160) : full ? oneLine(full, 160) : t('（无产出）')}
                        </span>
                      </ResultViewer>
                    </div>
                  )
                })}
              </div>
            </details>
          )
        })}
        {pending.length > 0 ? (
          <div className='canvas-delv-pending'>
            {pending.map((n) => {
              const st = spanStatusOf(n.id)
              const tag =
                runState === 'awaiting' && awaitingInfo?.nodeId === n.id
                  ? t('等待输入')
                  : st === 'running'
                    ? t('执行中')
                    : t('未执行')
              return (
                <div className='canvas-delv-pending-row' key={n.id}>
                  <span className='canvas-delv-name'>{n.label}</span>
                  <span className={`canvas-delv-pending-tag${st === 'running' ? ' running' : ''}`}>
                    {tag}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </details>
  )
}

export function CanvasResultsPanel({
  runState,
  spans,
  runError,
  totalNodes,
  topoOrder,
  flowNodes,
  runId,
  deliverables,
  runLive,
  inputSupported,
  terminalDirId,
  resumeInfo,
  awaitingInfo,
  lineageTokens = null,
  onClose,
  onRerun,
  onResume,
  onCancel,
  onSend,
  onSubmitAnswer,
}: CanvasResultsPanelProps): React.ReactElement | null {
  const { t } = useI18n()
  // 结果列表跟随（优化点 11）：spans 更新时把 running 节点滚进视口 ——
  // 列表超高后用户不必手动去找「现在跑到哪了」。
  const resultsListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    resultsListRef.current
      ?.querySelector('.canvas-result-row.status-running')
      ?.scrollIntoView({ block: 'nearest' })
  }, [spans])
  /** 结果面板里手动折叠过的节点（用户显式收起 → 不再自动展开）。 */
  const manualCollapseRef = useRef<Set<string>>(new Set())
  // 新一轮 run（runState 非 running → running 边沿）清空上一轮的折叠
  // 记忆 —— 语义等同拆分前页面在 handleRun/旁观挂载时的 clear()：
  // 同一 flow 重跑 nodeId 不变，记忆跨轮残留会让上一轮收起的行
  // 在新一轮不再自动展开。
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (runState === 'running' && !wasRunningRef.current) {
      manualCollapseRef.current.clear()
      setIoOpen(null)
    }
    wasRunningRef.current = runState === 'running'
  }, [runState])
  // 摘要视图元数据底行的展开态（2026-09-06）：输入/原始数据一次只开一个
  const [ioOpen, setIoOpen] = useState<{ id: string; kind: 'input' | 'raw' } | null>(null)
  // 结果面板视图（2026-09-06 终端视图 PRD；2026-10-01 增轨迹视图）：
  // 摘要（默认，策展卡片）/ 终端（保真回放，span-writer events 全量过程
  // 日志的单流渲染）/ 轨迹（节点泳道时间线 + 事件台账 + Inspector，参考
  // deepseek-harness Trajectory）。用户裁决：切换式而非替换默认；记忆在
  // localStorage。
  const [resultView, setResultView] = useState<'summary' | 'terminal' | 'trace'>(() => {
    try {
      const v = window.localStorage.getItem('dagents.canvas.resultView')
      return v === 'terminal' || v === 'trace' ? v : 'summary'
    } catch {
      return 'summary'
    }
  })
  const switchResultView = useCallback((v: 'summary' | 'terminal' | 'trace'): void => {
    setResultView(v)
    try {
      window.localStorage.setItem('dagents.canvas.resultView', v)
    } catch { /* 无 localStorage 则仅内存切换 */ }
  }, [])
  /** 聚合区行内「终端」入口（AC-R6-5）：切终端视图 + 下一帧滚到目标段
   *  （run-terminal SectionView 根元素的 data-terminal-section={nodeId} 锚点；
   *  双 rAF 等 React 提交 + 浏览器布局后滚动；段缺失时仅完成视图切换）。 */
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const jumpToTerminalSection = useCallback(
    (nodeId: string): void => {
      switchResultView('terminal')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const sel = `[data-terminal-section="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(nodeId) : nodeId}"]`
          panelRootRef.current?.querySelector(sel)?.scrollIntoView({ block: 'start' })
        })
      })
    },
    [switchResultView],
  )
  // 挂起应答输入态（awaiting bar 受控）：提交回执 true 才清空
  const [answerText, setAnswerText] = useState('')
  const [answerBusy, setAnswerBusy] = useState(false)
  const submitAnswer = useCallback(async (): Promise<void> => {
    const answer = answerText.trim()
    if (!answer || answerBusy) return
    setAnswerBusy(true)
    try {
      if (await onSubmitAnswer(answer)) setAnswerText('')
    } finally {
      setAnswerBusy(false)
    }
  }, [answerText, answerBusy, onSubmitAnswer])

  const latestSpans = spans

  // run 摘要行（2026-10-09 设计重构）：状态 + 总耗时 + tokens 合计 +
  // 谱系继承（暖缓存时）。完成态用户最想看的三个数字第一眼可见——
  // 此前散落在各行 meta 里要自己加总。
  const runSummary = (() => {
    const times = latestSpans
      .flatMap((sp) => [sp.startedAt ? Date.parse(sp.startedAt) : NaN, sp.finishedAt ? Date.parse(sp.finishedAt) : NaN])
      .filter((n) => !Number.isNaN(n))
    const totalMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null
    let inputTokens = 0
    let outputTokens = 0
    let hasTokens = false
    for (const sp of latestSpans) {
      const u = sp.tokens as { inputTokens?: number; outputTokens?: number } | null
      if (u && (u.inputTokens != null || u.outputTokens != null)) {
        inputTokens += u.inputTokens ?? 0
        outputTokens += u.outputTokens ?? 0
        hasTokens = true
      }
    }
    const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    return {
      duration:
        totalMs != null && totalMs > 0
          ? totalMs >= 100_000
            ? `${Math.round(totalMs / 60_000)}m ${Math.round((totalMs % 60_000) / 1000)}s`
            : `${(totalMs / 1000).toFixed(1)}s`
          : null,
      tokens: hasTokens ? `↑${fmt(inputTokens)} ↓${fmt(outputTokens)}` : null,
      dual: dualBasisTokens(latestSpans, lineageTokens),
    }
  })()
  return (
    <div
      ref={panelRootRef}
      className={`canvas-results-panel${resultView === 'trace' ? ' wide' : ''}`}
      role='region'
      aria-label={t('运行结果')}
    >
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
      <div className='canvas-results-title'>
        {/* Row 1 · run 摘要行（2026-10-09 设计重构）：状态点 + 状态词 +
            总耗时 + tokens 合计（+ 谱系继承）——读面第一行给全局结论；
            动作全部降权到 Row 2 右侧。 */}
        <div className='canvas-results-meta'>
          <span
            className={`canvas-results-meta-dot dot-${runState === 'done' ? 'done' : runState === 'failed' ? 'failed' : runState === 'running' ? 'running' : runState === 'awaiting' ? 'warn' : runState === 'stopped' ? 'warn' : 'unknown'}`}
            aria-hidden='true'
          />
          <span className='canvas-results-meta-state'>
            {runState === 'running'
              ? t('运行中')
              : runState === 'awaiting'
                ? t('待输入')
                : runState === 'failed'
                  ? t('运行失败')
                  : runState === 'stopped'
                    ? t('已停止')
                    : t('运行完成')}
          </span>
          {runSummary.duration ? (
            <>
              <span className='canvas-results-meta-sep'>·</span>
              <span className='canvas-results-meta-num tnum'>{runSummary.duration}</span>
            </>
          ) : null}
          {runSummary.tokens ? (
            <>
              <span className='canvas-results-meta-sep'>·</span>
              <span className='canvas-results-meta-num tnum'>{runSummary.tokens}</span>
            </>
          ) : null}
          {runSummary.dual && runSummary.dual.inherited > 0 ? (
            <span
              className='canvas-results-meta-inherited tnum'
              title={t('谱系继承 = 前驱 runs 的累计用量（含本 run 复用的缓存产出）')}
            >
              ⇠ {t('谱系继承')} {runSummary.dual.inherited >= 1000 ? `${(runSummary.dual.inherited / 1000).toFixed(1)}k` : runSummary.dual.inherited}
            </span>
          ) : null}
          <button
            type='button'
            className='canvas-results-close'
            aria-label={t('关闭')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {/* Row 2 · 工具行：tab 组居左（真正的导航），动作簇居右降权
            （ghost 描边按钮，hover 才上色）——此前黄底重跑按钮是全行
            视觉最重的元素，喧宾夺主。 */}
        <div className='canvas-results-toolbar'>
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
            type="button"
            role="tab"
            aria-selected={resultView === 'terminal'}
            className={`canvas-results-view-btn${resultView === 'terminal' ? ' active' : ''}`}
            onClick={() => switchResultView('terminal')}
            title={t('以终端形式查看完整过程（thinking/工具调用/输出全文）')}
          >
            {t('终端')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={resultView === 'trace'}
            className={`canvas-results-view-btn${resultView === 'trace' ? ' active' : ''}`}
            onClick={() => switchResultView('trace')}
            title={t('节点泳道时间线 + 事件台账：按时间轴查看执行轨迹与过程事件')}
          >
            {t('轨迹')}
          </button>
          </span>
          <span className='canvas-results-actions'>
          {/* 停止（PM 走查 2026-09-20）：监控中心缺停止入口 ——
              运行中可在面板内直接中止，轮询收敛为已取消。 */}
          {runState === 'running' ? (
            <button
              type='button'
              className='canvas-results-rerun canvas-results-stop'
              onClick={() => void onCancel()}
              title={t('中止本次运行')}
            >
              {t('停止')}
            </button>
          ) : null}
          {/* 断点续跑（2026-09-18 §6.6；R3 扩 stopped）：失败/中止 +
              checkpoint resumable → 从此处继续（提交走 resume 端点，种子
              跳过已完成节点；stopped(interrupted) 的恢复入口，AC-R1-6）。 */}
          {(runState === 'failed' || runState === 'stopped') && resumeInfo ? (
            <button
              type='button'
              className='canvas-results-rerun canvas-results-resume'
              onClick={onResume}
              title={t('跳过 {n} 个已完成节点，从失败处继续', { n: String(resumeInfo.completedCount) })}
            >
              {t('从此处继续')}（{t('跳过 {n} 个节点', { n: String(resumeInfo.completedCount) })}）
            </button>
          ) : null}
          {/* 终态「重跑」分叉（2026-10-07 R2，design-recover §4.2）：默认
              「暖缓存重跑」——修了某个节点后未受影响的前缀子图零调用命中
              （⚡ cached 徽章）；「全新重跑」零缓存全量执行。 */}
          {runState === 'failed' || runState === 'done' || runState === 'stopped' || runState === 'idle' ? (
            <>
              <button
                type='button'
                className='canvas-results-rerun canvas-results-warm'
                onClick={() => onRerun('warm')}
                title={t('复用谱系链上未受影响节点的产出（⚡ 命中零调用），只重跑改过的部分')}
              >
                ⚡ {t('暖缓存重跑')}
              </button>
              <button
                type='button'
                className='canvas-results-rerun'
                onClick={() => onRerun('fresh')}
                title={t('用相同输入重跑（可修改后提交）')}
              >
                {t('全新重跑')}
              </button>
            </>
          ) : null}
          {/* 双锚点 P1（2026-09-19）：失败 + 目录锚 → 深链终端排查；
              本会话发起用输入面板目录，旁观 run 用 node-spans 回传锚；
              解析不到目录不渲染（不回落主目录）。 */}
          {runState === 'failed' && terminalDirId ? (
            <Link
              href={terminalHrefForDir(terminalDirId)}
              className='canvas-results-rerun'
            >
              {t('在项目目录打开终端')}
            </Link>
          ) : null}
          </span>
        </div>
      </div>
      {/* run 级失败横幅（2026-09-22）：零 span 的整体失败（拓扑成环/启动
          即挂）没有任何节点行可看，这里是失败原因的唯一落点；摘要与终端
          两个视图共用（置于标题下、视图体之上）。 */}
      {runError ? (
        <div className='canvas-results-run-error' role='alert'>
          <span className='canvas-results-run-error-head'>
            {t('运行失败')}
            {latestSpans.length === 0 ? ` · ${t('未执行任何节点')}` : ''}
          </span>
          <span className='canvas-results-run-error-text'>{runError}</span>
        </div>
      ) : null}
      {/* token 双口径已并入标题 meta 行（2026-10-09 设计重构）：谱系继承
          作为 ⇠ chip 展示，本次新增与合计由 meta 行 tokens（= 账单口径）
          承担——独立一行在小 run 上是噪音。 */}
      {runState === 'running' || runState === 'awaiting' ? (
        /* 状态行结构化（2026-09-19 走查优化点 1-3）：长句改为指标行
           「运行中 · n/m · 失败 k · ⏱ 12.4s」+ 迷你进度条 —— 总耗时
           此前完全缺失，是盯面板用户最想知道的数字；正在执行的节点
           名由列表中 running 行的高亮承担，不再重复此处。
           2026-09-20：延展到挂起态（待输入 · 进度冻结 · 耗时继续）。 */
        <div className={`canvas-results-live${runState === 'awaiting' ? ' awaiting' : ''}`}>
          <div className='canvas-results-live-line'>
            <span className='canvas-results-live-state'>
              {runState === 'awaiting' ? t('⏸ 待输入') : t('运行中')}
            </span>
            <span className='canvas-results-live-sep'>·</span>
            {(() => {
              const doneN = latestSpans.filter(
                (sp) => sp.status === 'done' || sp.status === 'completed',
              ).length
              const failedN = latestSpans.filter((sp) => sp.status === 'failed').length
              // 分母 = 流程总节点数（totalNodes），不是已出现的 span 数 ——
              // 早期只有 1-2 个 span，用 span 数会把 5 节点流程显示成「1/2」，
              // 跑着跑着分母再变大，非常误导。
              const total = totalNodes
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
      {resultView === 'trace' ? (
        /* 轨迹视图（2026-10-01）：节点泳道时间线 + 事件台账 + Inspector。
            数据源与终端视图同款降级阶梯——live 帧模型优先（执行序 + 帧
            级 at 时间戳），否则 DB spans 快照推导。 */
        (() => {
          const liveTrace =
            runLive.mode === 'live' || runLive.mode === 'closed' ? runLive.trace : null
          const traceModel =
            liveTrace != null && liveTrace.nodes.length > 0
              ? liveTrace
              : buildTraceFromSpans(latestSpans)
          return (
            <CanvasTraceView
              runState={runState}
              model={traceModel}
              spans={latestSpans}
            />
          )
        })()
      ) : resultView === 'terminal' ? (
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
          // stdin 行活跃节点（R8.5，§4.2）：同节点多并发实例（并发 iteration）
          // 显示 `nodeId[ordinal]` 区分——多实例时 id 编码 `nodeId#ordinal`
          // （插话寻址后缀，页面 sendMessage 解析）、label 带 [ordinal]；
          // 单实例（ordinal 0/缺席）保持裸 nodeId。
          const activeNodes = liveActive
            ? runLive.sections
                .filter((s) => s.status === 'running')
                .map((s) => ({
                  id: s.ordinal != null && s.ordinal > 0 ? `${s.id}#${s.ordinal}` : s.id,
                  label:
                    s.ordinal != null && s.ordinal > 0
                      ? `${s.title || s.id}[${s.ordinal}]`
                      : s.title || s.id,
                }))
            : latestSpans
                .filter((sp) => sp.status === 'running')
                .map((sp) => ({
                  id:
                    sp.ordinal != null && sp.ordinal > 0 ? `${sp.nodeId}#${sp.ordinal}` : sp.nodeId,
                  label:
                    sp.ordinal != null && sp.ordinal > 0
                      ? `${sp.nodeLabel || sp.nodeId}[${sp.ordinal}]`
                      : sp.nodeLabel || sp.nodeId || '?',
                }))
          return (
            <RunTerminal
              sections={sections}
              running={runState === 'running'}
              inputSupported={inputSupported}
              activeNodes={activeNodes}
              onSend={onSend}
              // stdin 行「重跑」（2026-10-07 R2）：默认暖缓存（§4.2 终端行
              // 同款——打开输入面板，提交按 warmFromRunId 谱系匹配）。
              onRerun={() => onRerun('warm')}
            />
          )
        })()
      ) : (
      <>
      {/* 产出清单聚合区（R6 渐进产物）：只在有聚合增益时渲染（2026-10-09
          设计重构）——小 run 上它与逐节点行 1:1 重复，白占 40% 高度。门槛：
          ≥4 项 / 失败停止挂起（未执行标注有价值）/ 聚合条目（迭代 ordinal /
          子流程归属 / 谱系继承）。 */}
      {deliverables != null &&
      (deliverables.length >= 4 ||
        runState === 'failed' ||
        runState === 'stopped' ||
        runState === 'awaiting' ||
        deliverables.some(
          (d) => d.ordinal > 0 || d.subflowName != null || d.inheritedFromRunId != null,
        )) ? (
        <DeliverablesCard
          runId={runId}
          deliverables={deliverables}
          flowNodes={flowNodes}
          spans={spans}
          topoOrder={topoOrder}
          runState={runState}
          awaitingInfo={awaitingInfo}
          onJumpToTerminal={jumpToTerminalSection}
        />
      ) : null}
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
              // 2026-10-07 工程决策 9d：声明型超限拒绝（迭代超限/子流程超深/
              // retries≥1 耗尽）——终态黄警档（可重试），run 走 partial_success。
              const terminal =
                st === 'done' || st === 'completed' || st === 'failed' || st === 'warn' || st === 'rejected'
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
                  open={st === 'failed' || st === 'warn' || st === 'rejected' || st === 'cached' || autoOpen || undefined}
                  onToggle={(e) => {
                    // 手动收起 → 记住，不再自动展开
                    if (!(e.target as HTMLDetailsElement).open) manualCollapseRef.current.add(id)
                  }}
                >
                  <summary>
                    <span className={`canvas-result-dot dot-${st}`} aria-hidden='true' />
                    <span className='canvas-result-label'>{sp.nodeLabel || id}</span>
                    {/* 失败原因优先占摘要列（2026-09-22 密度重构）：错因
                        首行进折叠行，不必展开就能扫「哪里错、为什么错」。 */}
                    {st === 'failed' && sp.error ? (
                      <span className='canvas-result-err-inline' title={sp.error}>{oneLine(sp.error, 96)}</span>
                    ) : st === 'rejected' && sp.error ? (
                      <span className='canvas-result-err-inline' title={sp.error}>{oneLine(sp.error, 96)}</span>
                    ) : display && display.preview && st !== 'running' ? (
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
                      ) : st === 'rejected' ? (
                        <>⏸ {t('已拒绝（可重试）')}{sp.durationMs != null ? ` · ${(sp.durationMs / 1000).toFixed(1)}s` : ''}</>
                      ) : st === 'running' ? (
                        // 实时已耗时（优化点 2）：LiveElapsed 自带秒级心跳，逐秒跳动
                        <>{t('运行中')} · <LiveElapsed startedAt={sp.startedAt} /></>
                      ) : st === 'failed' ? (
                        <>{t('失败')}{sp.durationMs != null ? ` · ${(sp.durationMs / 1000).toFixed(1)}s` : ''}</>
                      ) : st === 'cached' ? (
                        // R2（§4.2）：暖缓存/种子命中——独立徽章标注（AC-R2-2）。
                        // 继承前驱短码的数据链（journal lineage → spans）随集成期补。
                        <>⚡ {t('来自缓存')}</>
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
      </>
      )}
    </div>
  )
}
