import { ChatHome } from '@/components/chat-home'

/**
 * Home route = Chat-First landing page.
 *
 * The root renders the Chat Home page with a sidebar for directory/chat
 * selection and a welcome composer for starting new conversations.
 * Clicking a chat in the sidebar navigates to `/chats/[id]`.
 */
export default function Home(): React.ReactElement {
  return <ChatHome />
}
