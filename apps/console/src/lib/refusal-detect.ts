/**
 * refusal-detect — 从 CLI 回复文本中识别「权限被拒」的诚实标注。
 *
 * 背景：非交互 CLI 缺权限标志时（claude 无 --permission-mode / codex 只读
 * 沙箱），写类工具被拒 → 模型绕路后回复「没有权限…」。这类回复的 span
 * 状态是 done（完成的是"放弃并解释"）—— 不标注会把失败伪装成成功。
 *
 * 匹配保守（宁可漏报不误报）：只认明确的拒绝话术；用户*讨论*权限的
 * 正常回复（如"我检查了文件权限"）不应命中。
 */

/** 紧模式：明确的权限拒绝话术（中英）。 */
const PERMISSION_REFUSAL_PATTERNS: readonly RegExp[] = [
  /permission\s+denied/i,
  /requires?\s+(?:your\s+)?approval/i,
  /don'?t\s+have\s+(?:the\s+)?permission/i,
  /no\s+permission\s+to/i,
  /permission\s+to\s+(?:write|create|modify|delete|execute)/i,
  /没有权限/,
  /无法.{0,6}权限/,
  /权限未授予/,
  /未获.{0,4}(授权|许可)/,
  /被.{0,10}(安全)?策略.{0,4}(拦截|阻止|拒绝)/,
  /工具权限/,
  /需要(您|你)?的?批准/,
  /需要(相应|额外)的?权限/,
  /未获.{0,4}授权/,
]

export type RefusalKind = 'permission' | null

/** 检测文本是否是权限拒绝回复。命中返回 'permission'。 */
export function detectRefusal(text: string | null | undefined): RefusalKind {
  if (!text) return null
  const sample = text.length > 2000 ? text.slice(0, 2000) : text
  for (const re of PERMISSION_REFUSAL_PATTERNS) {
    if (re.test(sample)) return 'permission'
  }
  return null
}
