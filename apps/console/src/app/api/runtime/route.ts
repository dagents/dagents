/**
 * Console runtime config endpoint（桌面动态端口 M9，docs/desktop-architecture.md §18.5）。
 *
 * 病灶：浏览器侧两处直连 gateway 的面在端口漂移下会断——①WS URL
 * （`NEXT_PUBLIC_WS_URL` 是 build 期内联，运行时 env 救不了已构建的 client
 * bundle，ws-client.ts 顶部注释自证）；②daemons 注册命令展示内建 8080。
 * 为什么壳层/env 注入解决不了：这些值在**浏览器进程**里使用——主进程 env 注入
 * 只达 server 侧；`webContents.executeJavaScript` 注入只在 Electron 窗口内生效
 * 且与页面加载竞态，「在浏览器打开」场景即失效。BFF 路由是浏览器可达的唯一
 * 服务端运行时通道（`GATEWAY_URL` 服务端运行时读，lib/config.ts:13——桌面壳
 * spawn 时注入，实测运行时生效），~15 行是最小面。
 *
 * GET /api/runtime → { gatewayUrl, wsUrl }
 *   - gatewayUrl：BFF 实际对接的 gateway 地址（GATEWAY_URL ?? 默认 8080）
 *   - wsUrl：由 gatewayUrl 派生（协议翻 + /ws，单源 ws-url.ts）
 * 未设 GATEWAY_URL 时返回默认 8080——dev/e2e 行为零变化（降级不回归）。
 * `force-dynamic`：绝不能被 build 期预渲染缓存（端口语义是运行时的）。
 */

import { NextResponse } from 'next/server'
import { gatewayUrl } from '@/lib/config'
import { wsUrlOfGateway } from '@/lib/ws-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const gw = gatewayUrl()
  return NextResponse.json({ gatewayUrl: gw, wsUrl: wsUrlOfGateway(gw) })
}
