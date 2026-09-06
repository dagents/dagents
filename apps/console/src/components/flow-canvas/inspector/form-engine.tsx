/**
 * 表单引擎 —— 注册表 INodeParams schema → 控件派发。
 * 控件类型封闭枚举（D3）：string / number / options / code / json。
 * options 空数组视为动态源（agentId → 平台 agents，model → providers+agents）。
 */

import { useEffect, useState } from 'react'
import type { INodeParams } from '@dagents/workflow'
import {
  FALLBACK_MODEL_OPTION,
  agentOptions,
  modelOptions,
  type OptionItem,
} from '../registry/option-providers'

export interface WidgetProps {
  param: INodeParams
  value: unknown
  variables: string[]
  onChange(value: unknown): void
}

export function FieldWidget({ param, value, variables, onChange }: WidgetProps) {
  switch (param.type) {
    case 'number':
      return <NumberWidget {...{ param, value, variables, onChange }} />
    case 'options':
      return <OptionsWidget {...{ param, value, variables, onChange }} />
    case 'code':
      return <CodeWidget param={param} value={value} variables={variables} onChange={onChange} />
    case 'json':
      return <JsonWidget {...{ param, value, variables, onChange }} />
    case 'string':
    default:
      return <StringWidget param={param} value={value} variables={variables} onChange={onChange} />
  }
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value)
}

function Label({ param }: { param: INodeParams }) {
  return (
    <label className="fc-field-label">
      {param.label ?? param.name}
      {param.required ? <span className="fc-field-required">*</span> : null}
    </label>
  )
}

function StringWidget({ param, value, variables, onChange }: WidgetProps) {
  const insert = (v: string) => {
    const cur = asString(value)
    onChange(cur ? `${cur} ${v}` : v)
  }
  return (
    <div className="fc-field">
      <Label param={param} />
      <div className="fc-field-row">
        <input
          className="fc-input"
          type="text"
          value={asString(value)}
          placeholder={param.description ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {param.acceptVariable && <VariableButton variables={variables} onInsert={insert} />}
      </div>
      {param.description && <div className="fc-field-desc">{param.description}</div>}
    </div>
  )
}

function NumberWidget({ value, onChange }: WidgetProps) {
  const [text, setText] = useState(asString(value))
  useEffect(() => setText(asString(value)), [value])
  return (
    <div className="fc-field">
      <div className="fc-field-row">
        <input
          className="fc-input"
          type="number"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // 清空存 undefined（而非 ''）—— 保持 number 字段类型不漂移
            const n = Number(e.target.value)
            onChange(e.target.value === '' ? undefined : Number.isFinite(n) ? n : e.target.value)
          }}
        />
      </div>
    </div>
  )
}

/** options：静态清单直出；空数组按字段名选动态源。 */
function OptionsWidget({ param, value, onChange }: WidgetProps) {
  const [dynamic, setDynamic] = useState<OptionItem[] | null>(null)
  const needsDynamic = !param.options || param.options.length === 0

  useEffect(() => {
    if (!needsDynamic) return
    let alive = true
    const load =
      param.name === 'agentId'
        ? agentOptions()
        : param.name === 'model'
          ? modelOptions()
          : Promise.resolve(null)
    load.then((items) => {
      if (alive && items) setDynamic(items)
    })
    return () => {
      alive = false
    }
  }, [needsDynamic, param.name])

  const current = asString(value)
  const items: OptionItem[] =
    needsDynamic
      ? dynamic ?? (param.name === 'model' ? [FALLBACK_MODEL_OPTION] : current ? [{ value: current, label: current }] : [])
      : param.options!.map((o) => ({ value: String(o.name), label: String(o.label ?? o.name) }))

  return (
    <div className="fc-field">
      <Label param={param} />
      <select
        className="fc-select"
        value={items.some((i) => i.value === current) ? current : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {needsDynamic && !dynamic ? '加载中…' : '请选择'}
        </option>
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
        {/* 当前值不在清单里（如 provider 已删）也要能显示，避免静默丢值 */}
        {current && !items.some((i) => i.value === current) && (
          <option value={current}>{current}</option>
        )}
      </select>
      {param.description && <div className="fc-field-desc">{param.description}</div>}
    </div>
  )
}

function CodeWidget({ param, value, variables, onChange }: WidgetProps) {
  const rows = typeof param.rows === 'number' ? param.rows : 4
  return (
    <div className="fc-field">
      <Label param={param} />
      <textarea
        className="fc-textarea fc-mono"
        rows={rows}
        value={asString(value)}
        placeholder={param.description ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {param.acceptVariable && (
        <div className="fc-field-row fc-field-row-end">
          <VariableButton
            variables={variables}
            onInsert={(v) => {
              const cur = asString(value)
              onChange(cur ? `${cur}\n${v}` : v)
            }}
          />
        </div>
      )}
      {param.description && <div className="fc-field-desc">{param.description}</div>}
    </div>
  )
}

/** json：编辑原文，合法时提交解析值，非法时保留原文并红框提示。 */
function JsonWidget({ param, value, onChange }: WidgetProps) {
  const [text, setText] = useState(() => asString(value))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setText(asString(value)), [value])

  const commit = (next: string) => {
    setText(next)
    const t = next.trim()
    if (t === '') {
      setError(null)
      onChange(undefined)
      return
    }
    try {
      onChange(JSON.parse(t))
      setError(null)
    } catch (err) {
      // 保留原文（不丢用户输入），标错由保存时拓扑校验兜底
      onChange(next)
      setError(String(err))
    }
  }

  const rows = typeof param.rows === 'number' ? param.rows : 4
  return (
    <div className="fc-field">
      <Label param={param} />
      <textarea
        className={`fc-textarea fc-mono${error ? ' is-invalid' : ''}`}
        rows={rows}
        value={text}
        onChange={(e) => commit(e.target.value)}
      />
      {error && <div className="fc-field-error">JSON 无效：{error}</div>}
      {param.description && <div className="fc-field-desc">{param.description}</div>}
    </div>
  )
}

/**
 * 变量插入 —— 把 {{var}} 追加进字段（比 tiptap mention 简单一个量级，
 * 覆盖同一需求）。
 */
function VariableButton({
  variables,
  onInsert,
}: {
  variables: string[]
  onInsert(v: string): void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="fc-varpicker">
      <button type="button" className="fc-varpicker-btn" title="插入变量" onClick={() => setOpen((v) => !v)}>
        {'{{ }}'}
      </button>
      {open && (
        <div className="fc-varpicker-pop">
          {variables.length === 0 && <div className="fc-varpicker-empty">无可用变量</div>}
          {variables.map((v) => (
            <button
              key={v}
              type="button"
              className="fc-varpicker-item"
              onClick={() => {
                onInsert(v)
                setOpen(false)
              }}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
