/**
 * FlowEditorFrame — 嵌入式 Flowise 画布编辑器 (M2.3).
 *
 * 这是 audit §1.5（design/agentflows.html:350 `<button data-action="edit">编辑画布</button>`）
 * 的着陆组件：把 design 里的占位 alert 接到 Flowise 原生画布编辑页，通过
 * `<iframe>` 嵌进 AppShell 主区域，用户不离开控制台即可编排节点/连线。
 *
 * ## 为什么是 iframe 而非移植画布
 *
 * spec §1.10 / audit §1.5：画布编辑仍用 Flowise 原生 UI，console 只做
 * 浏览/监控/管理。React Flow 只读 DAG（flow-dag.tsx）已覆盖浏览；编辑侧
 * 用 iframe 嵌入 Flowise 的 `/canvas/<chatflowId>` 路由，无需改 fork 源码。
 *
 * ## CSP 放行
 *
 * Flowise 服务端 `XSS.ts:getIframeSecurityHeaders()` 读 `IFRAME_ORIGINS` 并
 * 发成 CSP `frame-ancestors`；M0.3 已在 vendor/flowise/packages/server/
 * .env.mil-agents 配 `IFRAME_ORIGINS=http://localhost:3000`，所以控制台
 * :3000 可嵌入 Flowise :3100 画布。本组件只管 iframe SRC 侧（`flowiseEditorUrl()`
 * 来自 M0.3 的 config.ts）。
 *
 * ## ?external=1 降级
 *
 * 当 query 带 `external=1`（例如 CSP 未放行的预览环境，或希望用整页画布）
 * 时不渲染 iframe，改为渲染「在新标签打开」外链卡片（`<a target="_blank"
 * rel="noopener noreferrer">`），fallback 到原生整页 Flowise 画布。
 */

import { flowiseEditorUrl } from '@/lib/config'
import '@/styles/flow-editor.css'

export interface FlowEditorFrameProps {
  /** Flowise chatflow id（路由 [id]）。 */
  chatflowId: string
  /** 为 true 时渲染「在新标签打开」降级卡片，而非 iframe。 */
  external?: boolean
}

/**
 * 拼 Flowise 画布编辑器 URL：`<flowiseEditorUrl()>/canvas/<chatflowId>`。
 * flowiseEditorUrl() 已剥离尾斜杠（见 config.ts），所以这里安全地拼接 `/canvas/`。
 * 独立成纯函数，测试可直接断言 src 含 `/canvas/<id>`。
 */
export function flowiseCanvasUrl(chatflowId: string): string {
  return `${flowiseEditorUrl()}/canvas/${chatflowId}`
}

export function FlowEditorFrame({
  chatflowId,
  external = false,
}: FlowEditorFrameProps): React.ReactElement {
  const src = flowiseCanvasUrl(chatflowId)

  if (external) {
    return (
      <div className="flow-editor-external">
        <div className="flow-editor-external-card">
          <div className="title">在新标签打开画布编辑器</div>
          <p className="desc">
            当前环境未启用 iframe 嵌入，或你希望使用整页画布。点击下方按钮在
            新标签打开 Flowise 原生画布编辑器进行节点拖拽与连线编辑。
          </p>
          <div className="mono" style={{ marginBottom: 'var(--space-4)' }}>{src}</div>
          <a
            className="btn btn-accent btn-sm"
            href={src}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开 Flowise 画布 ↗
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flow-editor">
      <iframe
        title="Flowise 画布编辑器"
        src={src}
        className="flow-editor-iframe"
        allow="clipboard-write; fullscreen"
      />
    </div>
  )
}
