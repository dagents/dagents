import { FlowsView } from '@/components/flows-view'

/**
 * Home route —— Workflow-First IA（docs/prd-workflow-first.md）。
 *
 * `/` = Flows 工作台（空态三入口承接新用户，`flows-empty-hero`）。
 * Chat-First 回滚通道（`dagents.ia.workflow-first=off`）已于 2026-09-06
 * 退役删除 —— 观察期结束，双壳维护税不再付；聊天入口 = 全局悬浮副驾
 * FloatingChat + 侧栏会话树。
 */
export default function Home(): React.ReactElement {
  return <FlowsView home />
}
