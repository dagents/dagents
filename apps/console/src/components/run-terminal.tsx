'use client'

/**
 * RunTerminal —— 运行终端视图（2026-09-06 终端视图 PRD，docs/prd-run-terminal.md）。
 *
 * 「CLI agent 的运行结果以命令行的形式展现」的渲染端：把 run_node_spans 的
 * 全量过程日志（span-writer 的 events 通道）排成一条按节点分段的终端流 ——
 * 段头分隔线 + `$` 提示行 + 💭/🔧/↳ 事件行 + 成品正文。保真视图：全文
 * 直出、不截断；策展（单行预览、默认折叠一层、summary 视图）属于组件层。
 *
 * 与画布摘要面板的关系：切换视图（dagents.canvas.resultView 记忆），摘要
 * 面板保持默认 —— 终端是操作者视角的保真回放，不是替换。
 *
 * TerminalSurface 单独导出：chat 的 ProcessFold（过程折叠区）复用同一
 * 滚动跟随/回到底部交互，收敛两处「看 agent 干活」的体验。
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useI18n } from '@/i18n'
import { Icon, type IconName } from '@/components/icon'
import { ResultViewer } from '@/components/result-viewer'
import {
  sectionTranscript,
  type TerminalLine,
  type TerminalSection,
} from '@/lib/run-terminal-format'
import './run-terminal.css'

/** 单行截断（策展 —— 只作用于预览，展开即全文）。 */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** tool 参数 detail 尝试美化（compact JSON → 2 空格缩进），失败原样。 */
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/**
 * 滚动跟随容器：贴底时随内容增长自动跟随（终端 tail 语义），用户上翻即
 * 暂停跟随并露出「回到最新」。纯行为组件（.terminal-surface 不带皮肤），
 * 视觉由消费方的 className 决定（画布 .run-terminal / chat 既有样式）。
 * `initialPinned=false` 用于回放已完成的过程（2026-09-06 验收裁决）：
 * 读回放从顶部开始，tail 跟随只属于 live 场景。
 */
export function TerminalSurface({
  children,
  className,
  ariaLabel,
  surfaceRef,
  initialPinned = true,
}: {
  children: ReactNode
  className?: string
  ariaLabel?: string
  /** 把滚动容器暴露给消费方（chat 折叠区复制正文用）。 */
  surfaceRef?: Ref<HTMLDivElement>
  initialPinned?: boolean
}): React.ReactElement {
  const { t } = useI18n()
  const innerRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(initialPinned)

  const onScroll = (): void => {
    const el = innerRef.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  // 贴底跟随：内容每次变更（父组件重渲染）都检查一次 —— 无依赖数组是有意的
  useEffect(() => {
    const el = innerRef.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  })

  const jumpToLatest = (): void => {
    const el = innerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
  }

  return (
    <div
      ref={surfaceRef ?? innerRef}
      className={`terminal-surface${className ? ` ${className}` : ''}`}
      onScroll={onScroll}
      role='log'
      aria-label={ariaLabel}
      aria-live={pinned ? 'polite' : 'off'}
    >
      {children}
      {!pinned ? (
        <div className='rtl-jump-row'>
          <button type='button' className='rtl-jump' onClick={jumpToLatest}>
            <Icon name='arrowDown' style={{ width: 11, height: 11 }} />
            {t('回到最新')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 段头：`── 标题 · 状态 · 耗时 · tokens ──` 分隔线 + 本段复制。 */
function SectionHeader({ section }: { section: TerminalSection }): React.ReactElement {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const status =
    section.status === 'running'
      ? t('运行中')
      : section.status === 'done' || section.status === 'completed'
        ? t('完成')
        : section.status === 'failed'
          ? t('失败')
          : section.status
  const meta = [
    status,
    section.durationMs != null ? `${(section.durationMs / 1000).toFixed(1)}s` : '',
    section.tokensBadge ?? '',
  ]
    .filter(Boolean)
    .join(' · ')

  const copy = (): void => {
    void navigator.clipboard?.writeText(sectionTranscript(section)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className='rtl-sep' data-status={section.status}>
      <span className='rtl-sep-dash' aria-hidden='true'>──</span>
      <span className={`rtl-sep-dot dot-${section.status || 'unknown'}`} aria-hidden='true' />
      <span className='rtl-sep-title'>{section.title}</span>
      {meta ? <span className='rtl-sep-meta'>{meta}</span> : null}
      <span className='rtl-sep-line' aria-hidden='true' />
      <button
        type='button'
        className='rtl-copy'
        onClick={copy}
        title={t('复制本段过程实录')}
      >
        {copied ? t('已复制') : t('复制')}
      </button>
    </div>
  )
}

/** 事件行标记 → 统一 Icon 体系（2026-09-06 设计师裁决：去 emoji 文本标记）。
 *  画布摘要活动流（activityIcon）与 chat ToolCallCard 共用同一套语义映射。 */
export function lineIcon(kind: TerminalLine['kind']): IconName {
  switch (kind) {
    case 'thinking':
      return 'brain'
    case 'tool':
      return 'wrench'
    case 'tool_result':
      return 'cornerDownRight'
    case 'error':
      return 'alertTriangle'
    default:
      return 'point'
  }
}

/** 一行过程事件：💭 thinking（暗色折叠）/ 🔧 工具调用 / ↳ 工具结果 /
 *  ✗ 错误（红）/ · status·log（暗）。全文保真，预览单行策展。
 *  （行首标记已换统一 Icon —— 上方注释保留旧语义速读。） */
function LineView({ line }: { line: TerminalLine }): React.ReactElement | null {
  switch (line.kind) {
    case 'thinking':
      return (
        <details className='rtl-line rtl-thinking'>
          <summary>
            <span className='rtl-glyph'><Icon name='brain' style={{ width: 12, height: 12 }} /></span>
            <span className='rtl-label'>{oneLine(line.label, 100)}</span>
          </summary>
          <ResultViewer title={line.label} text={line.label}>
            <pre className='rtl-detail'>{line.label}</pre>
          </ResultViewer>
        </details>
      )
    case 'tool':
      return (
        <details className='rtl-line rtl-tool'>
          <summary>
            <span className='rtl-glyph'><Icon name='wrench' style={{ width: 12, height: 12 }} /></span>
            <span className='rtl-toolname'>{line.label}</span>
            {line.detail ? (
              <span className='rtl-argpreview'>{oneLine(line.detail, 90)}</span>
            ) : null}
          </summary>
          {line.detail ? (
            <ResultViewer title={line.label} text={prettyJson(line.detail)} mono>
              <pre className='rtl-detail'>{prettyJson(line.detail)}</pre>
            </ResultViewer>
          ) : null}
        </details>
      )
    case 'tool_result':
      return (
        <details className='rtl-line rtl-toolresult'>
          <summary>
            <span className='rtl-glyph'><Icon name='cornerDownRight' style={{ width: 12, height: 12 }} /></span>
            <span className='rtl-label'>
              {line.label ? `${line.label} · ` : ''}
              {oneLine(line.detail ?? '', 90)}
            </span>
          </summary>
          {line.detail ? (
            <ResultViewer title={line.label || 'result'} text={line.detail} mono>
              <pre className='rtl-detail'>{line.detail}</pre>
            </ResultViewer>
          ) : null}
        </details>
      )
    case 'error':
      return (
        <div className='rtl-line rtl-errorline'>
          <span className='rtl-glyph'><Icon name='alertTriangle' style={{ width: 12, height: 12 }} /></span>
          <span className='rtl-label'>{line.label}</span>
        </div>
      )
    case 'user_input':
      // 插话回显（2026-09-08 可操作终端）：❯ 与 `$` 同属终端字形惯例，
      // 高亮 accent —— 回放时「谁在何时对哪个节点说了什么」一眼可辨。
      return (
        <div className='rtl-line rtl-userline'>
          <span className='rtl-glyph' aria-hidden='true'>❯</span>
          <span className='rtl-label'>{line.label}</span>
        </div>
      )
    default:
      return (
        <div className='rtl-line rtl-dim'>
          <span className='rtl-glyph'><Icon name='point' style={{ width: 12, height: 12 }} /></span>
          <span className='rtl-label'>{line.label}</span>
        </div>
      )
  }
}

/** 一个节点段：段头 + `$` 提示行 + 事件行 + 成品正文。 */
function SectionView({ section }: { section: TerminalSection }): React.ReactElement {
  const { t } = useI18n()
  const running = section.status === 'running'
  return (
    <div className='rtl-section'>
      <SectionHeader section={section} />
      <div className='rtl-cmd'>{section.command}</div>
      {section.lines.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
      {section.output ? (
        <ResultViewer title={section.title} text={section.output}>
          <div className={`rtl-output${running ? ' streaming' : ''}`}>{section.output}</div>
        </ResultViewer>
      ) : null}
      {section.rawJson ? (
        <ResultViewer title={`${section.title} · ${t('产出')}`} text={section.rawJson} mono>
          <pre className='rtl-detail rtl-raw'>{section.rawJson}</pre>
        </ResultViewer>
      ) : null}
      {!section.output && !section.rawJson && section.lines.length === 0 ? (
        <div className='rtl-line rtl-dim'>{running ? t('（执行中…）') : t('（无产出）')}</div>
      ) : null}
      {section.error ? <div className='rtl-error'>{section.error}</div> : null}
    </div>
  )
}

/** 插话送达回执状态机（诚实三态 + 过渡态）。 */
type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; node: string }
  | { kind: 'refused'; reason: 'unsupported' | 'not_running' | 'error' }

export type TerminalSendResult = 'sent' | 'unsupported' | 'not_running' | 'error'

/**
 * stdin 行（2026-09-08 可操作终端 PRD）：终端视图底部钉一根输入行，真终端
 * 惯例 —— 常驻、`❯` 提示符、Enter 发送。状态机由 PRD §4.1 钉死：
 *   运行中 + 支持   → 输入行（多节点并行时目标 chip，默认第一个 running 节点）
 *   运行中 + 不支持 → 禁用 + 原因（HTTP provider 运行 / 旧网关）
 *   运行结束        → 原位变「重跑」入口（就近原则：⬆ 就在原地）
 * 送达语义不做假乐观：sent 才显示「已送达」，refused 如实给原因。
 */
export function TerminalInputBar({
  running,
  supported,
  targets,
  onSend,
  onRerun,
}: {
  running: boolean
  supported: boolean
  targets: Array<{ id: string; label: string }>
  onSend: (nodeId: string, text: string) => Promise<TerminalSendResult>
  onRerun?: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [targetId, setTargetId] = useState<string>('')
  const [state, setState] = useState<SendState>({ kind: 'idle' })

  // 目标默认跟随第一个 running 节点（单节点直连；并行时用户 chip 可改）
  useEffect(() => {
    if (targets.length > 0 && !targets.some((n) => n.id === targetId)) {
      setTargetId(targets[0]!.id)
    }
  }, [targets, targetId])

  // 送达回执短暂驻留后回 idle（发送行恢复可用）
  useEffect(() => {
    if (state.kind !== 'sent') return
    const timer = window.setTimeout(() => setState({ kind: 'idle' }), 2500)
    return () => window.clearTimeout(timer)
  }, [state])

  if (!running) {
    return (
      <div className='rti-bar rti-done'>
        <span className='rti-prompt' aria-hidden='true'>❯</span>
        <span className='rti-done-text'>{t('运行已结束')}</span>
        {onRerun ? (
          <button type='button' className='rti-rerun' onClick={onRerun}>
            <Icon name='refresh' style={{ width: 11, height: 11 }} />
            {t('重跑')}
          </button>
        ) : null}
      </div>
    )
  }

  if (!supported || targets.length === 0) {
    return (
      <div className='rti-bar rti-disabled'>
        <span className='rti-prompt' aria-hidden='true'>❯</span>
        <span className='rti-disabled-text'>
          {targets.length === 0
            ? t('（当前没有运行中的 CLI 节点）')
            : t('该运行不可插话 — 仅 CLI Agent 执行支持运行中输入')}
        </span>
      </div>
    )
  }

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || state.kind === 'sending') return
    const target = targets.find((n) => n.id === targetId) ?? targets[0]!
    setState({ kind: 'sending' })
    let result: TerminalSendResult = 'error'
    try {
      result = await onSend(target.id, body)
    } catch {
      result = 'error'
    }
    if (result === 'sent') {
      setText('')
      setState({ kind: 'sent', node: target.label || target.id })
    } else {
      setState({ kind: 'refused', reason: result === 'error' ? 'error' : result })
    }
  }

  const ack =
    state.kind === 'sent'
      ? t('已送达 {node}', { node: state.node })
      : state.kind === 'refused'
        ? state.reason === 'unsupported'
          ? t('当前执行路径不支持运行中插话')
          : state.reason === 'not_running'
            ? t('节点已结束，消息未送达')
            : t('发送失败')
        : null

  return (
    <div className='rti-bar rti-live'>
      <span className='rti-prompt' aria-hidden='true'>❯</span>
      {targets.length > 1 ? (
        <select
          className='rti-target'
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          aria-label={t('插话目标节点')}
        >
          {targets.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.id}
            </option>
          ))}
        </select>
      ) : null}
      <input
        className='rti-input'
        value={text}
        placeholder={t('对运行中的 Agent 补一句话（Enter 发送）…')}
        aria-label={t('运行中插话')}
        disabled={state.kind === 'sending'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {ack ? <span className={`rti-ack ack-${state.kind}`}>{ack}</span> : null}
    </div>
  )
}

/** 整条运行终端：按传入段序（调用方负责拓扑排序）单流渲染。
 *  运行中 tail 跟随；回放已完成的过程从顶部读起（initialPinned）。
 *  全量采集（events 通道）之前的旧运行降级显示 activity 摘要级内容 ——
 *  顶部如实提示，不冒充全量（2026-09-06）。
 *  传入 onSend/onRerun 时底部钉 stdin 行（可操作终端，2026-09-08）——
 *  chat ProcessFold 直接用 TerminalSurface，不受影响。 */
export function RunTerminal({
  sections,
  ariaLabel,
  running,
  inputSupported = true,
  activeNodes = [],
  onSend,
  onRerun,
}: {
  sections: TerminalSection[]
  ariaLabel?: string
  /** 运行中（stdin 行状态机驱动位；缺省按 sections 推导）。 */
  running?: boolean
  /** 插话能力位（node-spans inputSupported；undefined 按支持处理）。 */
  inputSupported?: boolean
  /** 当前 running 的节点（stdin 目标 chip 数据源）。 */
  activeNodes?: Array<{ id: string; label: string }>
  onSend?: (nodeId: string, text: string) => Promise<TerminalSendResult>
  onRerun?: () => void
}): React.ReactElement | null {
  const { t } = useI18n()
  if (sections.length === 0) return null
  const isRunning = running ?? sections.some((s) => s.status === 'running')
  const hasProcessData = sections.some((s) => s.lineSource !== 'none')
  const legacyRun = hasProcessData && sections.every((s) => s.lineSource !== 'events')
  const showBar = onSend != null || onRerun != null
  return (
    <div className='run-terminal-wrap'>
      <TerminalSurface
        className='run-terminal'
        ariaLabel={ariaLabel ?? t('运行终端')}
        initialPinned={isRunning}
      >
        {legacyRun ? (
          <div className='rtl-legacy-note'>{t('此运行早于全量过程采集（2026-09-06 之前）—— 终端视图显示摘要级内容')}</div>
        ) : null}
        {sections.map((s) => (
          <SectionView key={s.id} section={s} />
        ))}
      </TerminalSurface>
      {showBar ? (
        <TerminalInputBar
          running={isRunning}
          supported={inputSupported}
          targets={activeNodes}
          onSend={onSend ?? (async () => 'error')}
          onRerun={onRerun}
        />
      ) : null}
    </div>
  )
}
