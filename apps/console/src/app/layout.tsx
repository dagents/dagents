import type { Metadata } from 'next'
import { RootGate } from '@/components/root-gate'
import { ChatLayout } from '@/components/chat-layout'
import '@/styles/tokens.css'
import '@/styles/shell.css'

export const metadata: Metadata = {
  title: 'DAgent Console',
  description: '百万智能体编排平台 — 控制台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <RootGate>
          <ChatLayout>{children}</ChatLayout>
        </RootGate>
      </body>
    </html>
  )
}
