import type { ManagedServiceId } from './types'

// 监听者身份判别（docs/desktop-architecture.md §18.3，M8）——纯函数零网络依赖：
// 输入是「已抓取的 HTTP 结果」（httpGet 经 SupervisorDeps 注入），判别端口上的
// 监听者是不是真 dagents 实例。端口开 ≠ 附加：只有协议特征才放行附加，
// 堵住「任意 2xx 即附加」病灶（supervisor 旧 attach 判定/旧 console 健康判定）。
//
// 判别特征（协议既有，非新增面）：
//   gateway = GET /health → JSON svc === 'gateway'
//             （apps/gateway/src/app.ts /health：200 db:up 与 503 db:down 都带 svc，
//              503 也算 dagents——进程活语义，外部栈可能还没起库）
//   console = GET / → HTTP 2xx + <title> 含 'Dagents'
//             （apps/console/src/app/layout.tsx metadata title='Dagents'）
// 无响应 TCP（accept 不应答/非 HTTP 程序）→ 依赖注入层给 {error}，按 stranger 处理。

/** 身份判别三值中的两值——unreachable（端口关/超时）由调用方折叠进 stranger。 */
export type PortIdentity = 'dagents' | 'stranger'

/** 身份问询结果的最小形状（supervisor 的 HttpResult 结构兼容——零 import 依赖）。 */
export type HttpProbeResult = { status: number; body: string } | { error: string }

/** 身份问询 URL——与 supervisor 健康探测同面（gateway /health、console 根路径）。 */
export function probeUrl(id: ManagedServiceId, port: number): string {
  return id === 'gateway' ? `http://localhost:${port}/health` : `http://localhost:${port}/`
}

/** 从 HTML 抓 <title> 文本（大小写不敏感、容忍属性；抓不到/空白返回 null）。 */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  const text = m ? m[1].trim() : ''
  return text === '' ? null : text
}

/**
 * gateway 身份：应答体能解析为 JSON 且 svc === 'gateway' → dagents。
 * 状态码不参与（503 db:down 带同款 svc——进程活即 dagents，§18.3）；
 * 非 JSON / 无 svc / 网络错 → stranger（200 {"ok":true} 无 svc 正是盲附加病灶形态）。
 */
export function classifyGatewayIdentity(res: HttpProbeResult): PortIdentity {
  if ('error' in res) return 'stranger'
  try {
    const body = JSON.parse(res.body) as { svc?: unknown }
    return body.svc === 'gateway' ? 'dagents' : 'stranger'
  } catch {
    return 'stranger'
  }
}

/**
 * console 身份：HTTP 2xx + <title> 含 'Dagents' → dagents（standalone 首页实测
 * title 即 "Dagents"，§18.10 #11）。其余（含 Vite/Next 陌生页、非 2xx、网络错）
 * 一律 stranger。
 */
export function classifyConsoleIdentity(res: HttpProbeResult): PortIdentity {
  if ('error' in res) return 'stranger'
  if (res.status < 200 || res.status >= 300) return 'stranger'
  const title = extractHtmlTitle(res.body)
  return title !== null && title.includes('Dagents') ? 'dagents' : 'stranger'
}
