'use client'

/**
 * useOnboarding — shared hook that probes the setup endpoints and reports
 * whether all onboarding steps are complete.
 *
 * Mirrors the probe logic in OnboardingChecklist so the completion banner,
 * enhanced suggestion cards, and the checklist itself stay in sync without
 * duplicating fetch wiring in every component.
 *
 * In the inline-executor architecture there is NO daemon step and NO LLM
 * provider requirement — the gateway spawns CLI agents directly, and chat
 * runs on the CLI's own LLM config. Only 3 steps matter:
 *   1. ✅ 项目目录已添加  → GET /api/directories returns ≥1
 *   2. ✅ CLI 已安装      → GET /api/cli-runtimes returns ≥1 available
 *   3. ✅ Agent 已创建    → GET /api/agents returns ≥1
 *
 * The gateway wraps every response as `{ success, data: { ... } }`; this hook
 * defensively unwraps both the envelope and the bare-array shapes. Any fetch
 * failure counts as not-complete.
 */
import { useEffect, useState } from 'react'

export interface OnboardingState {
  /** True only when all 3 steps are done. */
  complete: boolean
  /** False during the first probe, true once it settles (success or error). */
  loading: boolean
}

type UnknownRecord = Record<string, unknown>

function pickList(body: unknown, envelopeKey: string, bareKey: string): UnknownRecord[] {
  if (!body || typeof body !== 'object') return []
  const env = body as { data?: UnknownRecord; success?: boolean }
  const inner = env.data ?? (body as UnknownRecord)
  const list =
    (inner as Record<string, unknown>)[envelopeKey] ??
    (body as Record<string, unknown>)[bareKey] ??
    (Array.isArray(body) ? body : null)
  return Array.isArray(list) ? (list as UnknownRecord[]) : []
}

async function checkOnboardingComplete(): Promise<boolean> {
  const [dirsRes, cliRes, agentsRes, providersRes] = await Promise.all([
    fetch('/api/directories'),
    fetch('/api/cli-runtimes'),
    fetch('/api/agents'),
    fetch('/api/llm-providers'),
  ])

  const dirs = dirsRes.ok ? await dirsRes.json() : null
  const cli = cliRes.ok ? await cliRes.json() : null
  const agents = agentsRes.ok ? await agentsRes.json() : null
  const providers = providersRes.ok ? await providersRes.json() : null

  const dirList = pickList(dirs, 'items', 'items')
  const runtimeList = pickList(cli, 'runtimes', 'runtimes')
  const agentList = pickList(agents, 'agents', 'agents')
  const providerList = pickList(providers, 'providers', 'providers')

  // CLI 运行时检测：gateway 扫描 PATH，至少一个 binary available 即视为已安装；
  // 无 CLI 时一个已配置的 LLM Provider 同样构成可执行引擎（方案 F 的出口）
  const hasInstalledRuntime = runtimeList.some((r) => r.available === true)
  const hasProvider = providerList.length > 0

  return (
    dirList.length > 0 &&
    (hasInstalledRuntime || hasProvider) &&
    agentList.length > 0
  )
}

export function useOnboarding(): OnboardingState {
  const [state, setState] = useState<OnboardingState>({ complete: false, loading: true })

  useEffect(() => {
    let cancelled = false
    void checkOnboardingComplete()
      .then((complete) => {
        if (!cancelled) setState({ complete, loading: false })
      })
      .catch(() => {
        if (!cancelled) setState({ complete: false, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
