import { NotFoundContent } from './not-found-content'

/**
 * Custom 404 page — branded, friendly, with navigation.
 * Replaces Next.js's default 404 (English-only). The copy itself lives in a
 * client component so it localizes through useI18n like the rest of the app
 * (this page is a server component).
 */
export default function NotFound(): React.ReactElement {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        backgroundImage: 'var(--bg-mesh)',
        padding: 'var(--space-4)',
      }}
    >
      <NotFoundContent />
    </div>
  )
}
