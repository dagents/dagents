/**
 * 英文词典入口 — 按界面模块分文件维护，避免多人/多任务并行迁移时冲突。
 * key 为现有中文文案（自然键），缺项自动回退中文（见 ../index.tsx）。
 */
import { common } from './common'
import { agents } from './agents'
import { flows } from './flows'
import { daemons } from './daemons'
import { settings } from './settings'
import { chat } from './chat'

export const en: Record<string, string> = {
  ...common,
  ...agents,
  ...flows,
  ...daemons,
  ...settings,
  ...chat,
}
