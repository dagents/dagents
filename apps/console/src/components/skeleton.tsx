/**
 * SkeletonList — shimmering placeholder for async list content.
 *
 * Renders a configurable number of skeleton rows that mimic the
 * real list-item layout (avatar + title + subtitle + meta).
 * The skeleton already has CSS in shell.css (.skeleton, .skeleton-text).
 *
 * Usage:
 *   {loading ? <SkeletonList rows={5} /> : <ActualList items={data} />}
 */

interface SkeletonListProps {
  /** Number of skeleton rows to render. */
  rows?: number
  /** Layout variant — 'list' for agents/daemons, 'card' for flows. */
  variant?: 'list' | 'card'
}

export function SkeletonList({ rows = 5, variant = 'list' }: SkeletonListProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-4) 0', borderBottom: '1px solid var(--border-soft)' }}>
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
            {variant === 'card' && (
              <div className="skeleton" style={{ width: 60, height: 28, borderRadius: 'var(--radius-sm)' }} />
            )}
          </div>
        </div>
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
