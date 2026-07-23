import { SettingsView } from '@/components/settings-view'

/**
 * 设置页 (P1.10.T8 / M5a.4).
 *
 * Six tabs grouped 密钥/模型/治理/账户: API Key（接 new-api 代理，CRUD 令牌）/
 * 默认模型 / 预算配额 / 通知 / 账户团队 / 危险区. The API Key tab is the only
 * one with live CRUD (browser → /api/tokens/* → gateway → new-api); the
 * other five are faithful read-only shells of design/settings.html, surfaced
 * so all six tabs are available, with their data wiring deferred per the
 * coverage analysis (docs/superpowers/specs/2026-07-08-prototype-coverage-
 * analysis.md §2.2/2.3).
 */
export default function SettingsPage(): React.ReactElement {
  return <SettingsView />
}
