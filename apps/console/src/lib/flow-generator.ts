/**
 * Chat-model dropdown mapping for the agentflow canvas's GenerateFlowDialog.
 *
 * The vendor dialog calls two Flowise-shaped endpoints through the
 * `/api/flowise/api/v1/*` BFF prefix:
 *   GET  /assistants/chatmodels            → model list for the dropdown (here)
 *   POST /agentflowv2-generator/generate   → thin proxy to the gateway's
 *                                            unified generation pipeline
 *
 * Since A1 (docs/product-plan.md) the generation itself — prompt, engine
 * selection, normalization, validation, repair loop — lives entirely in the
 * gateway (`apps/gateway/src/routes/flow-generator.ts`); what remains here is
 * pure dropdown-shape mapping (BFF boundary rule: proxy + shape adaptation
 * only, no business decisions).
 *
 * Model identity scheme: `"<providerId>::<modelId>"`; `agent::<id>` marks
 * "generate via this platform agent"; the fallback entry `gateway-default`
 * means the gateway's CLI-first baseline.
 */

/** Vendor ChatModel shape (GenerateFlowDialog dropdown entry). */
export interface ChatModel {
  name: string
  label: string
  description?: string
  category?: string
}

/** Minimal provider shape from GET /api/v1/llm-providers. */
export interface ProviderLike {
  id: string
  name: string
  providerType?: string
  defaultModel?: string | null
  models?: unknown[]
  status?: string
}

/** Minimal agent shape from GET /api/v1/agents (the /agents page catalogue). */
export interface AgentLike {
  id: string
  name: string
  kind: string
}

/** Dropdown-name prefix marking "generate via this platform agent" entries. */
export const AGENT_MODEL_PREFIX = 'agent::'

/** Dropdown entry used when no provider is configured — generation still
 *  works via the gateway's CLI-first baseline (no provider required). */
export const FALLBACK_MODEL: ChatModel = {
  name: 'gateway-default',
  label: '平台默认（CLI 优先）',
  description: '优先使用本机 CLI 生成；也可在 设置 → LLM Provider 配置 HTTP Provider 加速。',
  category: 'default',
}

/** Map configured providers + platform agents → chat-model dropdown entries.
 *  Agent entries (`agent::<id>`) run the generation on the agent's CLI
 *  backend; the gateway resolves the string back to an engine. */
export function listChatModels(providers: ProviderLike[], agents: AgentLike[] = []): ChatModel[] {
  const models: ChatModel[] = []
  for (const p of providers) {
    const modelIds = (Array.isArray(p.models) && p.models.length > 0
      ? p.models
      : p.defaultModel
        ? [p.defaultModel]
        : []
    ).map(String)
    for (const m of modelIds) {
      models.push({
        name: `${p.id}::${m}`,
        label: `${p.name} · ${m}`,
        description: p.providerType,
        category: p.providerType,
      })
    }
  }
  for (const a of agents) {
    models.push({
      name: `${AGENT_MODEL_PREFIX}${a.id}`,
      label: `${a.name} · Agent`,
      description: `平台 Agent（${a.kind}）— 用该 Agent 的 CLI 执行生成`,
      category: 'agent',
    })
  }
  return models.length > 0 ? models : [FALLBACK_MODEL]
}
