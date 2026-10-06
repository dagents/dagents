# dagents 桌面客户端 — 选型论证与架构设计

> 状态：**设计定稿（2026-10-06）**，选型结论与供应链机制全部经过本机（win32 真机）实测。
> 读者：后续研发工程师（按此实现）与验证员（按此验收）。
> 需求基线：需求分析师产出（vision / userStories / inScope / outOfScope / constraints），本文引用处标注「需求原文」。
> 配套：总体架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；本文只管 `apps/desktop`。

---

## 0. 结论速览

| 决策项 | 结论 |
|---|---|
| 技术路线 | **Electron**（electron 44.5.1 + electron-builder 26.15.3） |
| 本机验证状态 | win32 真机完成：依赖安装 → 按需下载二进制 → **NSIS 安装包真实产出（111,162,911 字节）→ 安装包 exe 启动冒烟 → 进程干净终止** 全链路（见 §2.3 证据表） |
| 供应链结论 | **electron@44.5.1 无 install script**（registry 元数据 `scripts: null`）——`ignore-scripts=true` 不需要放宽，`onlyBuiltDependencies` 不需要新增条目（对需求约束的两处修正见 §2.4） |
| monorepo 集成 | 新包 `apps/desktop`（`@dagents/desktop`），零 workspace 依赖，`pnpm-workspace.yaml` 的 `apps/*` 通配已覆盖，根命令门禁自动纳入 |
| 打包 | electron-builder 三 target（win nsis / mac dmg / linux AppImage），全部不签名；本机实跑 win，mac/linux 归 CI matrix（`desktop.yml`） |

---

## 1. 需求回顾（为什么做、边界在哪）

**核心增量**（需求 vision 原文）：把「本机模式」从三终端命令行仪式变成双击即用——一键拉起并守护 gateway+console、独立窗口承载 console 工作台、失败可恢复可见。

**硬边界**（需求 outOfScope，本文严格遵守）：不做自动更新、不做托盘常驻、不融合 gateway 进程、不编排 Docker/Postgres（只探测+引导）、不做代码签名、不做远程 gateway、不做离线壳。

**四条关键约束**（需求 constraints 原文摘要）：

1. monorepo 集成：`apps/desktop` 提供 build/test/lint/typecheck 四 script，验收以根命令 `pnpm test && pnpm lint && pnpm typecheck` 经 turbo 全绿为准。
2. 本机可验证性：验收命令只依赖 Node 工具链；mac/linux 打包本机不断言，实跑归 CI。
3. 供应链白名单：保持 `.npmrc ignore-scripts=true` 不放宽。
4. desktop 的 turbo build 只构建自身，不触发 console 构建产物（防 `.next` 互踩与 tsx watch 连锁重启——AGENTS.md 已知问题）。
5. 端口纪律：gateway/console 一律默认 8080/3000（console BFF 只认 `GATEWAY_URL`）。
6. 进程边界：只以子进程方式托管，判活只看 `/health` 与 HTTP 200；退出时进程树跨平台干净终止是硬验收项。

---

## 2. 选型论证

### 2.1 三路线对比

论证维度权重（按需求 constraints 第 2 条）：**本机可验证性 > 工具链契合度 > 三平台一致性 > 供应链 > 体积/维护成本**。

| 维度 | Electron | Tauri | 纯 Web PWA + 系统壳 |
|---|---|---|---|
| **本机可验证性（权重最高）** | ✅ **本机已全链路实测**（§2.3）：单测/构建门禁今天本机就能全绿 | ❌ **本机无 cargo/rustc**（实测 `cargo --version` → `command not found`，见 §2.3 第 2 条）。任何「门禁今天全绿」的主张都无法兑现——与需求约束正面冲突 | ⚠️ 门禁本身可绿，但见下：核心需求不可实现 |
| **与 pnpm/turbo/ts 契合** | ✅ 纯 Node 生态：electron/electron-builder 都是 npm 包，vitest/tsc/eslint 原样适用 | ❌ 双工具链：Node + Rust（cargo/rustup/cargo-lambda 生态），turbo 任务要串 cargo build，CI 缓存面翻倍 | ✅（但无意义，见右） |
| **核心需求可实现性**（进程编排） | ✅ 主进程就是 Node：`child_process.spawn` + `taskkill /T /F` 经验可直接复用（`packages/agent-adapters/src/win-spawn.ts`，commit 038e12f 真机验证过） | ⚠️ 编排器要用 Rust 重写（sidecar/Command API），TS 侧的 win-spawn 经验无法复用，编排器单测要换成 Rust 测试体系——超出「验收门禁只有 Node 工具链」 | ❌ **浏览器/PWA 无法 spawn/终止子进程**，无法做进程守护、有界重启、日志尾部——inScope 第 2/3/4 条全部不可实现。所谓「系统壳」（Edge app mode 等）只是带边框的书签，等于现状减去记 URL |
| **三平台一致性** | ✅ 同一份 JS 主进程三平台同跑；打包三 target 同一工具 | ⚠️ 三平台各需链接不同系统 webview（WebView2/WKWebView/WebKitGTK），webview 版本差异是 Tauri 已知痛点；Linux GTK 依赖另有系统库要求 | n/a |
| **供应链（ignore-scripts 体系）** | ✅ 见 §2.4：electron 44.5.1 无 install script，electron-builder 唯一被拦的 `electron-winstaller` 是 Squirrel 专用（我们用 NSIS，不需要） | ❌ cargo 的构建脚本体系完全在 `.npmrc` 白名单体系之外，新增一整面审计面 | ✅（但无意义） |
| **体积** | ⚠️ 实测 win 安装包 111,162,911 字节（≈106 MiB），解包后约 250 MiB | ✅ ~10 MiB 量级 | ✅ 最小 |
| **维护成本** | 中：一个 JS 包升级链（electron 大版本 ≈ 每年 3-4 个，Chromium/Node 跟随） | 高：Rust + 前端两条升级链 + 三平台 webview 差异排查 | 低 |

**结论：Electron。** 它是唯一同时满足「核心需求可实现（子进程编排）+ 门禁今天本机全绿 + 供应链不放宽」的路线。Tauri 的体积优势对一个本身要管理 pnpm workspace 的开发者工具不构成决定性收益；PWA 路线在需求层面即不成立（无法编排进程），不是偏好问题。

**对 Tauri 主张的诚实检验记录**：若未来要重开此决策，前置条件是本机实测 `cargo --version` 通过 + CI 三平台 cargo 缓存策略落地；本文档日（2026-10-06）前者不成立（§2.3 第 2 条）。

### 2.2 版本选择

| 组件 | 版本 | 依据 |
|---|---|---|
| electron | **44.5.1** | `curl https://registry.npmmirror.com/electron/latest` 实测最新稳定版；本机全链路验证即此版本 |
| electron-builder | **26.15.3** | `curl https://registry.npmmirror.com/electron-builder/latest` 实测最新稳定版；本机真实打出 NSIS 包 |
| vitest / typescript / eslint | 跟仓库既有版本（`^2.0.0` / `^5.5.0` / ^8.57 根配置） | 与 console/gateway 单测栈一致 |

### 2.3 本机（win32 真机）实测证据表

以下全部为 2026-10-06 在本机（Windows 10 19045，node v22.23.3 / pnpm 10.26.0 / turbo 2.10.4）实际运行的命令与真实输出，探针目录用后已删：

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node --version && pnpm --version && pnpm exec turbo --version` | `v22.23.3` / `10.26.0` / `2.10.4` ✅ |
| 2 | `cargo --version && rustc --version` | **`command not found`（两者皆无）**——Tauri 路线本机不可验证的实锤 |
| 3 | `curl https://registry.npmmirror.com/electron/latest` | 返回 `electron@44.5.1` 元数据；元数据中 **`scripts: null`**、`bin: {electron: cli.js, install-electron: install.js}` ✅ 直连可达 |
| 4 | `curl https://registry.npmmirror.com/electron-builder/latest` | `26.15.3` ✅ |
| 5 | 探针：`.npmrc ignore-scripts=true` + `onlyBuiltDependencies: [electron]`（workspace yaml 与 package.json 两处都试）→ `pnpm add -D electron@44.5.1` | 1.7s 完成；**无 dist 二进制、无任何 build script 执行、无 ignored-builds 警告**——因为根本没有 script 可跑（与 #3 互证） |
| 6 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node -e "require('electron')"` | 触发按需下载（`install.js`），成功产出 `node_modules/electron/dist/electron.exe` ✅ |
| 7 | `./node_modules/.bin/electron --version` | `v44.5.1` ✅ |
| 8 | `pnpm add -D electron-builder@26.15.3` | 成功；pnpm 警告 `Ignored build scripts: electron-winstaller@5.4.0`（electron-builder 的传递依赖，Squirrel 目标专用——我们用 NSIS/dmg/AppImage，不需要它的脚本，不批） |
| 9 | `ELECTRON_MIRROR=…npmmirror… ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ pnpm exec electron-builder --win nsis` | **真实产出 `ProbeApp Setup 0.0.1.exe`（111,162,911 字节）**；NSIS 工具链（nsis-3.0.4.1、7zip、nsis-resources）经镜像现场下载成功 ✅ |
| 10 | `./release/win-unpacked/ProbeApp.exe` → `sleep 6` → `tasklist \| grep -i probeapp` → `taskkill //IM ProbeApp.exe //F` | 4 个进程（main/gpu/renderer/utility，Electron 正常多进程形态）启动在跑；taskkill 全部干净终止 ✅ |
| 11 | 拉 electron-44.5.1.tgz 解出 `install.js`，全文 `grep -i skip` | **零命中**——44.5.1 没有 `ELECTRON_SKIP_BINARY_DOWNLOAD` 开关（见 §2.4 修正二） |

补充事实（读仓库验证）：

- `pnpm-workspace.yaml:2` 的 `apps/*` 通配意味着 `apps/desktop` 建目录即入 workspace，无需改 workspace 配置。
- `.github/workflows/ci.yml:108-115` 注释明确记载「`.npmrc` 的全局 `ignore-scripts=true` 会压过 `onlyBuiltDependencies` 白名单」——与本机探针（#5 的第一组变体：开 ignore-scripts + 白名单，postinstall 同样不跑）互证。但 electron 44.x 已无 postinstall，此坑对本包不存在。
- `packages/agent-adapters/src/win-spawn.ts:50-86`（`resolveCliExecutable`：win32 上 `.cmd` shim 解析 + `shell:true` spawn）与 `win-spawn.ts:98-114`（`treeKill`：`taskkill /PID <pid> /T /F`，同步 require + spawn 的两个坑）是编排器停止语义的已验证蓝本（commit 038e12f 真机 Windows 验证）。
- `apps/gateway/src/app.ts:38-47`：`/health` 返回 `{ok,svc:'gateway',db:'up'|'down'}`，DB 不可达时 **HTTP 503 + `db:'down'`**——编排器据此区分「进程死」与「DB 未就绪」，后者给引导文案而非重启（与 `app.ts:49-53` 的 liveness/readiness 分离设计一致）。
- `restart-gateway.sh:35`（`pkill -f esbuild`）提示 tsx 链上可能有 esbuild 辅助进程——停止语义的验收以「端口 8080/3000 释放 + 进程树终止」为准（见 §7 风险 R2）。

### 2.4 供应链结论与两处对需求约束的修正

**结论：`.npmrc ignore-scripts=true` 原样保留，`pnpm-workspace.yaml onlyBuiltDependencies` 不新增任何条目。**

依据（全部 §2.3 实测）：

1. **electron@44.5.1 的 npm 包没有 install script**（registry 元数据 `scripts: null`；tarball 内 `install.js` 只是被 `require('electron')`/cli **按需**调用的普通脚本，不是 lifecycle hook）。`pnpm install` 期间零下载、零脚本执行——白名单机制根本不介入。
2. **electron-builder@26.15.3** 及其依赖链里唯一带构建脚本的是 `electron-winstaller`（Squirrel.Windows 目标专用）。我们的三 target（nsis/dmg/AppImage）不需要它，保持被拦状态即可，不批。

**修正一**（需求 constraints 原文「electron/electron-builder 等确需 install script 的依赖逐个加入 onlyBuiltDependencies」）：经实测，44.x 的 electron **不确需**——此约束的适用对象在当前版本已不存在。若未来升级后 pnpm 出现 `Ignored build scripts: electron` 警告，再按约束原文逐个审批，PR 说明理由。

**修正二**（需求 constraints 原文「纯检查 CI 场景用 ELECTRON_SKIP_BINARY_DOWNLOAD=1 官方开关规避二进制下载」）：**44.5.1 的 `install.js` 不再实现该开关**（tarball 全文 grep 零命中，§2.3 #11；历史上存在于旧版本）。替代方案且更干净：**安装期本来就不会下载任何二进制**（修正一），纯检查 CI（vitest/tsc/eslint）不触碰 electron 二进制，无需任何开关。二进制只在我们**显式**调用 `scripts/ensure-electron.mjs` 时按需下载；该脚本自带 `DAGENTS_DESKTOP_SKIP_ELECTRON=1` 短路（我们自己实现 skip 语义，默认只在本地 dev/dist 命令里调用它）。

**镜像策略**（本机网络实测：用户级 `~/.npmrc` 的 `registry.npmmirror.com` 直连可达，但其 `proxy=127.0.0.1:7890` 当前失效会拦 npm/pnpm 自身请求）：

- 二进制下载：`ELECTRON_MIRROR`（@electron/get），`ensure-electron.mjs` 默认值 `https://npmmirror.com/mirrors/electron/`，环境变量可覆盖；经 `pnpm run` 执行时 `~/.npmrc` 的 `electron_mirror=` 同样生效（npm 会把 npmrc 导出为 `npm_config_*`）。
- 打包工具链：`ELECTRON_BUILDER_BINARIES_MIRROR`（NSIS/dmg 工具下载），默认 `https://npmmirror.com/mirrors/electron-builder-binaries/`，CI 上 GitHub runner 直连 GitHub 亦可达，环境变量覆盖。

---

## 3. 架构设计

### 3.1 进程模型

```
┌─ dagents 桌面 app（Electron）─────────────────────────────────────┐
│                                                                    │
│  主进程（Node 环境，Electron main）                                 │
│  ├── orchestrator/            ★ 纯逻辑核心，不 import electron      │
│  │     状态机 × 2（gateway / console 服务各一实例）                  │
│  │     supervisor：spawn → 健康轮询 → 意外退出有界重启 → 树终止       │
│  │     ports：端口探测（附加模式判定）                                │
│  │     tree-kill：win32 taskkill /T /F；POSIX SIGTERM→SIGKILL       │
│  │     log-tail：环形缓冲日志尾（默认 400 行/服务）                    │
│  │     config：配置加载/默认值/校验（fs 注入可测）                     │
│  ├── ipc.ts                   ipcMain 桥（编排事件 → 渲染层）         │
│  ├── windows.ts               BrowserWindow 生命周期                 │
│  └── menu.ts                  极简菜单（role 为主）                   │
│                                                                    │
│  preload（contextBridge，contextIsolation: true，sandbox: true）     │
│    暴露受控 API：getState / onState / restart / stop / openExternal  │
│                                                                    │
│  渲染层（单窗口，两阶段内容）                                         │
│   阶段 A 启动态：本地静态页 renderer/（无框架，纯 TS 编译产物）        │
│   阶段 B 工作台：win.loadURL(config.consoleUrl)（默认 :3000）        │
└────────────┬───────────────────────────────┬───────────────────────┘
             │ spawn（子进程，不链接其模块）    │ HTTP 探测
             ▼                               ▼
   gateway 子进程（pnpm --filter @dagents/gateway dev，:8080）
   console 子进程（pnpm --filter @dagents/console  dev，:3000）
             ▲ 不受管（只探测 + 引导）
   Postgres（docker compose，:15432）—— outOfScope 不代管
```

要点：

- **编排器在主进程内**，不单开 utility process——MVP 的编排是纯 Node 逻辑 + 少量子进程句柄，单进程内模块化即可单测（utility process 是为沙箱渲染层跑重活设计的，我们渲染层没有重活）。
- **单窗口两阶段**：app ready → 窗口加载本地启动态页 → 编排器报告 gateway+console 双健康 → `loadURL(consoleUrl)`。console 意外不可用时（`did-fail-load` 或健康轮询失败）回退启动态页并显示恢复过程——这正是需求 userStory 3 的「显示恢复过程而不是 ERR_CONNECTION_REFUSED」。
- **附加模式**：启动前探测 8080/3000（`net.createConnection`，`scripts/guard-build.mjs:24-37` 同款手法）。两端口已在听 → 不 spawn，直接判活进阶段 B，启动态页显示「已附加到现有服务」。任一端口空闲 → 该服务由本 app 托管。
- **判活协议**（与进程边界约束对齐，只看 HTTP）：
  - gateway：`GET http://localhost:8080/health` → HTTP 200 且 `ok:true` = 健康；**503 + `db:'down'`** = 进程活着但 Postgres 未就绪 → 状态页给引导文案（「Postgres 未就绪，请先 `cd infra && docker compose up -d`」），**不重启**（重启救不了 DB，与 gateway 自身 `/livez`、`/health` 分离设计同哲学）；连不上 = 进程死 → 走重启策略。
  - console：`GET http://localhost:3000/` → HTTP 200 = 健康。
  - 轮询间隔：启动期 500ms（尽快进阶段 B），运行期 5s。

### 3.2 编排器状态机（纯逻辑，vitest 全覆盖对象）

每服务一个实例，状态集：

```
idle ──start──▶ starting ──spawn ok──▶ waiting_health ──健康──▶ running
                    │                                       │
                    │ spawn fail                            │ 意外退出(exit)
                    ▼                                       ▼
                 failed ◀──重启预算耗尽── restarting ◀──────┘（有界重启）
                    │  ▲                        │
              retry└──┘  └──────manual stop──────┴──▶ stopped（树终止）
```

规则（全部可单测）：

1. **有界重启**：意外退出后重启，滑动窗口内（默认 5 分钟）最多 3 次，退避 1s/3s/9s；预算耗尽 → `failed` + 日志尾 + 手动重试按钮（需求 userStory 3 的「有界」二字）。
2. **停止语义**：manual stop / app 退出 → 进程树终止，状态 → `stopped`，清除重启预算与所有 pending timer。
3. **db-down ≠ 进程死**：503 `db:'down'` 是 `waiting_health`/`running` 的子状态（`degraded` 展示），不触发重启（§3.1）。
4. **幂等**：重复 start/stop/retry 全幂等；`waiting_health` 超时（默认 120s，console 首次冷编译可能 4-15s+，AGENTS.md 终端章记载 Next 懒编译陷阱）按意外退出处理进重启计数。
5. **纯度**：`orchestrator/` 目录禁止 `import 'electron'`（架构测试钉住，见 §6）——spawn/时钟/日志全部依赖注入，单测用假实现 + 真子进程（`process.execPath`）。

### 3.3 spawn 与树终止（跨平台）

- **命令默认值**（需求 inScope 原文）：gateway `pnpm --filter @dagents/gateway dev`、console `pnpm --filter @dagents/console dev`，cwd = 配置的 repo 根；命令/参数/环境可配置（`config.json`），端口默认 8080/3000 不可配错（约束 5——换端口踩 BFF `GATEWAY_URL` 耦合）。
- **win32 spawn**：`pnpm` 是 `pnpm.cmd` shim——复用 `win-spawn.ts:50-86` 的解析策略（PATH×PATHEXT，`.cmd` 命中 → `shell:true`）。**实现取最小副本内聚在 `apps/desktop/src/main/orchestrator/resolve.ts`**（约 40 行，注明出处），不依赖 `@dagents/agent-adapters`——那会引入 gateway 的依赖树（含 node-pty），违反「desktop 零 workspace 依赖」与构建隔离约束。
- **树终止**：win32 `taskkill /PID <pid> /T /F`（`win-spawn.ts:98-114` 的两个坑照抄：同步 `require` + `spawn` 而非 execFile/动态 import）；POSIX 两段式 SIGTERM → 2s 宽限 → SIGKILL（gateway 有优雅停机链与 boot sweep，值得先礼后兵）。
- **停止验收口径**：两端口释放 + `tasklist`/`ps` 查无残留（restart-gateway.sh 的 esbuild 显式 pkill 提示 `restart-gateway.sh:35`——若 `/T` 树终止后端口仍被占，编排器记录告警日志；验收测试断言端口释放）。

### 3.4 窗口、菜单、preload 与渲染壳

- **窗口**：单窗口 1440×900，`title: 'dagents'`，`webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }`。窗口关闭（`window-all-closed`）→ 触发全量树终止后退出——**关窗即退出**（outOfScope：不做托盘常驻），这是「无孤儿进程」语义的最简实现。
- **菜单**（mac 必须有基础菜单否则连复制粘贴都没有）：`Menu.buildFromTemplate` 全 role——appMenu（mac）/editMenu/viewMenu（reload、toggledevtools）/windowMenu，外加一个自定义「服务」菜单：重启服务 / 停止服务 / 打开启动态页 / 在浏览器打开 console。菜单构建器为纯函数（传 role 回调注入）。
- **preload** 暴露面（刻意窄）：

  ```ts
  window.dagentsDesktop = {
    getState(): DesktopState            // { phase, services: {gateway, console}, config }
    onState(cb): unsubscribe            // 编排事件（250ms 合并节流）
    restart(): void                     // 手动重试（failed → start）
    stop(): void                        // 全停
    openExternal(url: string): void     // 引导文案里的外链（shell.openExternal）
  }
  ```

  preload 对窗口内所有页面注入（包括 console 远程页），但 console 是本机第一方内容（localhost:3000 是我们自己的服务），且暴露面只有服务控制——风险面写进威胁模型备注；不做通用 bridge。
- **启动态/错误态页**（需求 inScope 第 3 条）：`renderer/` 单文件 TS 编译为经典 script（无框架、零依赖、不入 i18n 体系——桌面壳 MVP 中文文案直写，与仓库中文优先一致）。内容：两服务进度条（state 机状态直译）、日志尾部（等宽字体滚动区）、失败时的重试按钮、Postgres 不可达时的引导文案块（含 `docker compose up` 指令与「在浏览器打开 console」逃生口）。

### 3.5 配置持久化

- 路径：`app.getPath('userData')/config.json`（win `%APPDATA%/dagents-desktop`，mac `~/Library/Application Support/dagents-desktop`，linux `~/.config/dagents-desktop`——Electron 统一给三平台语义）。
- 模式（零依赖手写 zod-lite 校验，或直接用 zod——zod 已是仓库既有依赖形态（console/gateway 都用 ^4）；desktop 零 workspace 依赖原则下**新增普通依赖 zod 可接受**，但为守「零 runtime deps」更简：手写 20 行校验函数，纯函数可测）：

  ```ts
  interface DesktopConfig {
    repoRoot: string                       // 默认：dev 模式下取 app 进程 cwd 向上找 pnpm-workspace.yaml
    consoleUrl: string                     // 默认 http://localhost:3000
    services: {
      gateway:  { command: string; args: string[]; port: number }   // 默认 pnpm --filter @dagents/gateway dev / 8080
      console:  { command: string; args: string[]; port: number }   // 默认 pnpm --filter @dagents/console dev / 3000
    }
    restartPolicy: { maxAttempts: 3; windowMs: 300_000; backoffMs: [1_000, 3_000, 9_000]; healthTimeoutMs: 120_000 }
    logTailLines: number                   // 默认 400
  }
  ```

- `config.ts` 纯函数 + 注入 fs/路径，单测覆盖默认值合并、坏 JSON 容错、未知字段忽略。
- **MVP 诚实边界（写进 app 内文案）**：默认命令是 dev 栈（pnpm dev），意味着打包后的 app 需要机器上有 dagents 仓库检出 + pnpm + node——这是 inScope 的显式默认（「可配置命令，默认 pnpm --filter … dev」）。生产模式 console（`build:isolated`）与内置栈是后续立项，不在本轮。

### 3.6 目录结构

```
apps/desktop/
  package.json                 # @dagents/desktop；main: dist/main/index.js；四 script 齐备
  tsconfig.json                # extends ../../tsconfig.base.json；module CommonJS（Electron CJS 主进程最稳）
  electron-builder.yml         # 三 target 打包配置（§4）
  vitest.config.ts             # node 环境；fileParallelism=false（时序敏感用例，agent-adapters 同款）
  scripts/
    ensure-electron.mjs        # 显式按需下载二进制（ELECTRON_MIRROR 默认 npmmirror；DAGENTS_DESKTOP_SKIP_ELECTRON=1 短路）
    check-builder-config.mjs   # 三 target 齐备性校验（挂 test script，CI 纯检查即覆盖）
  src/
    main/
      index.ts                 # 入口：app.whenReady → config 加载 → 编排启动 → 窗口
      windows.ts / menu.ts / ipc.ts    # Electron 薄壳（编排器之外的全部胶水）
      orchestrator/            # ★ §3.2/3.3 全部纯逻辑
        state-machine.ts  supervisor.ts  ports.ts
        tree-kill.ts  resolve.ts  log-tail.ts  config.ts
        *.test.ts              # 单测与实现同目录（仓库 agent-adapters 惯例）
    preload/index.ts           # §3.4 暴露面
    renderer/
      index.html  status.ts    # 启动态/错误态页（单文件经典 script）
  release/                     # 打包产物（gitignore）
```

`package.json` 关键字段：

```jsonc
{
  "name": "@dagents/desktop",
  "private": true,
  "version": "0.0.0",
  "main": "dist/main/index.js",
  "scripts": {
    "build":     "tsc -p tsconfig.json",                       // 只编译自身，零 workspace 依赖 → turbo ^build 不触发任何兄弟包
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test":      "vitest run && node scripts/check-builder-config.mjs",
    "lint":      "eslint src --ext .ts",
    "dev":       "node scripts/ensure-electron.mjs && electron .",
    "dist:win":  "node scripts/ensure-electron.mjs && electron-builder --win nsis"
  },
  "devDependencies": { "electron": "44.5.1", "electron-builder": "26.15.3",
                       "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" },
  "dependencies": {}                                            // 零 runtime 依赖
}
```

turbo 对接（`turbo.json:17,21`）：`build.outputs: dist/**` 原样命中；`test`/`typecheck` 依赖 `^build`——desktop 无 workspace 依赖，自身 `build` 即全部前置，不会牵动 console（约束 4 达成的机制性保证，不靠自觉）。

### 3.7 与 console / gateway 的关系（边界重申）

| 维度 | 做法 |
|---|---|
| UI 代码 | **零 fork**：工作台 = `loadURL(http://localhost:3000)`，console 单真相源（inScope 第 4 条） |
| gateway 模块 | 不 import、不共享 DB 连接，唯一接口是 HTTP 探测（§3.1） |
| 端口 | 默认且默认不可改（8080/3000），配置 schema 里 port 字段保留但校验器锁默认值并注释 BFF 耦合原因 |
| 日志 | 子进程 stdout/stderr → 环形缓冲（内存）+ 落盘 `userData/logs/<svc>.log`（append，10MB 轮转一个 .1），启动态页看尾 |
| 环境变量 | spawn 时**继承 app 进程环境**（用户从终端/桌面启动差异：桌面启动缺 shell PATH 注入——`restart-gateway.sh:52` 的 PATH 补齐教训写进实现注释：Windows 桌面启动继承用户 PATH，POSIX 桌面启动建议从 shell 启动或在配置里加 env 白名单） |

---

## 4. 三平台打包与 CI 兑现

### 4.1 electron-builder.yml

```yaml
appId: dev.dagents.desktop
productName: dagents
directories: { output: release }
files: ["dist/**", "package.json"]        # tsc 产物 + main 入口定位，别带 src/node_modules（asar 内打包的是 dist）
win:
  target: [nsis]
nsis: { oneClick: false, allowToChangeInstallationDirectory: true, artifactName: "dagents-${version}-setup.${ext}" }
mac:
  target: [dmg]                            # 通用二进制：x64 + arm64 两 arch 由 CI matrix 分 job 出包
  category: public.app-category.developer-tools
linux:
  target: [AppImage]
  category: Development
# 全平台不签名（outOfScope）：nsis 无证书仅 SmartScreen 提示；dmg 未公证 Gatekeeper 右键打开；AppImage chmod +x
```

`scripts/check-builder-config.mjs`（挂 `test` script，本机与 CI 纯检查即覆盖「三 target 齐备性」验收）：解析 electron-builder.yml，断言 `win.target` 含 `nsis`、`mac.target` 含 `dmg`、`linux.target` 含 `AppImage`、无 signing 配置——任何一项缺失非零退出。

### 4.2 CI：`.github/workflows/desktop.yml`（新增，仿 `e2e.yml` 先例）

- 触发：PR/push，paths 过滤 `apps/desktop/**` 与本 workflow（e2e.yml:22-27 同款）。
- **纯检查并入 ci.yml 既有路径**：ci.yml 的 `turbo run test/lint/typecheck` 遍历全 workspace，`apps/desktop` 建包即自动纳入——`pnpm install` 阶段 desktop 无 install script（§2.4），CI 无需 `ELECTRON_SKIP_BINARY_DOWNLOAD` 之类的任何开关，vitest 单测不触碰二进制。
- **打包 matrix job**（每个 target 一个 job，共 4 个：win-x64 / mac-x64 / mac-arm64 / linux-x64）：

  ```yaml
  strategy:
    matrix:
      include:
        - { os: windows-latest, target: nsis,     arch: x64 }
        - { os: macos-latest,   target: dmg,      arch: x64 }
        - { os: macos-latest,   target: dmg,      arch: arm64 }
        - { os: ubuntu-latest,  target: AppImage, arch: x64 }
  steps:
    - pnpm install --frozen-lockfile            # desktop 零脚本执行；linux 上 node-pty 走既有 --config.ignore-scripts=false 约定由 ci.yml 主路径覆盖，本 job 只需 desktop
    - pnpm --filter @dagents/desktop build
    - pnpm --filter @dagents/desktop exec electron-builder --${{ matrix.target }} --${{ matrix.arch }}
      env: { ELECTRON_MIRROR: …, ELECTRON_BUILDER_BINARIES_MIRROR: … }   # GitHub runner 直连 GitHub 亦可，env 留可覆盖
    - actions/upload-artifact@v4                # 产物按平台命名归档，人工取用（无发布基础设施，outOfScope）
  ```

- mac/linux 打包**本机不做任何断言**（约束 2），配置齐备性由 check-builder-config.mjs 在本机与 CI 纯检查双重覆盖，实跑归上述 matrix（兑现需求 userStory 6「从 CI 拿到本平台安装包」）。

---

## 5. monorepo 集成清单（对约束 1/3/4 的逐条兑现）

| 约束 | 兑现方式 |
|---|---|
| 四 script + turbo 全绿 | §3.6 scripts；`pnpm-workspace.yaml:2` `apps/*` 通配零改动；验收命令即根命令 `pnpm test && pnpm lint && pnpm typecheck` |
| 不新增绕过 turbo 的门禁 | 无根脚本改动；desktop.yml 只加打包 artifact job，检查类全部走 turbo 既有任务 |
| ignore-scripts 不放宽 | §2.4：不需要放宽，不需要新增 onlyBuiltDependencies；PR 描述需引用 §2.3 #3/#5/#8/#11 证据说明 |
| build 不牵动 console | 零 workspace 依赖 → turbo `^build` 解析为空；`files` 只带 dist；`build:isolated` 不在本轮范围 |
| 端口纪律 | §3.5/§3.7 |
| 进程边界 | §3.1/§3.3 |

lockfile 变更面：+ electron 44.5.1、+ electron-builder 26.15.3 及传递依赖（electron-builder 依赖树较大 ~几十包，全部纯 JS + tarball 内置二进制，无构建脚本；`electron-winstaller` 保持被拦）。

---

## 6. 测试策略

**分层原则：编排器逻辑全单测（真子进程能杀的就用真子进程）；Electron API 薄壳不测单测（mock 价值低），留给本机 dev 手验 + CI 打包冒烟。**

| 层 | 对象 | 手段 |
|---|---|---|
| 纯逻辑单测 | `state-machine` | 状态迁移全表驱动测试；重启预算窗口滑动/耗尽；幂等；db-down 不触发重启 |
| 真子进程单测 | `tree-kill` / `resolve` | **spawn 真进程**（`process.execPath -e`，`cancellation.test.ts` 先例）：win32 用 `.cmd` wrapper 起 `cmd /c node -e "setTimeout"` 组成树，断言树全灭（`tasklist` 查无）；POSIX 断言 SIGTERM 优雅路径。`resolve` 测 PATH×PATHEXT 顺序/显式扩展名透传/未命中回落（`win-spawn.test.ts` 同款契约） |
| 真网络单测 | `ports` | 起真 listener（`net.createServer` port 0）探测；关 listener 后探测失败——guard-build.mjs 同款 socket 手法 |
| 纯函数单测 | `log-tail` / `config` | 环形缓冲裁剪；默认值合并/坏 JSON/未知字段 |
| 架构守护 | orchestrator 纯度 | 一个测试 grep `orchestrator/` 下源码不得出现 `from 'electron'`（防止有人顺手把编排器绑死 Electron，将来想复用为 CLI 时拆不出） |
| 配置齐备性 | `check-builder-config.mjs` | §4.1，挂 test script |
| electron mock | `menu.ts` / `windows.ts` / `ipc.ts` | **不 mock**——薄壳，mock 测试是在测 mock。preload 暴露面用 tsc typecheck 钉契约 |
| 只能留给 CI | mac dmg / linux AppImage 打包 | §4.2 matrix；本机不断言（约束 2） |
| 只能留给本机手验 | 安装包端到端体验（安装→启动→拉起栈→退出无孤儿） | 里程碑 4 验收清单：win 本机实跑（探针已证明链路可行 §2.3 #9/#10），mac/linux 由 CI 产物 + 维护者手验 |

vitest 细节：`environment: node`；`fileParallelism: false`（真子进程/端口用例时序敏感，agent-adapters vitest.config 同款）；`testTimeout` 放宽到 15s（真 spawn/kill 往返）。

---

## 7. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | **electron-builder 运行时下载工具链**（nsis/dmg 工具、appimage 包）在受限网络失败 | 本机已验证 `ELECTRON_BUILDER_BINARIES_MIRROR=npmmirror` 全链路可用（§2.3 #9）；ensure-electron.mjs 与 package.json scripts 里默认注入两个镜像 env，均可覆盖；CI runner 直连 GitHub |
| R2 | **win32 shell 链下树终止漏杀**（pnpm.cmd → pnpm → node → tsx → esbuild 多层链；`restart-gateway.sh:35` 曾需显式 pkill esbuild） | `taskkill /T /F` 灭整树（038e12f 真机验证）；**验收以端口释放为准**：stop 后编排器复查 8080/3000，仍占用则日志告警并二次定向 `taskkill /IM`（仅限本 app 会话内已知镜像名 esbuild.exe——保守起见 MVP 只告警不自动扩杀，扩杀策略记入「新需求记录」） |
| R3 | **桌面启动环境与终端不同**（PATH 缺 CLI 安装位，`restart-gateway.sh:52` 教训：nohup 环境缺 PATH 致 claude ENOENT） | spawn 继承 app 环境；配置 schema 预留 `extraEnv`；启动态页在 gateway 日志出现 CLI ENOENT 模式时给针对性提示（模式匹配进「记录不实现」清单） |
| R4 | **NSIS 未签名 SmartScreen 警告 / dmg 未公证 Gatekeeper 拦截** | outOfScope 明示不签名；README 与启动态页「关于」注明未签名包与绕过方法（右键打开/更多信息）；发布基础设施就绪后另立项 |
| R5 | **electron 大版本升级供应链机制再变**（44.x 无 install script 是实测快照，非永续契约） | §2.4 已写死验证方法（registry scripts 字段 + tarball grep）；升级 PR 按此复核，若出现 install script 再走 onlyBuiltDependencies 审批（约束 3 原文路径） |
| R6 | **dev 栈语义**（tsx watch：进行中 run 会被 turbo 重建 workspace dist 打断——AGENTS.md 已知问题） | desktop 只 spawn 不构建：编排器绝不触发 pnpm build/turbo；文档明示「dev 模式下避免与全仓 build 并行」沿用既有运维纪律 |
| R7 | **console 冷启动 4-15s Next 懒编译**（AGENTS.md 已知）表现为「久等」 | `healthTimeoutMs` 默认 120s；启动态页把 `waiting_health` 与超时区分展示，日志尾实时可见编译输出 |
| R8 | **单窗口 preload 对 console 页同样注入** | 暴露面窄且 console 为本机第一方（§3.4 威胁模型备注）；若未来 console 支持远程部署（outOfScope 另立项），须先撤远程页注入 |

---

## 8. 里程碑（≤4 个，第一个即「可安装可构建空壳 + 门禁全绿」）

| # | 里程碑 | 交付内容 | 验收口径 |
|---|---|---|---|
| M1 | **可安装可构建的空壳 + 门禁全绿** | `apps/desktop` 骨架（main 入口空窗口 + preload + 静态启动页占位）、四 script、tsconfig/eslint/vitest 接线、electron-builder.yml 三 target + check-builder-config.mjs、ensure-electron.mjs | 根命令 `pnpm test && pnpm lint && pnpm typecheck` 全绿（desktop 任务出现在 turbo 输出）；本机 `dist:win` 产出 nsis 安装包 + win-unpacked exe 启动冒烟（§2.3 #9/#10 已验链路，此处为正式接线复验）；desktop.yml CI 打包 job 建立并在 PR 上绿 |
| M2 | **编排器核心**（纯逻辑全量） | state-machine / supervisor / ports / tree-kill / resolve / log-tail / config 实现 + §6 全部单测；IPC 桥；启动态页渲染真实状态 | `pnpm --filter @dagents/desktop test` 全绿；真子进程树终止测试过；本机 dev 起 app 能拉起/停净真实 gateway+console（端口释放断言） |
| M3 | **就绪接管与错误引导** | 附加模式（双端口已听→不 spawn 直连）；双健康→`loadURL` 接管；db-down 引导文案 + docker compose 指引；console 崩溃回退启动页 + 有界重启可视化 + 重试按钮 | 需求 userStory 1/2/3/4 逐条手验记录；「杀 console 子进程→app 自动重启→窗口自动恢复」演示 |
| M4 | **三平台打包兑现 + 收口** | mac dmg（x64/arm64）/linux AppImage CI 产物归档；desktop README（未签名包说明、配置说明）；AGENTS.md/docs 索引更新 | CI matrix 四 job 全绿且 artifact 可下载；验收员按验收清单全量过；根命令门禁最终态全绿 |

---

## 9. 附：本设计的验证边界声明

- 本机已验证（§2.3 全表，win32）：Electron 全链路含真实打包与启动冒烟。
- 本机**未**验证（如实记录）：mac/linux 打包（约束 2 归 CI）；electron 44.5.1 在 mac arm64/linux 下的行为（由 CI 兜底）；orchestrator 对真 gateway/console 的完整编排（实现后 M2/M3 验收）。
- 需求约束的两处修正（§2.4）：electron 无需 install script 白名单；`ELECTRON_SKIP_BINARY_DOWNLOAD` 在 44.5.1 不存在、也不再需要——修正依据均为 §2.3 实测，非推测。
