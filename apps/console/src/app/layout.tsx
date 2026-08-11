import type { Metadata } from 'next'
import { RootGate } from '@/components/root-gate'
import { ToastProvider } from '@/components/toast'
import { ChatLayout } from '@/components/chat-layout'
import '@/styles/tokens.css'
import '@/styles/shell.css'

export const metadata: Metadata = {
  title: 'Dagents',
  description: 'Dagents 编排平台 — 控制台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* FOUC prevention: apply stored theme before first paint */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              var t = localStorage.getItem('dagents-theme');
              if (t === 'light' || t === 'dark') {
                document.documentElement.setAttribute('data-theme', t);
              }
            } catch (e) {}
          })();
        ` }} />
      </head>
      <body>
        <RootGate>
          <ToastProvider>
            <ChatLayout>{children}</ChatLayout>
          </ToastProvider>
        </RootGate>
      </body>
    </html>
  )
}
