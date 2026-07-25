import { ChatDetail } from '@/components/chat-detail'

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params
  return <ChatDetail chatId={id} />
}
