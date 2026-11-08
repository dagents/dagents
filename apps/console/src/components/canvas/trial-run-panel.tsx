'use client'

/**
 * TrialRunPanel —— 画布试运行配置面板（R10，design-sharp §4.2/§4.5）。
 *
 * 区块：选中范围提示 / 运行输入 / 外部上游种子（预填最近正式 run 输出）/
 * mock 规则编辑（谓词 + 响应，零新组件库）/ http 真发勾选（默认跳过黄警）/
 * 预供 HumanInput 答案 / 启动。启动后页面接管既有 watch/结果面板（本面板
 * 关闭），证据区（mock 命中 + 收到的 prompt + 未解析占位符计数）在
 * startedRunId 就绪后渲染——辅源 /trial-calls 404 时诚实回退标注。
 */
import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '@/i18n'
import type { TrialMockCall, TrialMockScriptSet } from '@dagents/contracts'
import './trial-run-panel.css'

export interface TrialPanelProps {
  flowName: string
  selectedNodeId: string | null
  externalUpstreams: string[]
  seedDefaults: Record<string, string>
  seedLoading: boolean
  starting: boolean
  startError: string | null
  rejectError: { message: string; nodes: string[] } | null
  startedRunId: string | null
  onStart: (input: {
    input: string
    httpMode: 'skip' | 'real'
    seedInputs: Record<string, string>
    humanInputs: Record<string, string>
    mockScript?: TrialMockScriptSet
  }) => void
  onClose: () => void
}

type PredicateKey =
  'userContains' | 'systemContains' | 'messagesContain' | 'toolResultContains' | 'modelIs'

interface RuleDraft {
  key: PredicateKey
  value: string
  text: string
  mode: 'ok' | 'error' | 'malformed' | 'empty' | 'toolLoop'
}

const PREDICATE_KEYS: PredicateKey[] = [
  'userContains',
  'systemContains',
  'messagesContain',
  'toolResultContains',
  'modelIs',
]

export function TrialRunPanel(props: TrialPanelProps): React.ReactElement {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [seedInputs, setSeedInputs] = useState<Record<string, string>>({})
  const [httpReal, setHttpReal] = useState(false)
  const [fallbackText, setFallbackText] = useState('')
  const [rules, setRules] = useState<RuleDraft[]>([])
  const [humanRows, setHumanRows] = useState<Array<{ prompt: string; answer: string }>>([])
  const [calls, setCalls] = useState<TrialMockCall[] | null>(null)
  const [callsState, setCallsState] = useState<'idle' | 'loading' | 'lost'>('idle')

  // 种子默认值到达后预填（用户可改——手填优先于默认）。
  useEffect(() => {
    setSeedInputs((prev) => {
      const next = { ...prev }
      for (const [k, v] of Object.entries(props.seedDefaults)) {
        if (next[k] === undefined) next[k] = v
      }
      return next
    })
  }, [props.seedDefaults])

  // 证据区：startedRunId 后拉 trial-calls（404 = 网关重启丢失，诚实回退）。
  const startedRunId = props.startedRunId
  useEffect(() => {
    if (!startedRunId) return
    let cancelled = false
    setCallsState('loading')
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(startedRunId)}/trial-calls`)
        if (cancelled) return
        if (res.status === 404) {
          setCalls(null)
          setCallsState('lost')
          return
        }
        const json = (await res.json()) as { data?: { calls?: TrialMockCall[] } }
        setCalls(json.data?.calls ?? [])
        setCallsState('idle')
      } catch {
        if (!cancelled) setCallsState('lost')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [startedRunId])

  const start = (): void => {
    const mockScript: TrialMockScriptSet | undefined =
      rules.length > 0 || fallbackText.trim().length > 0
        ? {
            default: {
              rules: rules
                .filter((r) => r.value.trim().length > 0)
                .map((r) => ({
                  match: { [r.key]: r.value },
                  respond: { mode: r.mode, ...(r.mode === 'ok' ? { text: r.text } : {}) },
                })),
              ...(fallbackText.trim().length > 0 ? { fallback: { text: fallbackText } } : {}),
            },
          }
        : undefined
    const humanInputs: Record<string, string> = {}
    for (const row of humanRows) {
      if (row.prompt.trim().length > 0) humanInputs[row.prompt] = row.answer
    }
    props.onStart({
      input,
      httpMode: httpReal ? 'real' : 'skip',
      seedInputs,
      humanInputs,
      ...(mockScript ? { mockScript } : {}),
    })
  }

  const unresolvedTotal = useMemo(
    () => (calls ?? []).reduce((n, c) => n + (c.unresolvedPlaceholders?.length ?? 0), 0),
    [calls],
  )

  return (
    <div className="trial-panel-backdrop" role="dialog" aria-label={t('试运行')}>
      <div className="trial-panel">
        <div className="trial-panel-head">
          <strong>
            {props.selectedNodeId
              ? t('试运行此节点') + ` · ${props.selectedNodeId}`
              : t('试运行全图') + ` · ${props.flowName}`}
          </strong>
          <button type="button" className="trial-panel-close" onClick={props.onClose}>
            ×
          </button>
        </div>

        <label className="trial-field">
          <span>{t('运行输入（{{$start.input}}）')}</span>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            placeholder={t('试运行的模拟输入')}
          />
        </label>

        {props.externalUpstreams.length > 0 && (
          <div className="trial-field">
            <span>
              {t('外部上游输入（选中集外的入边来源）')}
              {props.seedLoading ? ` · ${t('正在查找最近一次运行的输出…')}` : ''}
            </span>
            {props.externalUpstreams.map((id) => (
              <label key={id} className="trial-seed-row">
                <code>{id}</code>
                <textarea
                  value={seedInputs[id] ?? ''}
                  onChange={(e) => setSeedInputs({ ...seedInputs, [id]: e.target.value })}
                  rows={2}
                  placeholder={t('该上游节点的输出种子（留空 = 空串）')}
                />
              </label>
            ))}
            <small>{t('默认预填最近一次正式运行中该节点的输出；试运行不写正式历史与账单。')}</small>
          </div>
        )}

        <div className="trial-field">
          <span>{t('Mock 规则（按序匹配，命中即应答）')}</span>
          {rules.map((r, i) => (
            <div key={i} className="trial-rule-row">
              <select
                value={r.key}
                onChange={(e) => {
                  const next = [...rules]
                  next[i] = { ...r, key: e.target.value as PredicateKey }
                  setRules(next)
                }}
              >
                {PREDICATE_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                value={r.value}
                onChange={(e) => {
                  const next = [...rules]
                  next[i] = { ...r, value: e.target.value }
                  setRules(next)
                }}
                placeholder={t('谓词值（子串/模型名）')}
              />
              <select
                value={r.mode}
                onChange={(e) => {
                  const next = [...rules]
                  next[i] = { ...r, mode: e.target.value as RuleDraft['mode'] }
                  setRules(next)
                }}
              >
                <option value="ok">ok</option>
                <option value="error">error</option>
                <option value="malformed">malformed</option>
                <option value="empty">empty</option>
                <option value="toolLoop">toolLoop</option>
              </select>
              <textarea
                value={r.text}
                onChange={(e) => {
                  const next = [...rules]
                  next[i] = { ...r, text: e.target.value }
                  setRules(next)
                }}
                rows={2}
                placeholder={t('应答文本（scripted 输出）')}
                disabled={r.mode !== 'ok'}
              />
              <button
                type="button"
                className="trial-rule-remove"
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="trial-rule-add"
            onClick={() =>
              setRules([...rules, { key: 'userContains', value: '', text: '', mode: 'ok' }])
            }
          >
            + {t('添加规则')}
          </button>
          <label className="trial-fallback">
            <span>{t('兜底应答（无规则命中时）')}</span>
            <textarea
              value={fallbackText}
              onChange={(e) => setFallbackText(e.target.value)}
              rows={1}
              placeholder="mock:unmatched"
            />
          </label>
        </div>

        <label className="trial-check">
          <input
            type="checkbox"
            checked={httpReal}
            onChange={(e) => setHttpReal(e.target.checked)}
          />
          {t('真实发送请求（http 节点）')}
        </label>
        {!httpReal && (
          <small className="trial-hint">
            ⚠ {t('默认跳过：http 节点不发真实请求，输出带「试运行」标注。')}
          </small>
        )}

        <div className="trial-field">
          <span>{t('预供 HumanInput 答案（可选）')}</span>
          {humanRows.map((row, i) => (
            <div key={i} className="trial-human-row">
              <input
                value={row.prompt}
                onChange={(e) => {
                  const next = [...humanRows]
                  next[i] = { ...row, prompt: e.target.value }
                  setHumanRows(next)
                }}
                placeholder={t('提示语（prompt，精确匹配）')}
              />
              <input
                value={row.answer}
                onChange={(e) => {
                  const next = [...humanRows]
                  next[i] = { ...row, answer: e.target.value }
                  setHumanRows(next)
                }}
                placeholder={t('预供答案')}
              />
              <button
                type="button"
                className="trial-rule-remove"
                onClick={() => setHumanRows(humanRows.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="trial-rule-add"
            onClick={() => setHumanRows([...humanRows, { prompt: '', answer: '' }])}
          >
            + {t('添加答案')}
          </button>
          <small>{t('未预供答案的 HumanInput 将挂起（试运行不支持挂起应答）。')}</small>
        </div>

        {props.rejectError && (
          <div className="trial-error">
            <div>{t(props.rejectError.message)}</div>
            {props.rejectError.nodes.length > 0 && (
              <ul>
                {props.rejectError.nodes.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    <code>{n}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {props.startError && (
          <div className="trial-error">
            {t('启动失败')}：{props.startError}
          </div>
        )}

        <div className="trial-actions">
          <button type="button" onClick={props.onClose}>
            {t('取消')}
          </button>
          <button type="button" className="trial-start" disabled={props.starting} onClick={start}>
            {props.starting ? t('启动中…') : `⚡ ${t('开始试运行')}`}
          </button>
        </div>

        {props.startedRunId && (
          <div className="trial-evidence">
            <div className="trial-evidence-head">
              {t('试运行证据')} · <code>{props.startedRunId.slice(0, 8)}</code>
              {unresolvedTotal > 0 && (
                <span className="trial-evidence-warn">
                  ⚠ {t('未解析占位符 {n} 处', { n: unresolvedTotal })}
                </span>
              )}
            </div>
            {callsState === 'lost' ? (
              <small>
                {t('进程内证据已随网关重启丢失，spans 仍可查（结果面板逐节点输入/输出）。')}
              </small>
            ) : calls === null ? (
              <small>{t('加载中…')}</small>
            ) : calls.length === 0 ? (
              <small>{t('暂无 mock 调用记录')}</small>
            ) : (
              <ul className="trial-calls">
                {calls.map((c) => (
                  <li key={c.seq}>
                    <div>
                      #{c.seq} {c.nodeId ? <code>{c.nodeId}</code> : ''} · {t('命中')}：
                      {c.matchedRule ?? '—'}
                      {c.unresolvedPlaceholders && c.unresolvedPlaceholders.length > 0 && (
                        <span className="trial-evidence-warn">
                          {' '}
                          ⚠ {t('未解析')}：{c.unresolvedPlaceholders.slice(0, 3).join('、')}
                        </span>
                      )}
                    </div>
                    <pre>
                      {(c.messages ?? [])
                        .map((m) => {
                          const msg = m as { role?: string; content?: string }
                          return `[${msg.role ?? '?'}] ${msg.content ?? ''}`
                        })
                        .join('\n')
                        .slice(0, 1200)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
