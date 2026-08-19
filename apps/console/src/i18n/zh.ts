/**
 * 中文词典 — 极少数「英文源词条」的中文映射。
 *
 * 自然键方案下绝大多数界面文案本身就是中文 key（zh 模式直接显示），
 * 无需中文词典。例外是产品名词（nav.ts 的 Agent/Flow/Daemon、详情页
 * Skills tab 等）以英文为源串 —— 这里提供英文 → 中文方向，使中文模式
 * 下它们显示为中文；英文模式走 en 词典（Agent → Agents）或回退 key。
 */

export const zh: Record<string, string> = {
  Agent: '智能体',
  Agents: '智能体',
  Flow: '工作流',
  Flows: '工作流',
  Daemon: '守护进程',
  Daemons: '守护进程',
  Skills: '技能',
}
