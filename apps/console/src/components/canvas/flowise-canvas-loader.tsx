'use client'

import dynamic from 'next/dynamic'
import type { FlowiseCanvasProps } from './flowise-canvas'
import '@/components/canvas/canvas.css'

// Agentflow 依赖链里的 flowise-react-json-view 在模块顶层访问 `document`，
// 无法 SSR（服务端渲染直接 500）。画布本身是纯客户端交互组件，
// 用 ssr:false 动态加载整棵树，服务端只传 props。
const FlowiseCanvas = dynamic(
  () => import('./flowise-canvas').then((m) => m.FlowiseCanvas),
  {
    ssr: false,
    loading: () => (
      // 骨架屏占位：顶栏条 + 节点块的形状暗示，比一行灰字更「像画布」，
      // 也避免大 bundle 加载期的整屏空白跳变。纯视觉，无文字（a11y 走 aria）。
      <div className="canvas-loading" role="status" aria-label="画布加载中">
        <div className="canvas-loading-topbar">
          <span className="canvas-loading-chip" style={{ width: 120 }} />
          <span className="canvas-loading-chip" style={{ width: 64 }} />
          <span className="canvas-loading-chip" style={{ width: 64 }} />
        </div>
        <div className="canvas-loading-body">
          <span className="canvas-loading-node" style={{ left: '12%', top: '30%' }} />
          <span className="canvas-loading-node" style={{ left: '34%', top: '18%' }} />
          <span className="canvas-loading-node" style={{ left: '38%', top: '52%' }} />
          <span className="canvas-loading-node" style={{ left: '62%', top: '34%' }} />
          <span className="canvas-loading-node" style={{ left: '78%', top: '44%' }} />
        </div>
      </div>
    ),
  },
)

export function FlowiseCanvasLoader(props: FlowiseCanvasProps): React.ReactElement {
  return <FlowiseCanvas {...props} />
}
