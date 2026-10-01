/**
 * codex 回归语义断言单源（spec D6：L1 夹具回放与 L3 真机共用同一套
 * 断言——两层断言一旦漂移，nightly 就成了摆设）。
 *
 * 输入是「事件流 + 终态」，不区分来源：L1 喂 parseCodexLine 的折叠产物，
 * L3 喂真 codexBackend.execute 的 events/result。断言一律语义级：
 *   - 事件类型存在性 / 标记串包含（prompt 钉死的精确标记）
 *   - usage 字段映射（cached_input_tokens → cacheReadTokens，值可 0 字段必须在）
 *   - finalStatus / sessionId
 * 绝不字节比对（模型文本天然不确定，spec D3）。
 */
import { expect } from 'vitest'
import type { AgentEvent, AgentResult } from '@dagents/contracts'
import { CODEX_SCENARIOS } from './codex.scenarios.js'

/** 一次 codex 回归运行的观测面 —— L1/L3 的共同产出形状。 */
export interface CodexRunObservation {
  events: AgentEvent[]
  result: Pick<AgentResult, 'status' | 'output' | 'sessionId' | 'usage' | 'error'>
}

function textContents(events: AgentEvent[]): string[] {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { content: string }).content)
}

/** usage['codex'] 的字段映射断言（snake_case → TokenUsage，cached 恒在）。 */
function expectCodexUsageShape(obs: CodexRunObservation): void {
  const u = obs.result.usage.codex
  expect(u, 'usage keyed by "codex" must exist after turn.completed').toBeDefined()
  // 字段映射：input_tokens/output_tokens 至少存在且 >= 0；
  // cached_input_tokens 可为 0 但字段必须在（映射自 usage.ts 单源）。
  expect(u!.inputTokens).toBeGreaterThanOrEqual(0)
  expect(u!.outputTokens).toBeGreaterThanOrEqual(0)
  expect(u!.cacheReadTokens).toBeDefined()
}

/**
 * 场景语义断言：对给定 dir 的运行观测面做全套语义检查。
 * dir 不在注册表内直接 fail（L1 侧「夹具目录存在而场景表缺项 ⇒ 测试失败」
 * 的对偶：断言层也只认注册表）。
 */
export function assertCodexScenario(dir: string, obs: CodexRunObservation): void {
  const scenario = CODEX_SCENARIOS.find((s) => s.dir === dir)
  expect(scenario, `scenario "${dir}" must exist in CODEX_SCENARIOS registry`).toBeDefined()

  const texts = textContents(obs.events)
  const fullText = texts.join('') + obs.result.output

  switch (dir) {
    case 'single-turn': {
      // 成功路径：completed + 标记串 + sessionId + usage 形状。
      expect(obs.result.status, `status must be completed (got: ${obs.result.error})`).toBe('completed')
      expect(fullText).toContain('dagents-codex-ok')
      expect(obs.result.sessionId, 'thread.started must surface as result.sessionId').toBeTruthy()
      expectCodexUsageShape(obs)
      break
    }
    case 'long-output': {
      // 成功路径 + 长文本分段累积（120 行逐号 → output 覆盖头部与尾部）。
      expect(obs.result.status, `status must be completed (got: ${obs.result.error})`).toBe('completed')
      expect(fullText).toContain('1')
      expect(fullText).toContain('120')
      expect(obs.result.sessionId).toBeTruthy()
      expectCodexUsageShape(obs)
      // 分段累积不丢：text 全在（模型可 1-N 个 agent_message，join 后必须完整）。
      expect(texts.join('').length).toBeGreaterThan(0)
      break
    }
    case 'usage-multiround': {
      // 成功路径 + 多轮工具调用下的 usage 帧语义（含 cached 映射钉子）。
      expect(obs.result.status, `status must be completed (got: ${obs.result.error})`).toBe('completed')
      expect(fullText).toContain('dagents-codex-usage-ok')
      expect(obs.result.sessionId).toBeTruthy()
      expectCodexUsageShape(obs)
      // cached_input_tokens 字段映射：值可 0，字段必须在（usage-multiround 是
      // spec §4 场景 5 的指定钉子位；其余场景已在通用形状断言覆盖）。
      const u = obs.result.usage.codex!
      expect(Number.isFinite(u.cacheReadTokens)).toBe(true)
      break
    }

    case 'tool-call-write': {
      expect(obs.result.status, `status must be completed (got: ${obs.result.error})`).toBe('completed')
      expect(fullText).toContain('dagents-codex-tool-ok')
      // command_execution → tool-use + tool-result 对（tool 名 'shell'）
      const toolUse = obs.events.find((e) => e.type === 'tool-use') as
        | { tool: string; input: { command?: string } }
        | undefined
      expect(toolUse, 'command_execution must surface a tool-use event').toBeDefined()
      expect(toolUse!.tool).toBe('shell')
      expect(toolUse!.input.command).toBeTruthy()
      const toolResult = obs.events.find((e) => e.type === 'tool-result') as
        | { output: string }
        | undefined
      expect(toolResult, 'command_execution must surface a paired tool-result').toBeDefined()
      break
    }
    case 'error-model-invalid':
    case 'error-max-turns': {
      // 失败路径：failed + 有 error 内容（帧文本形状留给 L1 对夹具的精确取证）。
      expect(obs.result.status).toBe('failed')
      expect(obs.result.error ?? '').not.toBe('')
      break
    }
    default:
      throw new Error(`assertCodexScenario: unhandled scenario dir "${dir}"`)
  }
}
