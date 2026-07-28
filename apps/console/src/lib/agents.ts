/**
 * Agent catalogue for the chat view's agent selector.
 *
 * "agent 切换（提示词 agent / 异构 agent）". The console talks to two families
 * of agents:
 *
 *  - **Prompt agents** — workflow chatflows (type `CHATFLOW`). The chat view
 *    drives them via the gateway's `/api/v1/flows/<id>/prediction` proxy. Each
 *    has a `flowId` (the workflow chatflow id) and a short description.
 *
 *  - **Heterogeneous CLI agents** — `claude`, `codex`, … (the 14-type
 *    whitelist in `@dagents/contracts` `AgentType`). These are dispatched through
 *    the daemon fleet, not the prediction API, so in the M5a.1 chat view they
 *    are listed but flagged `runtime: 'cli'` and route through the same
 *    prompt-agent path as a placeholder until the dispatch UI lands (M5b). The
 *    selector surface is the deliverable for T3; full dispatch is a later task.
 *
 * The list is static for the skeleton — real listings will come from a gateway
 * route in a later task. `defaultFlowId` ties the "prompt agent" entry to the
 * configured default chatflow.
 */

import type { AgentType } from '@dagents/contracts'
import { DEFAULT_FLOW_ID } from './config'

export type AgentRuntime = 'prompt' | 'cli'

export interface ChatAgent {
  id: string
  label: string
  description: string
  runtime: AgentRuntime
  /** Workflow chatflow id — present for `prompt` agents. */
  flowId?: string
  /** CLI agent type — present for `cli` agents. */
  agentType?: AgentType
}

/** A curated subset of the 14-type CLI whitelist surfaced in the selector. */
const CLI_AGENTS: ChatAgent[] = [
  {
    id: 'cli:claude',
    label: 'Claude Code',
    description: '异构 CLI agent — 经 Agent Daemon 接入（派发待 M5b 接入）。',
    runtime: 'cli',
    agentType: 'claude',
  },
  {
    id: 'cli:codex',
    label: 'Codex',
    description: '异构 CLI agent — 经 Agent Daemon 接入（派发待 M5b 接入）。',
    runtime: 'cli',
    agentType: 'codex',
  },
  {
    id: 'cli:gemini',
    label: 'Gemini',
    description: '异构 CLI agent — 经 Agent Daemon 接入（派发待 M5b 接入）。',
    runtime: 'cli',
    agentType: 'gemini',
  },
]

/** Prompt agents bound to workflow chatflows. */
const PROMPT_AGENTS: ChatAgent[] = [
  {
    id: 'prompt:default',
    label: 'M1 Demo Agent',
    description: '提示词 agent — ReAct Agent + Calculator，经 gateway 调用。',
    runtime: 'prompt',
    flowId: DEFAULT_FLOW_ID,
  },
]

/** Full selector list, prompt agents first. */
export const CHAT_AGENTS: readonly ChatAgent[] = [...PROMPT_AGENTS, ...CLI_AGENTS]

/** The default selected agent (first prompt agent). */
export const DEFAULT_AGENT: ChatAgent = PROMPT_AGENTS[0]!
