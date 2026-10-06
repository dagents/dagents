# dagents 桌面客户端（@dagents/desktop）

给本地优先用户的 win/mac/linux 原生应用：**安装包内嵌 Postgres 与生产级 gateway/console 服务栈**（M6 起），下载安装、双击即用——零仓库检出 / 零 pnpm / 零 node / 零 docker；开发者仍可用 `config.json` 切回仓库 dev 栈或附加到已运行的本机服务。架构真相源：[`docs/desktop-architecture.md`](../../docs/desktop-architecture.md)。

## 它做什么

- **安装包即一体盒（M6）**：`pnpm dist:win` 产出内嵌全栈的 NSIS 安装包（electron-builder extraResources 携带内嵌 PG 二进制 + gateway 生产 deploy 树 + console standalone 三件套，运行时全走 `ELECTRON_RUN_AS_NODE`——不要求目标机有 node/pnpm/docker）。三级模式开关零配置：安装包内嵌栈在位即 **packaged**；`config.json` 显式 `"mode": "dev"` 回落仓库 dev 栈；8080 已被监听则附加不 spawn。实测 win 全新机器语义：安装→双击→**30s 内** PG 就绪 + gateway `db:up` + 工作台接管；优雅退出端口/进程全净；卸载保留用户数据。
- **内嵌 Postgres（M5）**：应用自带 PostgreSQL 16 二进制（`@embedded-postgres` tarball 经 `pnpm ensure:postgres` 显式按需下载，不进 npm 依赖）；首启自动 `initdb` 到 `userData/pgdata` → 前台直跑 `postgres`（只绑 127.0.0.1）→ 建库 → 跑迁移 → gateway 经 `POSTGRES_URL` 注入连接——**应用启动即数据库就绪，退出即停净**（`pg_ctl stop -m fast` 优先，树终止兜底）。默认端口 **55432**（避开 5432 原生/15432 infra docker），被占自动 +1 让位（≤20 次），实际端口在日志与状态页明示。
- **进程编排**：spawn `pnpm --filter @dagents/gateway dev`（:8080）与 `pnpm --filter @dagents/console dev`（:3000）为子进程；健康轮询（gateway `/health` 判 200+`ok:true`，console 判 HTTP 200，pg 判 TCP 端口探活；启动期 500ms/运行期 5s）；意外退出**有界自动重启**（5 分钟窗内 3 次，退避 1s/3s/9s，耗尽转 failed 等手动重试）；停止即整棵进程树终止（win32 `taskkill /T /F`）。启动顺序 **pg → gateway → console**，停止反序；pg 起不来或迁移失败 → gateway 不启动（状态页三卡诚实展示）。
- **就绪接管 + 双向导航（M7）**：双服务健康后窗口自动加载 `http://localhost:3000`（console 单真相源，零 UI fork）；console 崩溃/健康跌落自动回退本地启动态页显示恢复过程。启动态页与工作台**双向可达**（contentIntent 意愿态）：启动态页「进入工作台」主按钮（双健康可点）/ 菜单「服务 → 进入工作台（Alt+Shift+W）」永远可点（不健康时记录意愿、恢复即接管）/ 菜单「服务状态页（Alt+Shift+S）」随时钉住查看——启动态页不再是死路（`docs/desktop-architecture.md` §12）。
- **壳层兼容（M7 + U2 三分支）**：新窗口三分支——**同源链接开受管子窗**（继承 preload、0.8×主窗、24px 级联、关主窗即全部退出——画布上的「从广场启用 Agent」等 `target="_blank"` 同源链接在桌面真实可用）、异源 http(s)/mailto 走默认浏览器、其余协议拒绝；系统通知接线（AppUserModelID + 权限双钩子）、下载自动落「下载」目录+完成通知、Alt+Left/Right 历史返回、拖放/误导航防护——console 在浏览器能用的功能在桌面等价，逐项结论见 **[docs/desktop-compat-matrix.md](../../docs/desktop-compat-matrix.md)**（v2 · 20 项真机验证全表）。
- **附加模式**：启动时探测 8080/3000，已被外部实例监听 → 不 spawn、只做健康观察与接管（退出也不杀外部进程）——内嵌 PG 同样不启动（外部栈自带数据库）。
- **排障可视化（U1 产品化）**：服务状态页信息层级重做——header 全局状态灯 + 诚实 meta（钉住态明说「已停留在此页」）+「进入工作台」呼吸高亮（钉住+双健康时全页唯一脉动，死路出口）；bootstrap 失败红横幅（错误原文直译 + 「重试初始化」）；首启五步进度（数据库初始化/迁移/网关/工作台服务/接管，console 独立步防无解释停顿）；首启教育（**CLI agent 需自备安装并登录**，诚实边界）；三服务卡带等待预算行（「已等 Ns / 预算 Ns」本地 1s 走秒）与分级错误指引（**文案按模式分叉**：packaged 下 db:down 指内嵌恢复、spawn 失败提「安全软件拦截/重装」，dev 话术不泄漏）；每卡日志面板「复制最近 400 行」（主进程 clipboard，无权限坑）+「打开完整日志」。
- **窗口与应用标识（U1）**：位置/尺寸/最大化/缩放跨重启记忆（`userData/window-state.json`；显示器被拔回退主屏居中，最小 960×640）；三平台真实应用图标（`scripts/generate-icons.mjs` 零依赖确定性生成，console 品牌三角标同源 #0f1115 底 + #7aa2f7 节点）；菜单「服务」组含打开数据/日志文件夹与「关于 Dagents」（版本/形态/数据目录/日志目录/未签名/关窗即退出）。
- **排障可视化**：启动态页实时显示 **pg / gateway / console 三服务**状态机、重启计数、退出码、子进程日志尾部（等宽滚动）、失败重试按钮；gateway 503 `db:down`（外部 PG 场景）给出 `cd infra && docker compose up -d` 引导文案且**不重启**（重启救不了 DB）。

## 内嵌 Postgres：数据、升级与外部库共存

- **数据目录固定在** `userData/pgdata`（win 实测路径 `%APPDATA%\@dagents\desktop\pgdata`——Electron 对 scoped 包名 `@dagents/desktop` 原样做目录名）。**卸载默认不删用户数据**；手动清理就删整个 `pgdata` 目录。
- **不做 docker 数据自动迁移**：首轮用户的 infra docker PG（15432）数据请用 `pg_dump`/`pg_restore` 手动搬迁。
- **跨 major 版本升级不做**（16 → 17 需 pg_upgrade，outOfScope）；同 major（16.x）随包自动兼容。
- **异常关机残留 `postmaster.pid`**：若属主进程已死会在启动时自动清锁（PG 认可的 stale lock 处置，不动数据）；若属主进程还活着则诚实报错并列出 PID。
- **外部 PG 三层「不抢连接」**：① `postgres.embedded:false` 显式关；② `extraEnv.POSTGRES_URL` 已设 → 内嵌自动关（启动日志 warning 说明）；③ 附加模式本就不启动。
- 供应链：PG 二进制不进 package.json/lockfile（主包会拉全 8 平台、平台包带 postinstall）——`scripts/ensure-postgres.mjs` 显式下载（默认镜像 registry.npmmirror.com，`DAGENTS_DESKTOP_PG_MIRROR` 可覆盖，`DAGENTS_DESKTOP_SKIP_POSTGRES=1` 短路），缓存于 `apps/desktop/stage/pg-cache/`（gitignore + dockerignore 双护）。

## 诚实边界（当前）

- **dev 栈形态**（仓库内 `pnpm dev`）需要本机有 dagents 仓库检出 + pnpm + node，且先跑 `pnpm --filter @dagents/desktop ensure:postgres` 取 PG 二进制（dev 一次 37MB 下载，缓存复用）；**安装包形态（packaged）零外部依赖**。
- 打包（`dist:win`）是完整链 `build → ensure:electron → ensure:postgres → stage-stack → electron-builder`：staging 阶段做 gateway deploy + console standalone 构建 + **pnpm 平铺规整**（分发链不支持 symlink，详见架构文档 §11.4.1）；win 构建依赖 `patches/next@15.5.20.patch`（junction 兜底，无需开发者模式）。
- 实测 win 安装包 ~494MB（PG DLL 与 node-pty 原生二进制压缩率低；无体积 KPI）。
- 端口锁定 8080/3000（console BFF 只认 `GATEWAY_URL`），配置里写别的端口会被拒绝并回落默认；**PG 端口不锁**（默认 55432 可配 1024-65535，冲突自动让位）。
- 不做自动更新/托盘/远程 gateway/深链（outOfScope，详见架构文档 §1）。

## 安装包未签名说明

**全部平台的安装包都不签名**（无证书资产，outOfScope 明示）：

| 平台 | 首次启动会看到 | 绕过 |
|---|---|---|
| Windows | SmartScreen「Windows 已保护你的电脑」 | 「更多信息」→「仍要运行」 |
| macOS | Gatekeeper「无法打开，因为无法验证开发者」 | 右键 App →「打开」，或 `xattr -dr com.apple.quarantine /Applications/dagents.app` |
| Linux | 无（AppImage 需 `chmod +x`） | — |

安装包从 CI（`.github/workflows/desktop.yml` 的 matrix job artifact）人工取用；无发布服务器、无自动更新——升级即换安装包。

## 配置（userData/config.json）

路径：win `%APPDATA%\@dagents\desktop\config.json` · mac `~/Library/Application Support/@dagents/desktop/` · linux `~/.config/@dagents/desktop/`。坏 JSON/未知字段/类型错误逐项回落默认值，永不阻塞启动：

```jsonc
{
  "mode": "auto",                           // auto = 按内嵌栈在位探测（默认：安装包→packaged，仓库内→dev）；显式 dev/packaged 钉死形态
  "repoRoot": "C:/projects/dagents",       // dev 形态服务 spawn 的 cwd；缺省=从 app 路径向上找 pnpm-workspace.yaml（packaged 形态不使用）
  "consoleUrl": "http://localhost:3000",   // 就绪接管加载的 URL
  "services": {
    "gateway": { "command": "pnpm", "args": ["--filter", "@dagents/gateway", "dev"], "port": 8080 },
    "console": { "command": "pnpm", "args": ["--filter", "@dagents/console", "dev"], "port": 3000 }
  },
  "postgres": {                            // 内嵌 PG（M5）；设 extraEnv.POSTGRES_URL 会自动 embedded:false
    "embedded": true,
    "port": 55432,                         // 默认端口（不锁值）；被占自动 +1 让位（≤20 次）
    "dataDir": null,                       // null = userData/pgdata（绝对路径可覆盖）
    "binDir": null,                        // null = apps/desktop/stage/pg/native/bin
    "migrateScript": null,                 // null = <repoRoot>/packages/db/scripts/migrate.mjs
    "pgRequireRoot": null                  // null = <repoRoot>/packages/db（建库用 pg 驱动解析根）
  },
  "restartPolicy": { "maxAttempts": 3, "windowMs": 300000, "backoffMs": [1000, 3000, 9000], "healthTimeoutMs": 120000 },
  "logTailLines": 400,
  "extraEnv": { }                          // spawn 时附加注入的环境变量（桌面启动 PATH 与终端不同时的逃生门）
}
```

`port` 字段只在等于默认值时被接受（其余回落 + 启动日志告警）。子进程日志落盘 `userData/logs/<svc>.log`（10MB 单代轮转），排障先看这里。

## 开发

```bash
pnpm --filter @dagents/desktop run build      # tsc → dist/ + 渲染页静态资产同步
pnpm --filter @dagents/desktop run test       # vitest（编排器单测/真子进程树终止/真端口探测/架构守护）+ 打包配置校验
pnpm --filter @dagents/desktop run ensure:postgres  # 内嵌 PG 二进制按需下载（37MB，缓存 stage/pg-cache）
pnpm --filter @dagents/desktop run stage:stack       # 服务栈 staging（gateway deploy + console standalone + pnpm 平铺）
pnpm --filter @dagents/desktop run dev        # 起 app（electron 二进制按需下载，ELECTRON_MIRROR 可覆盖）
pnpm --filter @dagents/desktop run dist:win   # 完整打包链（build → ensure×2 → stage-stack → nsis，--publish never）
pnpm --filter @dagents/desktop run smoke      # 安装包解包 exe 启动冒烟（需先 dist:win）
```

mac dmg / linux AppImage 打包归 CI（`desktop.yml` 四 job matrix：win-x64 / mac-x64 / mac-arm64 / linux-x64），本机只校验配置齐备性（`scripts/check-builder-config.mjs`，挂在 test script）。

供应链：electron 44.5.1 无 install script（registry `scripts:null` 实测）——`.npmrc ignore-scripts=true` 与 `pnpm-workspace.yaml onlyBuiltDependencies` 均零放宽；二进制由 `scripts/ensure-electron.mjs` 显式按需下载（`DAGENTS_DESKTOP_SKIP_ELECTRON=1` 短路）。详见架构文档 §2.4。

## 已知限制

- dev 栈语义：编排器绝不触发 pnpm build/turbo；「dev 模式下避免与全仓 build 并行」的既有运维纪律不变（AGENTS.md 已知问题）。
- 停止后端口仍被占只告警不扩杀（保守起见，扩杀策略见架构文档 R2）。
- 首次 console 冷编译可能 4-15s+ 看似卡住——健康预算 120s，日志尾实时可见编译输出。
