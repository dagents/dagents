/**
 * WS URL 解析（桌面动态端口 M9，docs/desktop-architecture.md §18.5）。
 *
 * 病灶：`NEXT_PUBLIC_WS_URL` 是 build 期内联——打包后的 client bundle 救不了
 * 运行时端口漂移（gateway 让位到 8081 时浏览器仍拨 ws://localhost:8080/ws，
 * WS 断流只剩轮询）。本模块给出三级解析，供 ws-client 首连前调用：
 *
 *   1. `NEXT_PUBLIC_WS_URL` 显式设置（build 期内联）—— e2e/自定义构建逃生门，优先
 *   2. BFF `/api/runtime` 运行时返回的 wsUrl（服务端读 GATEWAY_URL 派生——桌面
 *      壳注入的实际端口在此到达浏览器）
 *   3. 默认 `ws://localhost:8080/ws` —— 与改造前行为一致（降级不回归：fetch
 *      失败/形状异常时 WS 断→轮询，即现状最差行为）
 *
 * 纯函数零依赖：fetch 通道经参数注入，可全测。
 */

/** 与改造前一致的默认值（gateway WS 面挂在单一 HTTP server 的 /ws，ws-hub.ts:83）。 */
export const DEFAULT_WS_URL = 'ws://localhost:8080/ws'

/** gateway http(s) 地址 → WS 面（协议翻 + 追 /ws）；供 /api/runtime 与客户端共用单源。 */
export function wsUrlOfGateway(gatewayUrl: string): string {
  const base = gatewayUrl.trim().replace(/\/+$/, '')
  const wsBase = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
  return `${wsBase}/ws`
}

/** build 期内联的显式值（未设置返回 null——走运行时解析）。 */
export function explicitWsUrl(): string | null {
  const v = process.env.NEXT_PUBLIC_WS_URL
  if (typeof v !== 'string' || v.trim() === '') return null
  return v.trim().replace(/\/+$/, '')
}

/** /api/runtime 响应的最小形状（多余字段忽略）。 */
export interface RuntimeConfig {
  wsUrl?: unknown
  gatewayUrl?: unknown
}

/** 形状校验：只有 wss?:// 开头的字符串才可信（防异常响应劫持拨号面）。 */
function trustedWsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim().replace(/\/+$/, '')
  return /^wss?:\/\//.test(trimmed) ? trimmed : null
}

/**
 * 三级解析（首连前一次，调用方缓存）：
 * explicit（build 期）→ runtime（BFF 运行时）→ 默认。任一失败静默降级到默认
 * —— R17：降级即现状最差行为（轮询回退），不回归。
 */
export async function resolveWsUrl(
  fetchRuntime: () => Promise<RuntimeConfig | null>,
): Promise<string> {
  const explicit = explicitWsUrl()
  if (explicit !== null) return explicit
  try {
    const runtime = await fetchRuntime()
    if (runtime !== null) {
      const trusted = trustedWsUrl(runtime.wsUrl)
      if (trusted !== null) return trusted
    }
  } catch {
    // /api/runtime 不可达（非桌面形态/代理异常）——默认兜底
  }
  return DEFAULT_WS_URL
}
