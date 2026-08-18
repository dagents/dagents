import { SkillsView } from '@/components/skills-view'

/**
 * 技能库 route — thin server component rendering the client SkillsView,
 * the same pattern as the agents page. Skills are a runtime filesystem
 * catalog (registry-not-database); this page is read-only.
 */
export default function SkillsPage(): React.ReactElement {
  return <SkillsView />
}
