'use client'

/**
 * useOnboarding — shared hook that probes the 4 setup endpoints and reports
 * whether all onboarding steps are complete.
 *
 * Mirrors the probe logic in OnboardingChecklist so the completion banner,
 * enhanced suggestion cards, and the checklist itself stay in sync without
 * duplicating fetch wiring in every component.
 *
 *   1. ✅ 项目目录已添加  → GET /api/directories returns ≥1
 *   2. ✅ LLM Provider 已配置 → GET /api/llm-providers returns ≥1
 *   3. ✅ Daemon 已启动  → GET /api/daemons returns ≥1 online/idle
 *   4. ✅ Agent 已创建  → GET /api/agents returns ≥1
 *
 * The gateway wraps every response as `{ success, data: { ... } }`; this hook
 * defensively unwraps both the envelope and the bare-array shapes.
 */
import { useEffect, useState } from 'react'

export interface OnboardingState {
  /** True only when all 4 steps are done. */
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
  const [dirsRes, llmRes, daemonsRes, agentsRes] = await Promise.all([
    fetch('/api/directories'),
    fetch('/api/llm-providers'),
    fetch('/api/daemons'),
    fetch('/api/agents'),
  ])

  const dirs = dirsRes.ok ? await dirsRes.json() : null
  const llms = llmRes.ok ? await llmRes.json() : null
  const daemons = daemonsRes.ok ? await daemonsRes.json() : null
  const agents = agentsRes.ok ? await agentsRes.json() : null

  const dirList = pickList(dirs, 'items', 'items')
  const llmList = pickList(llms, 'providers', 'providers')
  const daemonList = pickList(daemons, 'daemons', 'daemons')
  const agentList = pickList(agents, 'agents', 'agents')

  const hasOnlineDaemon = daemonList.some(
    (d) => d.status === 'online' || d.status === 'idle',
  )

  return (
    dirList.length > 0 &&
    llmList.length > 0 &&
    hasOnlineDaemon &&
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
