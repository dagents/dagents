'use client'

import { memo } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { getNodeMeta } from '@dagents/workflow'
import { NodeIcon } from './node-icon'
import { STATUS_COLORS, STATUS_LABELS, type FlowNodeData } from './types'

/**
 * Flowise 风格节点卡片:
 * - 左侧 4px 分类色带
 * - 头部:图标方块(分类色背景)+ 标题 + 节点类型标签
 * - 描述行(灰字,1 行省略)
 * - 底部:右侧状态点 + 状态文字 + 耗时
 * - 选中态:边框高亮 + 阴影
 * - 运行态:边框脉动动画
 */
function CustomNodeComponent({ data, selected }: NodeProps<FlowNodeData>): React.ReactElement {
  const meta = getNodeMeta(data.name)
  const color = meta?.color ?? '#6b7280'
  const status = data.status ?? 'idle'
  const statusColor = STATUS_COLORS[status]
  const isRunning = status === 'running'

  return (
    <div
      style={{
        width: 220,
        borderRadius: 10,
        backgroundColor: 'var(--bg)',
        border: `1px solid ${selected ? color : 'var(--border)'}`,
        boxShadow: selected
          ? `0 0 0 3px ${color}22, 0 4px 12px rgba(0,0,0,0.06)`
          : '0 1px 3px rgba(0,0,0,0.04)',
        overflow: 'hidden',
        fontFamily: 'var(--font-body)',
        fontSize: 13,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        position: 'relative',
      }}
    >
      {/* 左侧分类色带 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          backgroundColor: color,
        }}
      />

      {/* 运行态脉动边框 */}
      {isRunning && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 10,
            border: `2px solid ${statusColor}`,
            pointerEvents: 'none',
            opacity: 0.5,
            animation: 'nodePulse 1.4s ease-in-out infinite',
          }}
        />
      )}

      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          background: 'var(--bg)',
          border: `2px solid ${color}`,
          left: -6,
        }}
      />

      {/* 头部 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px 10px 14px',
          borderBottom: '1px solid var(--border-soft)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            backgroundColor: color,
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <NodeIcon name={meta?.icon ?? 'Play'} size={15} color="#fff" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.label}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--meta)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              marginTop: 1,
            }}
          >
            {meta?.category ?? 'unknown'}
          </div>
        </div>
      </div>

      {/* 描述 */}
      {meta?.description && (
        <div
          style={{
            padding: '8px 12px 8px 14px',
            fontSize: 11,
            color: 'var(--muted)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {meta.description}
        </div>
      )}

      {/* 状态行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px 8px 14px',
          fontSize: 10,
          color: 'var(--meta)',
          borderTop: '1px solid var(--border-soft)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: statusColor,
            boxShadow: isRunning ? `0 0 0 3px ${statusColor}22` : 'none',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{STATUS_LABELS[status]}</span>
        {data.durationMs != null && data.durationMs > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--meta)' }}>
            {data.durationMs < 1000 ? `${data.durationMs}ms` : `${(data.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          background: 'var(--bg)',
          border: `2px solid ${color}`,
          right: -6,
        }}
      />

      <style>{`
        @keyframes nodePulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
      `}</style>
    </div>
  )
}

export const CustomNode = memo(CustomNodeComponent)
