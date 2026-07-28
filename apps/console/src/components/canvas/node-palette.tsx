'use client'

import { useMemo, useState } from 'react'
import { getNodesByCategory, NODE_CATEGORIES, type CanvasNodeMeta } from '@dagents/workflow'
import { NodeIcon } from './node-icon'

const CATEGORY_LABELS: Record<string, string> = {
  start: '起点',
  agent: '智能体',
  logic: '逻辑控制',
  tools: '工具',
  data: '数据',
  flow: '流程控制',
}

export function NodePalette(): React.ReactElement {
  const [search, setSearch] = useState('')
  const nodesByCategory = useMemo(() => getNodesByCategory(), [])

  const filteredCategories = useMemo(() => {
    const result: Record<string, CanvasNodeMeta[]> = {}
    const query = search.toLowerCase().trim()
    for (const [category, nodes] of Object.entries(nodesByCategory)) {
      const filtered = query
        ? nodes.filter(
            (node) =>
              node.label.toLowerCase().includes(query) ||
              node.name.toLowerCase().includes(query) ||
              (node.description ?? '').toLowerCase().includes(query),
          )
        : nodes
      if (filtered.length > 0) {
        result[category] = filtered
      }
    }
    return result
  }, [nodesByCategory, search])

  const handleDragStart = (event: React.DragEvent, node: CanvasNodeMeta) => {
    event.dataTransfer.setData('application/reactflow/type', 'agentFlow')
    event.dataTransfer.setData(
      'application/reactflow/data',
      JSON.stringify({
        name: node.name,
        label: node.label,
        ...node.defaultData,
      }),
    )
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        borderRight: '1px solid var(--border-soft)',
        backgroundColor: 'var(--surface-warm)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* 头部:标题 + 节点总数 */}
      <div
        style={{
          padding: '14px 16px 10px',
          borderBottom: '1px solid var(--border-soft)',
          backgroundColor: 'var(--bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>节点</div>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--meta)',
              background: 'var(--surface-warm)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            14
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder="搜索节点..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              height: 32,
              padding: '0 10px 0 30px',
              border: '1px solid var(--border-soft)',
              borderRadius: 6,
              backgroundColor: 'var(--surface-warm)',
              color: 'var(--fg)',
              fontSize: 12,
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
          <svg
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--meta)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ position: 'absolute', left: 9, top: 9, pointerEvents: 'none' }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
      </div>

      {/* 节点列表 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 16px' }}>
        {Object.entries(filteredCategories).length === 0 && (
          <div
            style={{
              padding: '40px 16px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--meta)',
            }}
          >
            未找到匹配的节点
          </div>
        )}
        {Object.entries(filteredCategories).map(([category, nodes]) => {
          const catInfo = NODE_CATEGORIES[category as keyof typeof NODE_CATEGORIES]
          const catColor = catInfo?.color ?? '#6b7280'
          return (
            <div key={category} style={{ marginBottom: 12 }}>
              <div
                style={{
                  padding: '10px 8px 6px',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--meta)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: catColor,
                  }}
                />
                {CATEGORY_LABELS[category] ?? category}
                <span style={{ color: 'var(--border)', fontFamily: 'var(--font-mono)' }}>
                  · {nodes.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {nodes.map((node) => (
                  <div
                    key={node.name}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 7,
                      cursor: 'grab',
                      backgroundColor: 'transparent',
                      border: '1px solid transparent',
                      transition: 'background-color 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--bg)'
                      e.currentTarget.style.borderColor = 'var(--border-soft)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                      e.currentTarget.style.borderColor = 'transparent'
                    }}
                  >
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        backgroundColor: node.color,
                        color: '#fff',
                        display: 'grid',
                        placeItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <NodeIcon name={node.icon} size={13} color="#fff" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--fg)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {node.label}
                      </div>
                      {node.description && (
                        <div
                          style={{
                            fontSize: 10,
                            color: 'var(--meta)',
                            marginTop: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {node.description}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 底部提示 */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border-soft)',
          fontSize: 10,
          color: 'var(--meta)',
          textAlign: 'center',
          backgroundColor: 'var(--bg)',
        }}
      >
        拖拽节点到画布
      </div>
    </div>
  )
}
