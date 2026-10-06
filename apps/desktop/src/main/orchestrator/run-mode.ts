import { join } from 'node:path'
import type { DesktopConfig, ServiceRunSpec } from './types'

// 运行形态解析与 packaged 服务规格（docs/desktop-architecture.md §11.4，M6）。
// 纯函数——resourcesPath/execPath 由调用方（index.ts）探测注入，可全测。

export type RunMode = 'dev' | 'packaged'

/**
 * 三级模式开关（零配置默认 packaged）：
 *   1. config.mode 显式 'dev' → dev（仓库 dev 栈：pnpm dev + 外部/内嵌 PG）
 *   2. config.mode 显式 'packaged' → packaged
 *   3. 'auto'（默认）→ 安装包内嵌栈在位（resources/services/gateway/dist）则 packaged，
 *      否则 dev（仓库形态：resourcesPath 指向 electron 发行目录，不含 services）。
 * 附加模式（8080 已监听）与 mode 正交——packaged 下同样不 spawn（startAsync 判定）。
 */
export function resolveRunMode(
  config: Pick<DesktopConfig, 'mode'>,
  opts: { packagedServicesExists: boolean }
): RunMode {
  if (config.mode === 'dev') return 'dev'
  if (config.mode === 'packaged') return 'packaged'
  return opts.packagedServicesExists ? 'packaged' : 'dev'
}

export interface PackagedStack {
  /** resources/services（安装包 extraResources 落位根）。 */
  servicesDir: string
  /** ELECTRON_RUN_AS_NODE 载体（打包后 = dagents.exe；dev 探测场景不适用）。 */
  execPath: string
}

/**
 * packaged 两服务的 spawn 规格：
 *   gateway  = <execPath> services/gateway/dist/index.js（ELECTRON_RUN_AS_NODE + GATEWAY_PORT）
 *   console  = <execPath> services/console/apps/console/.next-build/server.js
 *              （standalone 三件套镜像树；PORT/HOSTNAME/GATEWAY_URL/NODE_ENV=production）
 * env 顺序：extraEnv（用户逃生门）→ POSTGRES_URL 由 Orchestrator 最后注入（gateway）。
 */
export function packagedRunSpecs(
  p: PackagedStack & { extraEnv: Record<string, string> }
): { gateway: ServiceRunSpec; console: ServiceRunSpec } {
  const gwDir = join(p.servicesDir, 'gateway')
  const csDir = join(p.servicesDir, 'console')
  const base = { ELECTRON_RUN_AS_NODE: '1', ...p.extraEnv }
  return {
    gateway: {
      command: p.execPath,
      args: [join(gwDir, 'dist', 'index.js')],
      cwd: gwDir,
      env: { ...base, GATEWAY_PORT: '8080' },
    },
    console: {
      command: p.execPath,
      // server.js 在 standalone 镜像树 app 目录直下（distDir 层不镜像入口，实测）；
      // static/public 已由 stage-stack 摆到 server.js 解析得到的位置（<app>/<distDir>/static、<app>/public）
      args: [join(csDir, 'apps', 'console', 'server.js')],
      cwd: csDir,
      env: {
        ...base,
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '127.0.0.1',
        GATEWAY_URL: 'http://localhost:8080',
      },
    },
  }
}
