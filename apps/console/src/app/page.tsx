'use client'

import { useEffect, useState } from 'react'
import { ChatHome } from '@/components/chat-home'
import { FlowsView } from '@/components/flows-view'
import { isWorkflowFirstIA } from '@/lib/ia-flag'

/**
 * Home route —— IA 开关（docs/prd-workflow-first.md）。
 *
 * Workflow-First（默认）：`/` = Flows 工作台（空态三入口承接新用户）。
 * Chat-First（`dagents.ia.workflow-first=off`，P3 观察期的回滚通道）：
 * `/` = 聊天主页。挂载后读 localStorage（SSR 水合安全），首帧渲染旧 IA
 * 的占位以避免闪烁 —— 两态互斥，无中间形态。
 */
export default function Home(): React.ReactElement {
  // null = 尚未读取（SSR/首帧）；渲染轻量占位避免水合不匹配
  const [ia, setIa] = useState<'wf' | 'chat' | null>(null)
  useEffect(() => {
    setIa(isWorkflowFirstIA() ? 'wf' : 'chat')
  }, [])

  if (ia === 'chat') return <ChatHome />
  if (ia === 'wf') return <FlowsView home />
  return <div className="page" aria-busy="true" style={{ minHeight: '60vh' }} />
}
