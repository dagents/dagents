/**
 * SkeletonList — shimmering placeholder for async list content.
 *
 * Renders a configurable number of skeleton rows. `shape` picks a preset that
 * mirrors the real card layout of the host list (PX-F09: 加载→渲染切换时无
 * 布局跳动)：
 *
 *   - 'list'      avatar + title 40% + subtitle + right meta chips (default,
 *                 daemons/skills/usage 行式列表)
 *   - 'flow-card' chev + glyph 方块 + 标题 40% + meta 圆点短条 + 右侧按钮块
 *   - 'agent-card' 头像圆 + 标题 40% + 描述条 + meta 圆点短条
 *
 * Shimmer 基座（.skeleton/.skeleton-text）在 shell.css；形状行样式与
 * 800ms shimmer 收紧在 flows.css 的 PX-F09 分区（本组件 import）。
 *
 * Usage:
 *   {loading ? <SkeletonList rows={5} shape="flow-card" /> : <ActualList items={data} />}
 */
import '@/styles/flows.css'

interface SkeletonListProps {
  /** Number of skeleton rows to render. */
  rows?: number
  /**
   * Row shape preset matching the real card layout of the host list.
   * @default 'list'
   */
  shape?: 'list' | 'flow-card' | 'agent-card'
  /**
   * @deprecated 与 shape 同义（历史 prop：'card' ≙ 'flow-card'）。
   * 保留旧调用方兼容，新代码用 shape。
   */
  variant?: 'list' | 'card'
}

function SkeletonShapeRow({ shape }: { shape: 'list' | 'flow-card' | 'agent-card' }): React.ReactElement {
  if (shape === 'flow-card') {
    return (
      <div className="skel-flow-card" aria-hidden="true">
        <div className="skeleton skel-chev" />
        <div className="skeleton skel-glyph" />
        <div className="skel-info">
          <div className="skeleton-text" style={{ width: '40%', maxWidth: '260px' }} />
          <div className="skel-meta">
            <span className="skeleton dot" />
            <span className="skeleton-text" style={{ width: '18%', maxWidth: '120px', height: '10px' }} />
            <span className="skeleton-text" style={{ width: '12%', maxWidth: '80px', height: '10px' }} />
          </div>
        </div>
        <div className="skel-actions">
          <span className="skeleton btn" />
          <span className="skeleton btn" />
        </div>
      </div>
    )
  }
  if (shape === 'agent-card') {
    return (
      <div className="skel-agent-card" aria-hidden="true">
        <div className="skeleton skel-avatar" />
        <div className="skel-info">
          <div className="skeleton-text" style={{ width: '40%', maxWidth: '220px' }} />
          <div className="skeleton-text" style={{ width: '100%', height: '10px' }} />
          <div className="skel-meta">
            <span className="skeleton dot" />
            <span className="skeleton-text" style={{ width: '20%', maxWidth: '140px', height: '10px' }} />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-4) 0', borderBottom: '1px solid var(--border-soft)' }}>
      {/* Avatar circle */}
      <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0 }} />
      {/* Title + subtitle */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div className="skeleton-text" style={{ width: '40%', maxWidth: '200px' }} />
        <div className="skeleton-text" style={{ width: '25%', maxWidth: '140px', height: '10px' }} />
      </div>
      {/* Right meta */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <div className="skeleton" style={{ width: 48, height: 20, borderRadius: 'var(--radius-pill)' }} />
      </div>
    </div>
  )
}

export function SkeletonList({ rows = 5, shape, variant = 'list' }: SkeletonListProps): React.ReactElement {
  const resolved: 'list' | 'flow-card' | 'agent-card' =
    shape ?? (variant === 'card' ? 'flow-card' : 'list')
  return (
    <div className="skeleton-list">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonShapeRow key={i} shape={resolved} />
      ))}
    </div>
  )
}

/** Skeleton for the daemons 3-column layout. */
export function DaemonSkeleton(): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)', flex: 1, minHeight: 0 }}>
      {/* Queue column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 48, borderRadius: 'var(--radius-sm)' }} />
        ))}
      </div>
      {/* Timeline column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <div className="skeleton" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div className="skeleton-text" style={{ width: '60%' }} />
              <div className="skeleton-text" style={{ width: '40%', height: '10px' }} />
            </div>
          </div>
        ))}
      </div>
      {/* Stats column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 56, borderRadius: 'var(--radius-sm)' }} />
        ))}
      </div>
    </div>
  )
}

/** Skeleton for the chat detail loading state. */
export function ChatDetailSkeleton(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-4)' }}>
      <div className="skeleton" style={{ height: 32, width: 200, borderRadius: 'var(--radius-sm)' }} />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-3)', maxWidth: '70%' }}>
          <div className="skeleton" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div className="skeleton-text" style={{ width: '90%' }} />
            <div className="skeleton-text" style={{ width: '70%' }} />
            <div className="skeleton-text" style={{ width: '80%', height: '10px' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
