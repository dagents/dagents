/**
 * Human-in-the-loop resolution for HumanInput nodes.
 *
 * When a flow executing in a chat hits a HumanInput node, the gateway:
 *
 *   1. writes a `system` chat message with the prompt (so the request is
 *      visible in the conversation history, even after a reload),
 *   2. emits a `custom:human_input` SSE event on the run's open stream
 *      (future frontends can render a dedicated input UI; today's chat view
 *      ignores unknown events gracefully),
 *   3. parks the run's promise in an in-memory pending registry keyed by
 *      chat id — the user's NEXT message in that chat resolves it, and the
 *      paused flow continues streaming on the same connection.
 *
 * The pending state is deliberately in-memory (single-process gateway, local
 * mode): a gateway restart or a HUMAN_INPUT_TIMEOUT_MS expiry (default 5min)
 * fails the node with a clear error instead of hanging the run forever.
 */

import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import type { IExecutionContext, IServerSideEventStreamer } from '@dagents/workflow'

const log = createLogger({ svc: 'gateway:human-input' })

/** How long a HumanInput node waits for the user's answer before failing. */
export const HUMAN_INPUT_TIMEOUT_MS = Number(process.env.HUMAN_INPUT_TIMEOUT_MS ?? 300_000)

interface PendingHumanInput {
  runId: string
  prompt: string
  inputType: string
  options: unknown[]
  resolve: (answer: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One pending human input per chat at a time (chat id → pending). */
const pendingByChat = new Map<string, PendingHumanInput>()

/** Whether the chat currently has a flow parked on a HumanInput node. */
export function hasPendingHumanInput(chatId: string): boolean {
  return pendingByChat.has(chatId)
}

/**
 * Resolve the chat's pending HumanInput with the user's answer.
 * Returns false when nothing was pending (the message routes normally).
 */
export function resolvePendingHumanInput(chatId: string, answer: string): boolean {
  const pending = pendingByChat.get(chatId)
  if (!pending) return false
  pendingByChat.delete(chatId)
  clearTimeout(pending.timer)
  pending.resolve(answer)
  return true
}

/**
 * Create the chat-backed `humanInputResolver` for a run. Each call parks a
 * promise; the user's next message in the chat resolves it.
 */
export function createChatHumanInputResolver(params: {
  chatId: string
  runId: string
  streamer?: IServerSideEventStreamer
}): NonNullable<IExecutionContext['humanInputResolver']> {
  const { chatId, runId, streamer } = params
  return (prompt, inputType, optionsParam) => {
    const options = optionsParam ?? []
    return new Promise<string>((resolve, reject) => {
      if (pendingByChat.has(chatId)) {
        reject(new Error('another HumanInput node is already waiting in this chat'))
        return
      }

      const timer = setTimeout(() => {
        pendingByChat.delete(chatId)
        reject(new Error(`HumanInput timed out after ${Math.round(HUMAN_INPUT_TIMEOUT_MS / 1000)}s waiting for: ${prompt.slice(0, 100)}`))
      }, HUMAN_INPUT_TIMEOUT_MS)
      timer.unref?.()

      pendingByChat.set(chatId, { runId, prompt, inputType, options, resolve, reject, timer })

      // Surface the request: system message in the history + SSE custom event.
      void persistPromptMessage(chatId, runId, prompt, inputType, options)
      streamer?.streamCustomEvent?.(chatId, 'human_input', { runId, prompt, inputType, options })
    })
  }
}

/** Build the human-readable system message for a pending prompt. */
export function formatPromptMessage(
  prompt: string,
  inputType: string,
  options: unknown[],
): string {
  const head = inputType === 'confirm' ? '需要你确认' : inputType === 'select' ? '需要你选择' : '需要你补充信息'
  let body = `⏸ ${head}：${prompt}`
  if (inputType === 'select' && Array.isArray(options) && options.length > 0) {
    body += `\n选项：${options.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join(' / ')}`
  }
  body += '\n（直接在本聊天中回复即可，流程会继续）'
  return body
}

async function persistPromptMessage(
  chatId: string,
  runId: string,
  prompt: string,
  inputType: string,
  options: unknown[],
): Promise<void> {
  try {
    await runQuery(
      `INSERT INTO chat_messages (chat_id, role, content, run_id, metadata)
       VALUES ($1::uuid, 'system', $2, $3, $4)`,
      [chatId, formatPromptMessage(prompt, inputType, options), runId, JSON.stringify({ type: 'human_input', prompt, inputType })],
    )
  } catch (err) {
    // Best-effort: the SSE event already notified the live listener; history
    // just loses the prompt line on failure.
    log.warn('persist human-input prompt message failed', { chatId, runId, error: String(err) })
  }
}

/**
 * Create a resolver for non-interactive runs (`POST /workflows/:id/run`):
 * answers come from the request's `state.humanInputs` map (keyed by the
 * node's prompt); anything without a pre-supplied answer fails loudly so the
 * caller knows to either use the chat path or supply the map.
 */
export function createStaticHumanInputResolver(
  humanInputs: Record<string, string>,
): NonNullable<IExecutionContext['humanInputResolver']> {
  return async (prompt) => {
    const answer = humanInputs[prompt]
    if (answer === undefined) {
      throw new Error(
        `HumanInput node has no pre-supplied answer for prompt "${prompt.slice(0, 100)}" — ` +
          'run the flow in a chat, or pass state.humanInputs keyed by prompt',
      )
    }
    return answer
  }
}
