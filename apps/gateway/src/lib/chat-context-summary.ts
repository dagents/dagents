/**
 * chat-context-summary —— 聊天滚动会话摘要（2026-10-04 P1b 两级历史）。
 *
 * 调研裁决（docs/context-management-research.md）：
 *  - **两级结构**：滚动摘要（chats.context_summary，宽泛层）+ 最近 K 条
 *    原文（chat_messages，细节层）——上下文不再随会话长度线性膨胀；
 *  - **dsh compaction 技巧全量应用**：①摘要指令作为重放对话之后的**末条
 *    user 消息**（而非独立 system）——辅助调用是上次真实请求的真前缀，
 *    provider KV cache 复用；②结构化 checkpoint 格式（dsh 八节裁剪为
 *    chat 版五节）；③已有摘要时**合并不照抄**（保留仍真、丢弃过时、
 *    并入新信息）；④不暴露「发生过压缩」。
 *  - 触发：持久化助手消息后 fire-and-forget；消息数越过水位超过阈值
 *    （默认 40）才折叠，保留最近 20 条不折叠。进程内 Set 锁 + DB 水位
 *    双保险防并发重复生成。
 *  - 生成器：仅在有 HTTP provider 时启用（CLI 后台烧 token 不值当——
 *    诚实降级：无 provider 时摘要层空缺，原文检索照常）。
 */

import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { createLlmClient } from '../routes/workflow-clients.js'

const log = createLogger({ svc: 'gateway:chat-summary' })

const numEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** 滚动摘要总开关（默认开；无 HTTP provider 时自然空转）。 */
export const CHAT_SUMMARY_ENABLED = (): boolean => process.env.DAGENTS_CHAT_SUMMARY !== '0'
/** 未折叠消息超过该数触发折叠。 */
export const CHAT_SUMMARY_TRIGGER = (): number => numEnv('DAGENTS_CHAT_SUMMARY_TRIGGER', 40)
/** 永不折叠的最近消息条数（细节层）。 */
export const CHAT_SUMMARY_KEEP_RECENT = (): number => numEnv('DAGENTS_CHAT_SUMMARY_KEEP_RECENT', 20)
/** 摘要本体字符上限（注入时的宽泛层预算）。 */
export const CHAT_SUMMARY_MAX_CHARS = (): number => numEnv('DAGENTS_CHAT_SUMMARY_MAX_CHARS', 4000)

/** chat 版结构化 checkpoint（dsh 八节裁剪；空节写 (none) 不删节）。 */
const SUMMARY_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI assistant conversation. Condense the conversation ABOVE (plus the prior checkpoint if present) into a structured checkpoint that lets another assistant continue helping the user with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below, in Chinese, terse bullets (not prose). Write "（无）" for an empty section — never drop a section.',
  '',
  '## 用户目标',
  '- [用户的原始与演进中的诉求；措辞关键处原文引用]',
  '',
  '## 关键事实与决定',
  '- [已确认的事实、做出的决定及其原因]',
  '',
  '## 已完成',
  '- [已交付/已解决的事项]',
  '',
  '## 进行中',
  '- [正在处理的事，停在哪一步]',
  '',
  '## 偏好与约束',
  '- [用户偏好、明确约束、开放问题]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, and numbers.',
  '- Capture user corrections faithfully.',
  '- If the input contains a prior checkpoint (【上次摘要】), MERGE it: keep still-true facts, drop stale ones, fold in newer information — do not copy it forward verbatim.',
  '- Do NOT mention this summarization request.',
  `- Keep the output under ${CHAT_SUMMARY_MAX_CHARS()} characters.`,
].join('\n')

const inFlight = new Set<string>()

interface FoldWindow {
  messages: Array<{ role: string; content: string }>
  /** 折叠窗口末条消息 id（新水位）。 */
  watermark: string
}

/** 取水位 → (最新 - keepRecent) 之间的未折叠消息（折叠窗口）。 */
async function loadFoldWindow(chatId: string): Promise<FoldWindow | null> {
  const { records } = await runQuery<{ id: string; watermark: string | null }>(
    `SELECT id, context_summary_watermark AS watermark FROM chats WHERE id = $1::uuid`,
    [chatId],
  )
  const chatRow = records[0]
  if (!chatRow) return null
  const { records: recent } = await runQuery<{ id: string }>(
    `SELECT id FROM chat_messages
      WHERE chat_id = $1::uuid AND role IN ('user','assistant')
      ORDER BY created_at DESC
      LIMIT $2`,
    [chatId, CHAT_SUMMARY_KEEP_RECENT()],
  )
  const cutoffId = recent[recent.length - 1]?.id ?? null
  // 可折叠窗口：水位之后 → 保留窗起点之前；不够阈值就不动
  const { records: foldable } = await runQuery<{ id: string; role: string; content: string }>(
    `SELECT id, role, content FROM chat_messages
      WHERE chat_id = $1::uuid AND role IN ('user','assistant')
        AND ($2::uuid IS NULL OR (created_at, id) > (
          SELECT created_at, id FROM chat_messages WHERE id = $2::uuid))
        AND ($3::uuid IS NULL OR (created_at, id) < (
          SELECT created_at, id FROM chat_messages WHERE id = $3::uuid))
      ORDER BY created_at ASC`,
    [chatId, chatRow.watermark, cutoffId],
  )
  if (foldable.length < CHAT_SUMMARY_TRIGGER()) return null
  return {
    messages: foldable.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
    watermark: foldable[foldable.length - 1]!.id,
  }
}

/**
 * 也许更新 chat 的滚动摘要：阈值未到 / 无 provider / 已在生成 → 静默跳过。
 * fire-and-forget 语义——任何失败不外抛（摘要是增益不是依赖）。
 */
export async function maybeUpdateChatSummary(chatId: string): Promise<void> {
  if (!CHAT_SUMMARY_ENABLED()) return
  if (inFlight.has(chatId)) return
  inFlight.add(chatId)
  try {
    const window = await loadFoldWindow(chatId)
    if (!window) return
    const { records } = await runQuery<{ context_summary: string | null }>(
      `SELECT context_summary FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    const prior = records[0]?.context_summary ?? null

    // dsh KV 技巧：重放对话（含前次摘要块）之后，摘要指令作为**末条 user
    // 消息**——辅助调用是主对话形态的真前缀，provider 缓存可复用。
    const replay: Array<{ role: string; content: string }> = []
    if (prior) replay.push({ role: 'system', content: `【上次摘要】\n${prior}` })
    for (const m of window.messages) {
      replay.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
    }
    replay.push({ role: 'user', content: SUMMARY_INSTRUCTION })

    const client = createLlmClient()
    const result = await client.chat({ model: '', messages: replay, temperature: 0 })
    const summary = result.text.trim().slice(0, CHAT_SUMMARY_MAX_CHARS())
    if (summary.length === 0) return

    await runQuery(
      `UPDATE chats
          SET context_summary = $2, context_summary_watermark = $3::uuid
        WHERE id = $1::uuid`,
      [chatId, summary, window.watermark],
    )
    log.info('chat context summary folded', {
      chatId,
      foldedMessages: window.messages.length,
      summaryChars: summary.length,
    })
  } catch (err) {
    log.warn('chat summary update failed (degraded: retrieval falls back to verbatim)', {
      chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inFlight.delete(chatId)
  }
}

/** 检索器用的只读口：取摘要（无则 null）。 */
export async function getChatContextSummary(chatId: string): Promise<string | null> {
  try {
    const { records } = await runQuery<{ context_summary: string | null }>(
      `SELECT context_summary FROM chats WHERE id = $1::uuid`,
      [chatId],
    )
    return records[0]?.context_summary ?? null
  } catch {
    return null
  }
}
