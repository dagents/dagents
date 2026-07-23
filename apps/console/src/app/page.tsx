import { LauncherView } from '@/components/launcher-view'

/**
 * Home route = the design launcher/overview (M6.1).
 *
 * design/index.html is a hero CTA + arch-strip launcher (hero → /dashboard +
 * /flows, 7-layer platform strip at the bottom). The root renders that launcher
 * now (audit §5.1/§5.2 deltas — hero CTA + arch-strip were missing). The chat
 * view that used to live at the root moved to `/chat` (see `app/chat/page.tsx`),
 * reached from the sidebar's 编排 section; the launcher's CTAs and the sidebar
 * are the primary navigation into the rest of the console.
 */
export default function Home(): React.ReactElement {
  return <LauncherView />
}
