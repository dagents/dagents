'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useI18n } from '@/i18n'

/** Client half of the 404 page — localized copy + a router.back() escape. */
export function NotFoundContent(): React.ReactElement {
  const { t } = useI18n()
  const router = useRouter()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-4)',
        textAlign: 'center',
        maxWidth: 400,
      }}
    >
      {/* DAG logo mark */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 'var(--radius-md)',
          background: 'linear-gradient(135deg, var(--accent) 0%, color-mix(in oklab, var(--accent), white 15%) 100%)',
          color: 'var(--accent-on)',
          display: 'grid',
          placeItems: 'center',
          boxShadow: '0 4px 12px color-mix(in oklab, var(--accent) 20%, transparent)',
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 24, height: 24 }}>
          <circle cx="6" cy="6" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="12" cy="18" r="2.5" fill="currentColor" stroke="none" />
          <path d="M7.5 7.5 L10.5 16" />
          <path d="M16.5 7.5 L13.5 16" />
          <path d="M8.5 6 L15.5 6" />
        </svg>
      </div>

      <div>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-3xl)',
            fontWeight: 600,
            color: 'var(--fg)',
            lineHeight: 1.1,
          }}
        >
          404
        </div>
        <div
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--muted)',
            marginTop: 'var(--space-2)',
            lineHeight: 1.5,
          }}
        >
          {t('页面不存在或已被移动。')}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <Link
          href="/"
          className="btn btn-primary"
          style={{ textDecoration: 'none' }}
        >
          {t('返回首页')}
        </Link>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => router.back()}
        >
          {t('返回上一页')}
        </button>
        <Link
          href="/daemons"
          className="btn btn-ghost"
          style={{ textDecoration: 'none' }}
        >
          {t('查看 Daemon')}
        </Link>
      </div>
    </div>
  )
}
