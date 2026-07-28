'use client'

interface CanvasToolbarProps {
  flowName: string
  onSave: () => void
  onRun: () => void
  isSaving: boolean
  isRunning: boolean
}

export function CanvasToolbar({
  flowName,
  onSave,
  onRun,
  isSaving,
  isRunning,
}: CanvasToolbarProps): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        borderBottom: '1px solid var(--border-soft)',
        backgroundColor: 'var(--bg)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            backgroundColor: 'var(--accent)',
            color: 'var(--accent-on, #fff)',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="6" height="5" rx="1.5" />
            <rect x="15" y="4" width="6" height="5" rx="1.5" />
            <rect x="9" y="15" width="6" height="5" rx="1.5" />
            <path d="M6 9v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" />
            <path d="M12 13v2" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {flowName}
          </div>
          <div style={{ fontSize: 10, color: 'var(--meta)', marginTop: 1 }}>
            V2 Agent Workflow
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSave}
          disabled={isSaving}
          style={{
            padding: '7px 14px',
            border: '1px solid var(--border-soft)',
            borderRadius: 7,
            backgroundColor: 'var(--bg)',
            color: 'var(--fg)',
            fontSize: 12,
            fontWeight: 500,
            cursor: isSaving ? 'not-allowed' : 'pointer',
            opacity: isSaving ? 0.6 : 1,
            transition: 'background-color 0.15s, border-color 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
          onMouseEnter={(e) => {
            if (!isSaving) {
              e.currentTarget.style.backgroundColor = 'var(--surface-warm)'
              e.currentTarget.style.borderColor = 'var(--border)'
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--bg)'
            e.currentTarget.style.borderColor = 'var(--border-soft)'
          }}
        >
          {isSaving ? (
            <>
              <span
                style={{
                  width: 12,
                  height: 12,
                  border: '2px solid var(--border-soft)',
                  borderTopColor: 'var(--fg)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  display: 'inline-block',
                }}
              />
              保存中
            </>
          ) : (
            <>
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
              保存
            </>
          )}
        </button>

        <button
          onClick={onRun}
          disabled={isRunning}
          style={{
            padding: '7px 14px',
            border: '1px solid var(--accent)',
            borderRadius: 7,
            backgroundColor: 'var(--accent)',
            color: 'var(--accent-on, #fff)',
            fontSize: 12,
            fontWeight: 500,
            cursor: isRunning ? 'not-allowed' : 'pointer',
            opacity: isRunning ? 0.7 : 1,
            transition: 'background-color 0.15s',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
          onMouseEnter={(e) => {
            if (!isRunning) {
              e.currentTarget.style.backgroundColor = 'var(--accent-hover)'
              e.currentTarget.style.borderColor = 'var(--accent-hover)'
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--accent)'
            e.currentTarget.style.borderColor = 'var(--accent)'
          }}
        >
          {isRunning ? (
            <>
              <span
                style={{
                  width: 12,
                  height: 12,
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: 'var(--accent-on, #fff)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  display: 'inline-block',
                }}
              />
              运行中
            </>
          ) : (
            <>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
              运行
            </>
          )}
        </button>
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
