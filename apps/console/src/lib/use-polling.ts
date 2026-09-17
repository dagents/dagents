'use client'

/**
 * use-polling —— 轮询循环的单点实现（2026-09-17 整改：收敛手写 setInterval）。
 *
 * 此前 flows-view / flow-runs-panel / canvas watchLoop 各自手写一套
 * 「setTimeout 链 + cancelled 标记 + 卸载清理」，其中 flows-view 还踩过
 * stale-closure（轮询延续判定读了 effect 建立时的旧 state，实际只在
 * visibilitychange 时轮一次）。本 hook 固化正确形态：
 *
 *  - fetcher 返回「是否继续轮询」—— 必须基于**本轮刚 fetch 到的新数据**
 *    判定，绝不读闭包里的旧 state（这正是 stale-closure 的病根）；
 *  - 终态即停：fetcher 返回 false 后不再排下一轮，后台不空转；
 *  - visibilityPause：页面隐藏期间不发起下一轮，重新可见立即补一轮
 *    （后台 tab 不空转，回来第一时间看到最新状态）；
 *  - 可选失败退避（backoffMaxMs）：fetcher 抛错时间隔翻倍直至上限，
 *    成功后复位 —— 不配置则不退避（保持调用方既有语义）；
 *  - restartKey 变化即重入：清掉在途定时器并立即补一轮，用于
 *    「手动刷新 tick / 换了轮询目标」这类外部触发。
 *
 * fetcher 为 null 时完全不轮询（active=false）；fetcher 身份变化不重入
 * （存 ref，每轮取最新），只有 null↔非 null 与 restartKey 变化才重入。
 */

import { useEffect, useRef } from 'react'

export interface UsePollingOptions {
  /** 轮询间隔（ms）。 */
  intervalMs: number
  /** 页面隐藏时暂停（默认 false）：隐藏期间不排下一轮，重新可见立即补一轮。 */
  visibilityPause?: boolean
  /** 失败退避上限（ms）：fetcher 抛错时间隔逐次翻倍直至该上限，成功后复位。
   *  缺省不退避（失败后按原间隔重试）。 */
  backoffMaxMs?: number
  /** 重入键：变化时清掉在途定时器并立即补一轮（手动刷新 tick / 换目标）。 */
  restartKey?: string | number | null
}

/**
 * 声明式轮询。fetcher 返回 true 继续下一轮、false 停止；抛错按「继续」
 * 处理（配合 backoffMaxMs 可退避）。首个非空 fetcher 挂载 / restartKey
 * 变化时立即执行一轮，之后按 intervalMs 排程。
 */
export function usePolling(
  fetcher: (() => Promise<boolean>) | null,
  options: UsePollingOptions,
): void {
  const { intervalMs, visibilityPause = false, backoffMaxMs, restartKey } = options
  // fetcher 存 ref：身份变化（闭包刷新）不打断在途循环，每轮取最新实现
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const active = fetcher != null

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let ticking = false
    let delay = intervalMs

    const clearTimer = (): void => {
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const tick = async (): Promise<void> => {
      if (cancelled || ticking) return
      // 暂停中不干活：等 visibilitychange 回来补轮（此时不排定时器）
      if (visibilityPause && document.hidden) return
      const fn = fetcherRef.current
      if (!fn) return
      ticking = true
      let more = true
      try {
        more = await fn()
        if (backoffMaxMs != null) delay = intervalMs // 成功复位退避
      } catch {
        if (backoffMaxMs != null) delay = Math.min(delay * 2, backoffMaxMs)
      } finally {
        ticking = false
      }
      if (cancelled) return
      if (more) {
        clearTimer()
        timer = setTimeout(() => {
          timer = null
          void tick()
        }, delay)
      }
      // more=false：终态即停，不再排下一轮
    }

    void tick()

    const onVisibility = (): void => {
      if (cancelled || document.visibilityState !== 'visible') return
      // 暂停期间被吞掉的轮次立即补上（在途/已排程的不重复发）
      if (timer == null && !ticking) void tick()
    }
    if (visibilityPause) document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      clearTimer()
      if (visibilityPause) document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, intervalMs, visibilityPause, backoffMaxMs, restartKey])
}
