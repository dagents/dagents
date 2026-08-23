import type { Metadata, Viewport } from 'next'
import { ToastProvider } from '@/components/toast'
import { ChatLayout } from '@/components/chat-layout'
import { I18nProvider } from '@/i18n'
import '@/styles/tokens.css'
import '@/styles/shell.css'

export const metadata: Metadata = {
  title: 'Dagents',
  description: 'Dagents 编排平台 — 控制台',
}

/**
 * Without this export Next.js emits NO viewport meta — mobile browsers then
 * render at a ~980px layout viewport and scale down, breaking every narrow
 * breakpoint (the 768px sidebar drawer included).
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* FOUC prevention: apply stored theme + locale before first paint */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              var t = localStorage.getItem('dagents-theme');
              if (t === 'light' || t === 'dark') {
                document.documentElement.setAttribute('data-theme', t);
              }
              var l = localStorage.getItem('dagents.locale');
              if (l === 'en') {
                document.documentElement.setAttribute('lang', 'en');
              }
            } catch (e) {}
          })();
        ` }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (e.g. cz-shortcut-listen
          from translate/select-to-search plugins) inject attributes onto
          <body> before React hydrates — harmless attribute-only mismatches. */}
      <body suppressHydrationWarning>
        <I18nProvider>
          <ToastProvider>
            <ChatLayout>{children}</ChatLayout>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  )
}
