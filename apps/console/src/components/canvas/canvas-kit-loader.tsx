'use client'

/**
 * Canvas Kit 页客户端 loader —— next/dynamic 懒加载（画布树浏览器端专属：
 * React Flow 初始化即量 DOM；骨架屏过渡与旧 loader 同形）。
 */

import dynamic from 'next/dynamic'
import type { CanvasKitPageProps } from './canvas-kit-page'

export const CanvasKitLoader = dynamic<CanvasKitPageProps>(
  () => import('./canvas-kit-page').then((m) => m.CanvasKitPage),
  {
    ssr: false,
    loading: () => (
      <div className='canvas-loading' role='status' aria-label='画布加载中'>
        <div className='canvas-loading-spinner' aria-hidden='true' />
      </div>
    ),
  },
)
