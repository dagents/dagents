import { ChatView } from '@/components/chat-view'

/**
 * 对话 (chat) route (M6.1).
 *
 * The chat/conversation view that used to live at the root (P1.10.T2 + T3). The
 * root is now the design launcher (hero CTA + arch-strip, see `app/page.tsx`),
 * so the chat moved here to `/chat`. The sidebar's 编排 section links here
 * (`nav.ts`); the chat view keeps its own `PageShell` (full-bleed composer +
 * sessions list + run inspector).
 */
export default function ChatPage(): React.ReactElement {
  return <ChatView />
}
