import { NewTaskView } from '@/components/new-task-view'

/**
 * `/tasks/new` — 新增 Task 路由 (v0.3-M3.1, audit §2).
 *
 * Thin server component wiring the AppShell layout to the new-task client
 * view. The view owns the picker modals (关联 Flow / 关联 Agent), the
 * directory workspace card, the composer, and the suggestion grid — ported
 * 1:1 from design/new-task.html. The route stays a server component so the
 * AppShell chrome renders before hydration (matching how every other route
 * is wired: a thin `page.tsx` delegating to a `*-view.tsx` client component).
 *
 * Path is `tasks/new` (not `new-task`) to read as a noun-phrase route under
 * App Router; the design's `new-task.html` filename is a leaf label, not a
 * routing contract (audit §2.2 confirms the console had no new-task route
 * at all before this task — the path shape is ours to choose). The sidebar's
 * 「新增 Task」plus button (design app.js:69-76) links here.
 */
export default function NewTaskPage(): React.ReactElement {
  return <NewTaskView />
}
