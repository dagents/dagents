'use client'

import dynamic from 'next/dynamic'
import type { FlowiseCanvasProps } from './flowise-canvas'

// Agentflow 依赖链里的 flowise-react-json-view 在模块顶层访问 `document`，
// 无法 SSR（服务端渲染直接 500）。画布本身是纯客户端交互组件，
// 用 ssr:false 动态加载整棵树，服务端只传 props。
const FlowiseCanvas = dynamic(
  () => import('./flowise-canvas').then((m) => m.FlowiseCanvas),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          width: '100%',
          height: '100%',
          minHeight: 520,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--meta, #888)',
          fontSize: 14,
        }}
      >
        画布加载中…
      </div>
    ),
  },
)

export function FlowiseCanvasLoader(props: FlowiseCanvasProps): React.ReactElement {
  return <FlowiseCanvas {...props} />
}
