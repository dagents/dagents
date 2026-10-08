/**
 * run-status.ts —— run 终态词表单源（R3.6，design-recover §4.1）。
 *
 * 九态词表与 DB CHECK（迁移 1720000111000）/ TS RunStatus 同源；四个消费点
 * （STATUS_LABEL / watchTick / 旁观循环 / workflow-run-card 轮询起停）同一批
 * 改齐，禁再出现第三份清单（cancelled→stopped 破坏性改名的双读兼容期，
 * PRD R3.3/NFR-1——存量 cancelled 行不迁移，读侧双读）。
 */

/** 终态清单（词表全集）：awaiting_input 是挂起非终态，轮询继续。 */
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'partial_success',
  'budget_exceeded',
  'failed',
  'stopped',
  'cancelled',
] as const

/** 终态判定（双读：新写 stopped + 存量 cancelled）。 */
export function isTerminalRunStatus(s: string | null | undefined): boolean {
  return s != null && (TERMINAL_RUN_STATUSES as readonly string[]).includes(s)
}

/**
 * 九态中文标签（自然键 = i18n key）：值即 t() 的 key——已有词条复用勿重加
 * （「等待输入」flows.ts、「已取消」common.ts/chat.ts）；缺词条回退中文原样。
 * stopped 的细分（已中断/已中断（可恢复）/已停止）由消费点按 stop_reason
 * 派生，本表只给基词。
 */
export const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  awaiting_input: '等待输入',
  completed: '已完成',
  partial_success: '部分成功',
  budget_exceeded: '预算停机',
  failed: '失败',
  stopped: '已停止',
  cancelled: '已取消',
}

/**
 * stop_reason → 中止来源标签（R3.4/AC-R3-4：interrupted 与 user 可区分）。
 * null（未知/无来源）返回 null，消费点回落 STATUS_LABEL 基词。
 */
export const STOP_REASON_LABEL: Record<string, string> = {
  user: '已停止',
  interrupted: '已中断',
  superseded: '已被新执行取代',
  model: '模型错误',
  provider: 'Provider 故障',
}

/**
 * stopped 终态的显示标签（§4.1 第 2 点）：interrupted 且有 checkpoint
 * resumable → 「已中断（可恢复）」；interrupted 无 checkpoint → 「已中断」
 * （不渲染恢复入口，AC-R1-6 诚实不假承诺）；user → 「已停止」（中性色）。
 */
export function stoppedStatusLabel(
  stopReason: string | null | undefined,
  resumable: boolean,
): string {
  if (stopReason === 'interrupted') return resumable ? '已中断（可恢复）' : '已中断'
  if (stopReason === 'user') return '已停止'
  return '已停止'
}
