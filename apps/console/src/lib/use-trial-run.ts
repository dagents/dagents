'use client'

/**
 * use-trial-run —— 画布试运行编排 hook（R10，design-sharp §4/§7）。
 *
 * 职责：面板状态（选中节点/外部上游种子/http 口径/mock 规则/预供答案）、
 * 启动 POST /api/workflows/:id/trial、启动后把 runId 交回页面接管既有
 * watchLoop/结果面板三视图（**零新执行编排**，design-sharp §4.4）。
 *
 * 外部上游种子两级回退（D9）：面板手填（默认值预填 = 最近一次同 flow 正式
 * run 的该节点 span output——console 经 /api/runs + node-spans 两步反查；
 * P0 简化版，R2 暖缓存落地后共享其前驱查找服务）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildTrialSubgraph } from '@dagents/workflow'
import type { TrialMockScriptSet } from '@dagents/contracts'

export interface TrialSeedLookup {
  /** 每个外部上游的预填默认值（最近正式 run 同 nodeId 输出正文）。 */
  defaults: Record<string, string>
  /** 反查是否进行中（面板显示占位）。 */
  loading: boolean
}

export interface UseTrialRunOptions {
  flowId: string
  /** 页面当前画布文档 getter（打开面板时取最新草稿）。 */
  getFlowData: () => { nodes: unknown[]; edges: unknown[] } | null
  /** 启动成功后的接管回调（页面 setWatch + runState running）。 */
  onStarted: (runId: string) => void
}

export interface TrialStartInput {
  input?: string
  httpMode: 'skip' | 'real'
  seedInputs: Record<string, string>
  humanInputs: Record<string, string>
  mockScript?: TrialMockScriptSet
  directoryId?: string
}

export function useTrialRun({ flowId, getFlowData, onStarted }: UseTrialRunOptions) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [externalUpstreams, setExternalUpstreams] = useState<string[]>([])
  const [seedDefaults, setSeedDefaults] = useState<Record<string, string>>({})
  const [seedLoading, setSeedLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [rejectError, setRejectError] = useState<{ message: string; nodes: string[] } | null>(null)
  const startedRunIdRef = useRef<string | null>(null)
  const [startedRunId, setStartedRunId] = useState<string | null>(null)

  /** 打开面板：计算选中 scope 的外部上游（裁剪器同源纯函数）。 */
  const openPanel = useCallback(
    (selectedId: string | null): void => {
      setSelectedNodeId(selectedId)
      setStartError(null)
      setRejectError(null)
      const flow = getFlowData()
      if (flow) {
        try {
          const trial = buildTrialSubgraph(
            flow as never,
            selectedId ? { nodeIds: [selectedId] } : null,
          )
          setExternalUpstreams(trial.externalUpstreams)
        } catch {
          setExternalUpstreams([])
        }
      } else {
        setExternalUpstreams([])
      }
      setPanelOpen(true)
    },
    [getFlowData],
  )

  /** 种子默认值预填：最近正式 run 同 nodeId 输出（两级回退的 ②）。 */
  useEffect(() => {
    if (!panelOpen || externalUpstreams.length === 0) return
    let cancelled = false
    setSeedLoading(true)
    setSeedDefaults({})
    void (async () => {
      try {
        // P0 简化：取最近 3 次正式 run（listRunsHistory 默认已滤 trial 行），
        // 找每个上游节点最近一次 done span 的输出正文。
        const res = await fetch(`/api/runs?flowId=${encodeURIComponent(flowId)}&limit=3`)
        const json = (await res.json()) as { success?: boolean; data?: Array<{ runId: string }> }
        const runs = json.data ?? []
        const found: Record<string, string> = {}
        for (const r of runs) {
          if (cancelled) return
          if (externalUpstreams.every((id) => found[id] !== undefined)) break
          try {
            const sp = await fetch(`/api/workflows/runs/${encodeURIComponent(r.runId)}/node-spans`)
            const spJson = (await sp.json()) as {
              data?: {
                spans?: Array<{ nodeId: string; status: string; output?: unknown }>
              }
            }
            for (const span of spJson.data?.spans ?? []) {
              if (found[span.nodeId] !== undefined) continue
              if (span.status !== 'done' && span.status !== 'completed') continue
              const out = span.output as { content?: unknown; text?: unknown } | null
              const text =
                typeof out?.content === 'string'
                  ? out.content
                  : typeof out?.text === 'string'
                    ? out.text
                    : ''
              if (text.length > 0) found[span.nodeId] = text.slice(0, 4000)
            }
          } catch {
            // 单个 run 的 spans 查询失败不影响其余候选
          }
        }
        if (!cancelled) setSeedDefaults(found)
      } catch {
        // 反查失败：面板手填仍是主路径（两级回退的 ①）
      } finally {
        if (!cancelled) setSeedLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [panelOpen, externalUpstreams, flowId])

  /** 启动试运行。返回 runId（失败返回 null 并置 startError/rejectError）。 */
  const start = useCallback(
    async (input: TrialStartInput): Promise<string | null> => {
      setStarting(true)
      setStartError(null)
      setRejectError(null)
      try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(flowId)}/trial`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: input.input ?? '',
            ...(selectedNodeId ? { scope: { nodeIds: [selectedNodeId] } } : {}),
            ...(input.mockScript ? { mockScript: input.mockScript } : {}),
            httpMode: input.httpMode,
            ...(Object.keys(input.seedInputs).length > 0 ? { seedInputs: input.seedInputs } : {}),
            ...(Object.keys(input.humanInputs).length > 0
              ? { humanInputs: input.humanInputs }
              : {}),
            ...(input.directoryId ? { directoryId: input.directoryId } : {}),
          }),
        })
        const json = (await res.json().catch(() => null)) as {
          success?: boolean
          data?: { runId?: string }
          error?: string
          detail?: { errors?: Array<{ node?: string; message: string }> }
        } | null
        if (!res.ok || !json?.success || !json.data?.runId) {
          // 前置校验拒绝（422）：带 node 定位——面板显示「与保存校验同体验」。
          if (res.status === 422 && json?.detail?.errors) {
            setRejectError({
              message: json.error ?? '试运行前置校验未通过',
              nodes: json.detail.errors.map((e) => e.node ?? e.message).filter(Boolean),
            })
          } else {
            setStartError(json?.error ?? `试运行启动失败（${res.status}）`)
          }
          return null
        }
        const runId = json.data.runId
        startedRunIdRef.current = runId
        setStartedRunId(runId)
        onStarted(runId)
        setPanelOpen(false)
        return runId
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setStarting(false)
      }
    },
    [flowId, selectedNodeId, onStarted],
  )

  const seedLookup: TrialSeedLookup = useMemo(
    () => ({ defaults: seedDefaults, loading: seedLoading }),
    [seedDefaults, seedLoading],
  )

  return {
    panelOpen,
    openPanel,
    closePanel: () => setPanelOpen(false),
    selectedNodeId,
    externalUpstreams,
    seedLookup,
    starting,
    startError,
    rejectError,
    start,
    startedRunId,
  }
}
