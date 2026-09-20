'use client'

/**
 * use-run-live.ts — 运行实时终端（live attach）的编排 hook。
 *
 * 订阅网关 run-live SSE 帧流，把帧交给 createLiveSectionBuilder 增量构建
 * RunTerminal 的段结构。与 use-shell-session 同族但更薄：无输入通道（插话
 * 仍走既有 POST message）、无恢复偏好，只有「连上 → 直播 → 关流」一条线。
 *
 * 可用性阶梯（诚实降级，不冒充直播）：
 *   off         无 runId（未在运行）
 *   connecting  SSE 握手中 —— UI 继续用 node-spans 轮询渲染
 *   live        hello 已到（含回放前缀），段结构由帧流驱动
 *   closed      收到 runEnd 后服务端关流 —— 内容保留展示（终态渲染即将由
 *               轮询的 runState 翻转接管，两者内容等价）
 *   unavailable 404 / 流中断未收 runEnd —— 回退 node-spans 轮询渲染（DB 路径）
 */

import { useEffect, useRef, useState } from 'react'
import { createRunLiveParser } from '@/lib/run-live-protocol'
import { createLiveSectionBuilder, type TerminalSection } from '@/lib/run-terminal-format'

export type RunLiveMode = 'off' | 'connecting' | 'live' | 'closed' | 'unavailable'

export function useRunLive(runId: string | null): {
  mode: RunLiveMode
  sections: TerminalSection[]
} {
  const [mode, setMode] = useState<RunLiveMode>('off')
  const [sections, setSections] = useState<TerminalSection[]>([])
  const modeRef = useRef<RunLiveMode>('off')

  useEffect(() => {
    if (!runId) {
      modeRef.current = 'off'
      setMode('off')
      setSections([])
      return
    }
    modeRef.current = 'connecting'
    setMode('connecting')
    setSections([])

    const controller = new AbortController()
    const builder = createLiveSectionBuilder()
    const parser = createRunLiveParser()
    let sawRunEnd = false

    const consume = async (): Promise<void> => {
      let res: Response
      try {
        res = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}/live`, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { accept: 'text/event-stream' },
        })
      } catch {
        if (!controller.signal.aborted) {
          modeRef.current = 'unavailable'
          setMode('unavailable')
        }
        return
      }
      if (!res.ok || !res.body) {
        modeRef.current = 'unavailable'
        setMode('unavailable')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const events = parser(decoder.decode(value, { stream: true }))
          if (events.length === 0) continue
          for (const evt of events) {
            if (evt.event === 'hello') {
              for (const f of evt.hello.replay) builder.push(f)
              modeRef.current = 'live'
              setMode('live')
              if (evt.hello.ended) sawRunEnd = true
            } else {
              builder.push(evt.frame)
              if (evt.frame.type === 'runEnd') sawRunEnd = true
            }
          }
          setSections(builder.sections())
          if (sawRunEnd) break
        }
      } catch {
        /* 中断（abort）/ 网络错 —— 统一走下方关流判定 */
      }
      // 卸载/换 run 的主动中断不翻状态（组件即将重置）。
      if (controller.signal.aborted) return
      // 关流有 runEnd = 干净收口；否则视为直播断流 —— 回退轮询渲染。
      if (sawRunEnd) {
        modeRef.current = 'closed'
        setMode('closed')
      } else if (modeRef.current === 'live' || modeRef.current === 'connecting') {
        modeRef.current = 'unavailable'
        setMode('unavailable')
      }
    }
    void consume()

    return () => {
      controller.abort()
    }
  }, [runId])

  return { mode, sections }
}
