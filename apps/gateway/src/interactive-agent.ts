/**
 * interactive-agent.ts — 交互式 agent 会话的解析层（P4，2026-09-19，
 * docs/design-terminal-anchors.md §7）。
 *
 * 「终端承载 agent」而非「agent 拥有终端」：把 agent 人格编译成可交互
 * CLI 的 argv，交给 shell-registry 在 PTY 里托管 —— 用户在浏览器里亲手
 * 驱动 agent（人在环路），与工作流的无头执行互为补充。
 *
 * v1 支持面（诚实边界）：claude（唯一真机 PASS 档 runtime）——人格经
 * `--system-prompt` 全文注入、模型经 `--model`；其余 runtime 显式 400，
 * 不做「裸 CLI 冒充人格会话」的静默降级（用户以为在跟配置好的 agent
 * 说话、实际没有任何人格，是信任级事故）。
 */

import { execSync } from 'node:child_process'
import { getAgentDetailRow } from './repositories/agents.repo.js'
import { ShellSessionError } from './shell-registry.js'

export interface InteractiveAgentSpawn {
  command: string
  args: string[]
  kind: 'agent'
  label: string
}

/** runtime → CLI 二进制（与 cli-runtimes 路由同源映射；v1 白名单见上）。 */
const INTERACTIVE_SUPPORT: Record<string, string> = {
  claude: 'claude',
}

function which(binary: string): string | null {
  try {
    // `where` on Windows, `which` elsewhere (same convention as cli-runtimes)
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    return execSync(`${cmd} ${binary}`, { encoding: 'utf8', timeout: 5000 }).trim() || null
  } catch {
    return null
  }
}

/** agentId → 交互式 spawn 定义；不可支持时抛 ShellSessionError（4xx 诚实）。 */
export async function resolveInteractiveAgent(agentId: string): Promise<InteractiveAgentSpawn> {
  const row = await getAgentDetailRow(agentId)
  if (!row) {
    throw new ShellSessionError(`agent not found: ${agentId}`, 404)
  }

  // CLI 类型判别在 agents.kind（runtime 是 daemon join 字段，多为 remote 用）；
  // claude 是唯一真机 PASS 档 —— 其余 kind 显式拒绝，不静默裸启冒充人格。
  const cliKind = row.kind?.trim().toLowerCase()
  const binary = INTERACTIVE_SUPPORT[cliKind]
  if (!binary) {
    throw new ShellSessionError(
      `该 Agent（kind=${row.kind}）的交互式会话暂不支持（当前支持：claude）—— 可先在 Agent 配置中切换为 claude`,
      400,
    )
  }
  if (!which(binary)) {
    throw new ShellSessionError(`${binary} CLI 不在网关 PATH 上 —— 请先安装/登录该 CLI`, 400)
  }

  const args: string[] = []
  // 人格全文注入（persona 平均 13.9KB —— argv 上限远够；空指令 = 裸 CLI
  // 但用户显式要求了这个 agent，label 如实标注）
  const instructions = row.instructions?.trim()
  if (instructions) args.push('--system-prompt', instructions)
  const model = row.model?.trim()
  if (model) args.push('--model', model)

  return { command: binary, args, kind: 'agent', label: row.name }
}
