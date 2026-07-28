'use client'

import { useState, useEffect } from 'react'
import { getNodeMeta, type INodeParams } from '@dagents/workflow'
import { NodeIcon } from './node-icon'
import { STATUS_COLORS, STATUS_LABELS, type FlowNodeData } from './types'
import type { Node } from 'reactflow'

interface NodeInspectorProps {
  selectedNode: Node<FlowNodeData> | null
  onUpdateNode: (nodeId: string, data: Partial<FlowNodeData>) => void
  onDeleteNode: (nodeId: string) => void
}

export function NodeInspector({
  selectedNode,
  onUpdateNode,
  onDeleteNode,
}: NodeInspectorProps): React.ReactElement {
  const [localData, setLocalData] = useState<Record<string, unknown>>({})

  useEffect(() => {
    if (selectedNode) {
      setLocalData({ ...selectedNode.data })
    } else {
      setLocalData({})
    }
  }, [selectedNode?.id, selectedNode?.data])

  if (!selectedNode) {
    return (
      <div
        style={{
          width: 340,
          flexShrink: 0,
          borderLeft: '1px solid var(--border-soft)',
          backgroundColor: 'var(--surface-warm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div style={{ textAlign: 'center', color: 'var(--meta)' }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              border: '1.5px dashed var(--border)',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 12px',
              color: 'var(--meta)',
            }}
          >
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', marginBottom: 4 }}>
            未选中节点
          </div>
          <div style={{ fontSize: 11, color: 'var(--meta)', lineHeight: 1.5 }}>
            点击画布上的节点
            <br />
            查看和编辑属性
          </div>
        </div>
      </div>
    )
  }

  const meta = getNodeMeta(selectedNode.data.name)
  const color = meta?.color ?? '#6b7280'
  const status = selectedNode.data.status ?? 'idle'

  const handleLabelChange = (label: string) => {
    setLocalData((prev) => ({ ...prev, label }))
    onUpdateNode(selectedNode.id, { label })
  }

  const handleInputChange = (name: string, value: unknown) => {
    setLocalData((prev) => ({ ...prev, [name]: value }))
    onUpdateNode(selectedNode.id, { [name]: value })
  }

  const handleJsonChange = (name: string, value: string) => {
    try {
      const parsed = JSON.parse(value || '{}')
      setLocalData((prev) => ({ ...prev, [name]: parsed }))
      onUpdateNode(selectedNode.id, { [name]: parsed })
    } catch {
      setLocalData((prev) => ({ ...prev, [name]: value }))
    }
  }

  const renderInput = (param: INodeParams) => {
    const value = localData[param.name]
    const isJson = param.type === 'json'
    const stringValue = isJson
      ? typeof value === 'string'
        ? value
        : JSON.stringify(value ?? '', null, 2)
      : (value as string | number | boolean | undefined)

    const baseInputStyle: React.CSSProperties = {
      width: '100%',
      padding: '7px 10px',
      border: '1px solid var(--border-soft)',
      borderRadius: 6,
      backgroundColor: 'var(--bg)',
      color: 'var(--fg)',
      fontSize: 12,
      outline: 'none',
      transition: 'border-color 0.15s',
    }

    const handleFocus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      e.currentTarget.style.borderColor = 'var(--accent)'
    }
    const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      e.currentTarget.style.borderColor = 'var(--border-soft)'
    }

    switch (param.type) {
      case 'string':
        return (
          <input
            type="text"
            value={(stringValue as string) ?? ''}
            onChange={(e) => handleInputChange(param.name, e.target.value)}
            placeholder={param.placeholder}
            style={baseInputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        )
      case 'number':
        return (
          <input
            type="number"
            value={(stringValue as number) ?? ''}
            onChange={(e) => handleInputChange(param.name, e.target.value ? Number(e.target.value) : '')}
            placeholder={param.placeholder}
            style={baseInputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        )
      case 'boolean':
        return (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 0' }}>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(value)}
              onClick={() => handleInputChange(param.name, !value)}
              style={{
                width: 32,
                height: 18,
                borderRadius: 999,
                border: 'none',
                backgroundColor: value ? 'var(--accent)' : 'var(--border)',
                position: 'relative',
                cursor: 'pointer',
                transition: 'background-color 0.15s',
                padding: 0,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: value ? 16 : 2,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  backgroundColor: '#fff',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  transition: 'left 0.15s',
                }}
              />
            </button>
            <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>启用</span>
          </label>
        )
      case 'options':
        return (
          <select
            value={(stringValue as string) ?? ''}
            onChange={(e) => handleInputChange(param.name, e.target.value)}
            style={baseInputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          >
            <option value="">-- 请选择 --</option>
            {param.options?.map((opt) => (
              <option key={opt.name} value={opt.name}>
                {opt.label}
              </option>
            ))}
          </select>
        )
      case 'code':
      case 'json':
        return (
          <textarea
            value={(stringValue as string) ?? ''}
            onChange={(e) =>
              isJson
                ? handleJsonChange(param.name, e.target.value)
                : handleInputChange(param.name, e.target.value)
            }
            rows={param.rows ?? 4}
            placeholder={param.placeholder}
            style={{
              ...baseInputStyle,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              resize: 'vertical',
              lineHeight: 1.6,
              minHeight: 60,
            }}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        )
      default:
        return (
          <input
            type="text"
            value={(stringValue as string) ?? ''}
            onChange={(e) => handleInputChange(param.name, e.target.value)}
            style={baseInputStyle}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />
        )
    }
  }

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        borderLeft: '1px solid var(--border-soft)',
        backgroundColor: 'var(--surface-warm)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 头部:节点图标 + 标签 + 类型 */}
      <div
        style={{
          padding: 14,
          borderBottom: '1px solid var(--border-soft)',
          backgroundColor: 'var(--bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: color,
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <NodeIcon name={meta?.icon ?? 'Play'} size={16} color="#fff" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: color,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {meta?.label ?? 'Unknown'}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--meta)',
                marginTop: 2,
              }}
            >
              {selectedNode.id.slice(0, 18)}
            </div>
          </div>
        </div>
        <div>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--meta)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            节点名称
          </label>
          <input
            type="text"
            value={(localData.label as string) ?? ''}
            onChange={(e) => handleLabelChange(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid var(--border-soft)',
              borderRadius: 6,
              backgroundColor: 'var(--surface-warm)',
              color: 'var(--fg)',
              fontSize: 13,
              fontWeight: 500,
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-soft)'
            }}
          />
        </div>
      </div>

      {/* 状态行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          backgroundColor: 'var(--bg)',
          borderBottom: '1px solid var(--border-soft)',
          fontSize: 11,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: STATUS_COLORS[status],
            boxShadow: status === 'running' ? `0 0 0 3px ${STATUS_COLORS[status]}22` : 'none',
            flexShrink: 0,
          }}
        />
        <span style={{ color: 'var(--fg-2)', flex: 1 }}>{STATUS_LABELS[status]}</span>
        {selectedNode.data.durationMs != null && selectedNode.data.durationMs > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--meta)' }}>
            {selectedNode.data.durationMs < 1000
              ? `${selectedNode.data.durationMs}ms`
              : `${(selectedNode.data.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* 描述 */}
      {meta?.description && (
        <div
          style={{
            margin: 12,
            padding: '10px 12px',
            backgroundColor: 'var(--bg)',
            border: '1px solid var(--border-soft)',
            borderLeft: `3px solid ${color}`,
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--muted)',
            lineHeight: 1.6,
          }}
        >
          {meta.description}
        </div>
      )}

      {/* 参数列表 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px 14px' }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--meta)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            padding: '12px 0 8px',
          }}
        >
          参数 {meta?.inputs.length ?? 0}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {meta?.inputs.map((param) => (
            <div key={param.name}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--fg)',
                  marginBottom: 5,
                }}
              >
                <span>
                  {param.label}
                  {param.required && <span style={{ color: 'var(--danger, #ef4444)', marginLeft: 4 }}>*</span>}
                </span>
                {param.acceptVariable && (
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--meta)',
                      background: 'var(--surface-warm)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    var
                  </span>
                )}
              </label>
              {renderInput(param)}
              {param.description && (
                <div
                  style={{
                    marginTop: 5,
                    fontSize: 10,
                    color: 'var(--meta)',
                    lineHeight: 1.5,
                  }}
                >
                  {param.description}
                </div>
              )}
            </div>
          ))}
          {(!meta?.inputs || meta.inputs.length === 0) && (
            <div
              style={{
                padding: 20,
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--meta)',
              }}
            >
              该节点无可配置参数
            </div>
          )}
        </div>
      </div>

      {/* 底部删除按钮 */}
      <div
        style={{
          padding: 12,
          borderTop: '1px solid var(--border-soft)',
          backgroundColor: 'var(--bg)',
        }}
      >
        <button
          onClick={() => onDeleteNode(selectedNode.id)}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--danger-soft, #fecaca)',
            borderRadius: 6,
            backgroundColor: 'transparent',
            color: 'var(--danger, #ef4444)',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background-color 0.15s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--danger-soft, #fee2e2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
          删除节点
        </button>
      </div>
    </div>
  )
}
