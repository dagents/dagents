# dagents 桌面客户端（@dagents/desktop）

给本地优先用户的 win/mac/linux 原生应用：一键拉起并守护本机 gateway+console 服务栈，以独立窗口承载 console 工作台——把「本机模式」从三终端命令行仪式变成双击即用。架构真相源：[`docs/desktop-architecture.md`](../../docs/desktop-architecture.md)。

## 它做什么

- **进程编排**：spawn `pnpm --filter @dagents/gateway dev`（:8080）与 `pnpm --filter @dagents/console dev`（:3000）为子进程；健康轮询（gateway `/health` 判 200+`ok:true`，console 判 HTTP 200，启动期 500ms/运行期 5s）；意外退出**有界自动重启**（5 分钟窗内 3 次，退避 1s/3s/9s，耗尽转 failed 等手动重试）；停止即整棵进程树终止（win32 `taskkill /T /F`）。
- **就绪接管**：双服务健康后窗口自动加载 `http://localhost:3000`（console 单真相源，零 UI fork）；console 崩溃/健康跌落自动回退本地启动态页显示恢复过程。
- **附加模式**：启动时探测 8080/3000，已被外部实例监听 → 不 spawn、只做健康观察与接管（退出也不杀外部进程）。
- **排障可视化**：启动态页实时显示两服务状态机、重启计数、退出码、子进程日志尾部（等宽滚动）、失败重试按钮；**Postgres 未就绪**（gateway 503 `db:down`）给出 `cd infra && docker compose up -d` 引导文案且**不重启**（重启救不了 DB）。

## 诚实边界（MVP）

- **默认命令是 dev 栈**：本机需有 dagents 仓库检出 + pnpm + node。打包后的 app 通过下面的 `config.json` 指定 `repoRoot`（dev 模式从 `apps/desktop` 向上自动发现 `pnpm-workspace.yaml`）。
- **不代管 Docker/Postgres**：只探测 + 引导（outOfScope）。
- 端口锁定 8080/3000（console BFF 只认 `GATEWAY_URL`），配置里写别的端口会被拒绝并回落默认。
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
  "repoRoot": "C:/projects/dagents",       // 服务 spawn 的 cwd；缺省=从 app 路径向上找 pnpm-workspace.yaml（打包后必须显式配置）
  "consoleUrl": "http://localhost:3000",   // 就绪接管加载的 URL
  "services": {
    "gateway": { "command": "pnpm", "args": ["--filter", "@dagents/gateway", "dev"], "port": 8080 },
    "console": { "command": "pnpm", "args": ["--filter", "@dagents/console", "dev"], "port": 3000 }
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
pnpm --filter @dagents/desktop run dev        # 起 app（electron 二进制按需下载，ELECTRON_MIRROR 可覆盖）
pnpm --filter @dagents/desktop run dist:win   # 本机 win nsis 打包（--publish never）
pnpm --filter @dagents/desktop run smoke      # 安装包解包 exe 启动冒烟（需先 dist:win）
```

mac dmg / linux AppImage 打包归 CI（`desktop.yml` 四 job matrix：win-x64 / mac-x64 / mac-arm64 / linux-x64），本机只校验配置齐备性（`scripts/check-builder-config.mjs`，挂在 test script）。

供应链：electron 44.5.1 无 install script（registry `scripts:null` 实测）——`.npmrc ignore-scripts=true` 与 `pnpm-workspace.yaml onlyBuiltDependencies` 均零放宽；二进制由 `scripts/ensure-electron.mjs` 显式按需下载（`DAGENTS_DESKTOP_SKIP_ELECTRON=1` 短路）。详见架构文档 §2.4。

## 已知限制

- dev 栈语义：编排器绝不触发 pnpm build/turbo；「dev 模式下避免与全仓 build 并行」的既有运维纪律不变（AGENTS.md 已知问题）。
- 停止后端口仍被占只告警不扩杀（保守起见，扩杀策略见架构文档 R2）。
- 首次 console 冷编译可能 4-15s+ 看似卡住——健康预算 120s，日志尾实时可见编译输出。
