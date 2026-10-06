# dagents 桌面客户端 — 选型论证与架构设计

> 状态：**第二轮设计定稿（2026-10-07）**。第一轮（2026-10-06，Electron 壳 + dev 栈编排）全部结论经本机实测；本轮为演进：**内嵌 Postgres + 生产服务栈打进安装包 + 启动态页导航修复 + 兼容排查框架**，新增选型结论（§10–§15）同样全部经本机（win32 真机）实测，证据表见 §16。
> 读者：后续研发工程师（按此实现）与验证员（按此验收）。
> 需求基线：需求分析师产出（vision / userStories / inScope / outOfScope / constraints），本文引用处标注「需求原文」。
> 配套：总体架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；本文只管 `apps/desktop`；兼容矩阵（第二轮交付物）将落在 `docs/desktop-compat-matrix.md`。

---

## 0. 结论速览

| 决策项 | 结论 |
|---|---|
| 技术路线 | **Electron**（electron 44.5.1 + electron-builder 26.15.3）——第一轮结论不变 |
| 本机验证状态 | win32 真机完成：依赖安装 → 按需下载二进制 → **NSIS 安装包真实产出（111,162,911 字节）→ 安装包 exe 启动冒烟 → 进程干净终止**（第一轮 §2.3）；**第二轮新增全链路探测：内嵌 PG initdb→迁移→起停、node-pty 双运行时 ABI、deploy 版 gateway 在 Electron-as-Node 下 `/health ok:true`**（§16） |
| 供应链结论 | **electron@44.5.1 无 install script**（§2.4）；**第二轮零新增 npm 依赖**——内嵌 PG 二进制走显式下载脚本（`ensure-postgres.mjs`，ensure-electron 同款先例），不进 lockfile、不放宽 `ignore-scripts`/`onlyBuiltDependencies` |
| monorepo 集成 | `apps/desktop` 零 workspace 依赖不变；打包物料落 `apps/desktop/stage/`（gitignore+dockerignore 双护），不进服务镜像（bfac702 教训） |
| 打包 | electron-builder 三 target（win nsis / mac dmg / linux AppImage），全部不签名；extraResources 携带 `pg/` + `services/gateway` + `services/console`（§11） |
| **内嵌 PG（第二轮）** | `@embedded-postgres/<platform>-<arch>` npm tarball 经显式脚本下载（win-x64 96MiB 解包 / 37.3MB 压缩；pg 16.14 对齐 infra postgres:16 主版本）；编排器第三个受管服务 + bootstrap 阶段（§10） |
| **服务栈运行时（第二轮）** | **ELECTRON_RUN_AS_NODE + `process.execPath`**，不另带 Node 分发——实测 gateway 生产产物（pnpm deploy --prod --legacy）在其下正常运行，node-pty N-API prebuild ABI 兼容（§11/§14/§16） |
| **启动态页导航（第二轮）** | 显式双向入口模型：`pinnedBoot` 布尔升级为内容意愿态（auto/boot/console），新增 `enterWorkbench` IPC 通道——启动态页不再是死路（§12） |
| **终端（第二轮）** | 打包版**可用不降级**：node-pty 1.1.0 是 N-API 绑定，Node 22（modules 127）与 Electron 44 内嵌 Node 24（modules 149）双真跑 PASS（§14） |

---

## 1. 需求回顾（为什么做、边界在哪）

**核心增量**（需求 vision 原文）：把「本机模式」从三终端命令行仪式变成双击即用——一键拉起并守护 gateway+console、独立窗口承载 console 工作台、失败可恢复可见。

**硬边界**（需求 outOfScope，本文严格遵守）：不做自动更新、不做托盘常驻、不融合 gateway 进程、不做代码签名、不做远程 gateway、不做离线壳。

> **第二轮边界变更（2026-10-07）**：「不编排 Docker/Postgres（只探测+引导）」是第一轮的边界，**本轮需求已推翻**——Postgres 改为内嵌二进制随包分发并纳入编排（§10）；Docker 本身仍不编排（Langfuse 等可观测栈继续走外部 docker，outOfScope 不变）。第一轮 §3.1 进程图与 §3.2 db-down 文案中的「docker compose 引导」语义按下述新章为准。

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
             ▲ 不受管（只探测 + 引导）——第一轮形态
   Postgres（docker compose，:15432）
             【第二轮起：上图 dev 形态降为回落模式，默认形态见 §10/§11——
               内嵌 PG + packaged 服务栈；db-down 的 docker compose 引导文案
               仅在 dev 模式保留，packaged 模式改为内嵌 PG 自身的恢复语义】
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

- **窗口**：单窗口（U1 起记忆位置/尺寸/最大化/缩放——`userData/window-state.json`，恢复时与 `getAllDisplays()` workArea 求交集防「窗口消失在拔掉的显示器」，无交集回退主屏居中；最小 960×640，缺省 1440×900），`title: 'Dagents'`，`webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false }`。窗口关闭（`window-all-closed`）→ 触发全量树终止后退出——**关窗即退出**（outOfScope：不做托盘常驻），这是「无孤儿进程」语义的最简实现。几何记忆纯逻辑在 `main/window-state.ts`（单测），Electron 薄壳在 `windows.ts`。
- **菜单**（mac 必须有基础菜单否则连复制粘贴都没有）：`Menu.buildFromTemplate` 全 role——appMenu（mac）/editMenu/viewMenu（reload、toggledevtools）/windowMenu，外加一个自定义「服务」菜单：进入工作台 / 服务状态页 / 重启服务 / 停止服务 / 在浏览器打开 console / 打开数据文件夹 / 打开日志文件夹 / 关于 Dagents（版本+形态+数据目录+日志目录+未签名+关窗即退出，U1）。菜单构建器为纯函数（传 role 回调注入）。
- **preload** 暴露面（刻意窄）：

  ```ts
  window.dagentsDesktop = {
    getState(): DesktopState            // { phase, services: {gateway, console, pg}, config }
    onState(cb): unsubscribe            // 编排事件（250ms 合并节流）
    restart(): void                     // 手动重试（failed → start；bootstrap 管线含其中）
    stop(): void                        // 全停
    enterWorkbench(): void              // 双向导航（§12.2）
    showStartupPage(): void             // 钉住服务状态页
    openExternal(url: string): void     // 引导文案里的外链（shell.openExternal）
    openLogsFolder(): void              // 打开日志目录（无参数——主进程固定路径，杜绝任意目录打开面）
    openDataFolder(): void              // 打开 pgdata 数据目录
    copyLogTail(id): number             // 复制某服务最近 400 行日志（主进程 clipboard，无权限/焦点坑）
  }
  ```

  preload 对窗口内所有页面注入（包括 console 远程页），但 console 是本机第一方内容（localhost:3000 是我们自己的服务），且暴露面只有服务控制——风险面写进威胁模型备注；不做通用 bridge。
- **启动态/服务状态页**（U1 产品化重做）：`renderer/` 零依赖 ESM 模块（`tsconfig.renderer.json` 单独编译为浏览器原生 ESM——主 tsconfig 是 CommonJS，经典 script 加载 CJS 产物会死在 `require is not defined`，真机实跑踩中后修正）。信息层级：header（品牌 + 全局状态灯 + 钉住徽标 + 诚实 meta + 三动作位，「进入工作台」在钉住+双健康时是全页唯一呼吸高亮 box-shadow 2s 脉动）→ bootstrap 失败红横幅（错误原文直译 + 「重试初始化」，任意启动轮次可见）→ 首启五步进度（initdb/迁移/网关/工作台服务/接管，步态 ○◐●✕◔，console 独立步防 ③→⑤ 间 10-30s 无解释停顿）→ 首启教育（CLI agent 需自备；localStorage `dagents.desktop.onboarded.v1` 首启判定，接管/点击即消）→ 三服务卡（状态 chip / 等待预算行「已等 Ns / 预算 Ns」本地 1s 走秒——主进程只在状态变化推帧 / 分级 message / 日志面板标题行「复制最近 400 行」+「打开完整日志」）→ footer 事实行（版本/形态/数据目录可打开）+ 未签名说明。全部文案/投影是纯函数层 `renderer/status-copy.ts`（39 用例钉住真值表：S4 已停留/S5b 意愿等待+原因/S6 db:down 三分叉/SPAWN_FAILED packaged 分叉「安全软件拦截/重装」不泄漏 dev 话术/D8 重启按钮三值/B4 让位 chip/B5 外部跳过步态），`status.ts` 只做 DOM 装配。
- **应用图标（U1）**：`scripts/generate-icons.mjs` 零依赖确定性生成（4×4 超采样软光栅化 + 手写 PNG/ICO/ICNS 编码 + 写后回读自校验，重跑同字节）——console 品牌三角标几何同源、壳层配色（#0f1115 底 + #7aa2f7 节点）；产物 `build/icon.ico`（16/24/32/48/64/128/256）/`icon.icns`（icp4…ic14）/`icon.png`（512）提交进仓库保 CI 确定性，electron-builder 三平台 `icon:` 显式引用（`check-builder-config.mjs` 断言文件在位与引用同源）。

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
- **MVP 诚实边界（写进 app 内文案）**：默认命令是 dev 栈（pnpm dev），意味着打包后的 app 需要机器上有 dagents 仓库检出 + pnpm + node——这是第一轮 inScope 的显式默认（「可配置命令，默认 pnpm --filter … dev」）。
  **【第二轮推翻此默认】** packaged 模式成为零配置默认（§11.4），dev 栈降为 `config.json` 显式回落；「CLI agent 需自备安装并登录」仍是不可消除的前提，首启文案诚实告知（不假装零依赖）。

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

> 第一轮 M1–M4 已交付（bfac702 等提交）。**第二轮里程碑 M5–M7 见 §15**——第一个必须是「内嵌 PG 可用 + 门禁全绿」的可验证切片。

---

## 9. 附：本设计的验证边界声明

- 本机已验证（§2.3 全表，win32）：Electron 全链路含真实打包与启动冒烟。
- 本机**未**验证（如实记录）：mac/linux 打包（约束 2 归 CI）；electron 44.5.1 在 mac arm64/linux 下的行为（由 CI 兜底）；orchestrator 对真 gateway/console 的完整编排（实现后 M2/M3 验收）。
- 需求约束的两处修正（§2.4）：electron 无需 install script 白名单；`ELECTRON_SKIP_BINARY_DOWNLOAD` 在 44.5.1 不存在、也不再需要——修正依据均为 §2.3 实测，非推测。

---

# 第二轮设计（2026-10-07）：内嵌 PG · 服务栈入包 · 导航修复 · 兼容框架

> 需求原文 vision：「下载安装包、双击即用的 dagents 一体盒：安装包内嵌 Postgres 与生产级 gateway/console 服务栈（零仓库检出/零 pnpm/零 node/零 docker）」。本章为 §1–§9 第一轮壳体的演进，第一轮已实现的编排器/接管/打包机制全部保留复用，冲突处以本章为准。
> 本章所有选型断言的实测证据集中在 §16 证据表（全部为本轮在 win32 真机真实执行的命令与输出）。

## 10. 内嵌 Postgres（pgEmbedding）

### 10.1 二进制来源与供应链

**结论：`@embedded-postgres/<platform>-<arch>` npm tarball，经 `apps/desktop/scripts/ensure-postgres.mjs` 显式按需下载，不进 package.json / lockfile。**

- 版本钉 **16.14.0-beta.17**（平台包主版本 16 对齐 infra `postgres:16-alpine` 主版本——需求 inScope 原文「对齐 infra 现用的 postgres:16 主版本」；同主版本内小版本差异不影响 data 目录兼容）。
- **为什么不是 npm 依赖**：主包 `embedded-postgres` 依赖全部 8 个平台包（win 96MiB + linux-x64 56MiB + darwin×2 各 141MiB + …），进 workspace 意味着每台安装机拉全平台二进制；且平台包带 `postinstall: node scripts/hydrate-symlinks.js`（实测 registry 元数据），进依赖图就得论证 install script。需求 constraints 第 1 条已指路：「内嵌 Postgres…一律走显式按需下载脚本先例（ensure-electron.mjs 模式：镜像可覆盖、可短路、不入 npm install 生命周期）」——照办。
- **postinstall 无害性实测**（仍需论证，因为 CI linux job 会在解包后跑一次它）：win-x64 tarball 内 `native/pg-symlinks.json` 内容为 `[]`（实测），hydrate-symlinks 是纯 Node 的符号链接重建脚本、对 win 是 no-op；ensure-postgres.mjs 在解包后**显式执行** `node scripts/hydrate-symlinks.js`（这是我们自己调用普通脚本，不是 npm 生命周期），覆盖 linux/darwin 可能非空的场景（linux/darwin 的 json 内容未本机验证——CI matrix 验证点，记入 §16 边界）。
- 镜像：默认 `registry.npmmirror.com`（实测直连可达、tarball 下载成功），`DAGENTS_DESKTOP_PG_MIRROR` 可覆盖（例如指回 registry.npmjs.org）；`DAGENTS_DESKTOP_SKIP_POSTGRES=1` 短路（CI 纯检查 job 不触二进制）。下载后校验 tarball 字节数与元数据 `dist.unpackedSize` 记录值的一致性，缓存于 `apps/desktop/stage/pg-cache/`（gitignore）。
- 平台映射（CI matrix ↔ 包名）：win-x64 / linux-x64 / darwin-x64 / darwin-arm64。**`@embedded-postgres/windows-arm64` 不存在**（实测 registry 404）——win 目标本就只有 x64，无影响。

### 10.2 生命周期：第三个受管服务 + 前置 bootstrap

**结论：PG 作为编排器的第三个 `ServiceSupervisor` 实例（同一套状态机/有界重启/树终止语义），外加一个一次性 bootstrap 管线。**

```
app ready
 └─ bootstrap（幂等，每次启动跑，几毫秒级短路）：
      1. dataDir 存在 PG_VERSION ？→ 跳过 initdb
      2. 否则 spawn initdb -U dagents -E UTF8 --locale=C -A trust -D <userData>/pgdata
 └─ orchestrator.start()
      ├─ pg       ：spawn postgres.exe -D pgdata -p <port> -h 127.0.0.1（前台直跑，不 pg_ctl daemonize）
      │             健康 = TCP 端口探活（probePort 复用；pg_isready 不随包分发，见下）
      ├─ pg 健康后 ── migrate：spawn <node> services/gateway/node_modules/@dagents/db/scripts/migrate.mjs
      │             env POSTGRES_URL=<内嵌 DSN>（幂等：runMigrations 跳过已应用项；失败→gateway 不启动+状态页明示）
      ├─ gateway  ：现有状态机，env 注入 POSTGRES_URL（extraEnv 通道）
      └─ console  ：现有状态机
```

- **为什么前台直跑 postgres.exe 而不是 pg_ctl start**：pg_ctl 会 daemonize 出脱离本 app 进程树的服务进程，`taskkill /T` 够不着——违反「退出树终止与端口释放断言同口径」约束。前台直跑保持树归属；本机探测用的是 pg_ctl（probe 简化），直跑形态是 PG 官方支持的标准用法，M5 验收项覆盖。
- **判活协议**：只看 TCP accept（约束原文「判活只看探活协议不猜进程状态」）。`pg_isready`/`psql`/`createdb` 都不随 tarball 分发（实测 bin/ 仅有 initdb/postgres/pg_ctl + DLL）——端口探活是唯一随包可用的协议级探活；端到端语义由 gateway `/health` 的 `db:'up'` 兜底（现有 computePhase 不变）。
- **建库**：tarball 无 createdb.exe。DSN 直指 `postgres` 库即可让 migrate 跑通（实测迁移链对任意库工作），但为语义干净：bootstrap 里用 staged gateway 自带的 `pg` 驱动跑一句 `CREATE DATABASE dagents`（幂等，失败码 42P04 忽略）——`pg@8.22.0` 纯 JS 无脚本，已在既有 lockfile 内，**不新增供应链面**。执行载体是 `ELECTRON_RUN_AS_NODE <execPath> stage 内小脚本`，与 migrate 同通道。
- **停止**：优先 `pg_ctl stop -m fast`（干净 checkpoint，数据落盘）；超时 5s 兜底走树终止；端口释放断言与 gateway/console 同口径。**App 退出顺序 = console → gateway → pg**（反依赖序）。
- **有界重启**：与两服务同策略（5min 窗 3 次，1/3/9s）；PG 起不来时 gateway 的 503 `db:'down'` 降级展示语义原样复用（不重启 gateway——第一轮 §3.2 规则 3）。

### 10.3 端口策略

- 默认 **55432**，独立于 `LOCKED_PORTS`（8080/3000 锁语义不变；需求原文「内嵌 Postgres 端口独立于该锁」）。
- 选 55432 的理由：避开 5432（用户自装 PG 常用）、15432（infra docker compose 的宿主映射约定——首轮用户机器上最可能的占用者）、54329+ 无特殊含义但 55432 与 15432 同构易记。
- **冲突自动让位**：启动前 probe 默认端口，被占则 +1 递增探测（上限 20 次），实际端口写进：pg 服务日志、状态页 facts（「端口 :55433（默认 55432 被占用，已让位）」）、注入 gateway 的 `POSTGRES_URL`。全部失败 → pg 进 `failed` + 状态页明示（诚实边界，不猜不抢）。
- 只绑 `127.0.0.1`，与 gateway 默认绑定面一致。

### 10.4 数据目录、升级与外部 PG 共存

- 数据目录固定 `userData/pgdata/`（**win 真机实测路径 `%APPDATA%\@dagents\desktop\pgdata`**——Electron 对 scoped 包名 `@dagents/desktop` 原样用作目录名，含 `@` 与嵌套层级；若未来设 `productName` 改写该路径，必须携带数据目录迁移说明），README 写明路径与手动清理方法；**卸载默认不删**（NSIS 默认行为 + 不设 `deleteAppDataOnUninstall`），换安装包升级不丢数据（需求 userStory 2）。
- 主版本内小版本升级（16.x→16.y）随包自动完成（PG 允许同 major 的 PG_VERSION 兼容启动）；**跨 major 升级不做**（pg_upgrade 复杂度不值当），README 明示。不做 docker 数据自动迁移（outOfScope），提供 pg_dump 手动迁移说明。
- **外部 PG 回退/共存**（三层，全部「不抢连接」）：
  1. `config.json` 显式 `postgres.embedded: false` → 不 spawn 内嵌 PG；
  2. `extraEnv.POSTGRES_URL` 已设（用户指向自己的 PG，含 15432 docker）→ 自动 `embedded=false`（配置合并时打 warning 说明判定依据）；
  3. 附加模式（8080/3000 已被外部实例监听）→ 本来就不 spawn 任何东西，内嵌 PG 同样不启动。
  外部 PG 的 db-down 引导文案（docker compose 指引）仅在 dev 模式保留；packaged 模式下 db-down 的引导是「内嵌 PG 服务卡片的恢复动作」。

### 10.5 编排器实现形态（纯度纪律延续）——M5 已落地

- `orchestrator/` 新增 `pg-service.ts`：TCP 健康变体**不是子类**——`ServiceSupervisor` 增 `SupervisorOptions`（`probe`/`runSpec`/`port`/`attachable` 四个注入点），pg 以选项注入（TCP 探针把端口开闭映射为 2xx/error；spawn 规格端口让位后运行时构造；`attachable:false`——冲突让位而非附加）；bootstrap 管线（挑端口/initdb/stale pid 清理/建库/迁移/优雅停）内聚 `PgServiceController`，全部副作用经 `PgDeps`（= SupervisorDeps + PgExtraDeps）注入，状态机/重启预算复用 `state-machine.ts` 原样。对 `supervisor.ts` 仅 type import（无循环）。
- `ServiceId` 扩为 `'gateway' | 'console' | 'pg'`；`DesktopSnapshot.services` 增 pg 卡片 + `config.{pgPort,pgEmbedded,pgDataDir}`；`computePhase` 不变（双健康判 console——pg 健康已内含于 gateway `db:'up'`）。
- 停止顺序与 EXIT 抑制：`ServiceSupervisor.suppressExit()` 让 pg_ctl 引发的 postgres 退出只记日志不进重启预算；`Orchestrator.stopAll` 反依赖序 console → gateway → pg（pg_ctl fast ≤5s → 树终止兜底 → 端口释放断言同口径）。
- purity 测试继续钉死 `orchestrator/` 禁 import electron（pg-service.ts 在扫描范围内）；全部 spawn 走注入。
- **win 真机实证踩坑（已修）**：desktop dist 是 CJS（tsc module:CommonJS），`await import(file://…)` 被 TS 降级为 `require`——而 `require` 不认 file:// URL，pg 驱动加载报 `Cannot find module 'file:///…'`。修为 `createRequire(...)(绝对路径)` 直 require（pg 本就是 CJS 包）。

## 11. 服务栈打包（stackBundling）——M6 已落地（win 真机全链验收过，mac/linux 归 CI）

### 11.1 运行时选型：ELECTRON_RUN_AS_NODE，不另带 Node

**结论：用 `process.execPath`（打包后即 dagents.exe）+ `ELECTRON_RUN_AS_NODE=1` 拉起两个服务，不随包另发 Node 运行时。**

- **实测依据**（§16 #6–#8）：electron 44.5.1 内嵌 Node 24.21.0（modules 149 / napi 10）；`pnpm deploy --prod --legacy` 产出的 gateway（含 node-pty）在其下正常启动，`/health` 返回 `{"ok":true,"db":"up"}`、`/metrics` 200。
- 对比「另带 node 分发」：每平台 +1 个 ~30MB 二进制与一条版本升级链，收益仅剩「Node 版本与仓库 engines 解耦」——但 gateway 本就在 Electron 主进程同机同版本下开发验证（dev 模式跑的是系统 Node 22，packaged 跑 24，两者 Node 22+ 特性面一致，`engines: node>=22` 满足）；N-API 兼容已实测。供应链上 Electron 二进制本来就要审（ensure-electron 通道），多一个 Node 分发反而多一条审计面。**判负。**
- spawn 细节：gateway/console 子进程 env 显式注入 `ELECTRON_RUN_AS_NODE: '1'`；`process.execPath` 在 dev 模式（`electron .`）同样成立（dev 模式默认仍走 pnpm dev 栈，packaged spawn 仅在 packaged 模式启用，见 11.4）。
- 已知边界（记入 §17 风险 R10）：`ELECTRON_RUN_AS_NODE` 会随 env 传给孙进程——gateway spawn 的 claude/codex 等 CLI 不受影响（非 Electron 程序）；仅当用户的 CLI agent 本身是 Electron GUI 应用时才会被切到 node 模式（现网无此形态，README 记录该边界与 extraEnv 覆盖逃生门）。

### 11.2 gateway 产物形态

**结论：`pnpm --filter @dagents/gateway deploy --prod --legacy <stage>`（Docker 运行时层的 pnpm 等价物），staging 时裁掉 src/tsconfig/vitest.config。**

- 实测（§16 #7）：deploy 产物 225MiB（node_modules 222MiB + dist 1MiB + 库目录），+287 包；workspace 依赖以真实拷贝进 `node_modules/.pnpm/@dagents+<name>@file+…`（无软链逃逸）；`builtin-library/`、`quickstart-library/`（persona 运行时根）随包携带；`node_modules/@dagents/db/scripts/migrate.mjs` 存在且**从 deploy 树直接跑通迁移**（§16 #5）。
- gateway dist 本身是 tsup 打包源码 + 外部化依赖（实测 dist/index.js 196 条 import 指向 @dagents/* 与 hono 等）——node_modules 由 deploy 提供，与 Docker 运行时层同构（Dockerfile L93-135 先例）。
- node-pty：win/darwin 的 prebuilds 随 npm tarball 进 deploy 树（实测存在，ignore-scripts 下零脚本执行）；**linux 无 prebuild**（tarball 只有 darwin/win 目录）——desktop.yml linux job 加装 python3/make/g++ 并对 deploy 步骤用 `--config.ignore-scripts=false`（Dockerfile L47-48 同款：onlyBuiltDependencies=[node-pty] 白名单下只放行 node-pty 编译），CI 验证点记 §16 边界。

### 11.3 console 产物形态

**结论：`output: 'standalone'` 产物 + `.next/static` + `public` 三件套（Docker 先例），入口 `standalone/apps/console/<distDir>/server.js`。**

- **本轮修了一个真 bug**（已落工作树）：`next.config.mjs` 的 `outputFileTracingRoot: new URL('../../', import.meta.url).pathname` 在 win 上产生 `/C:/…` 前导斜杠形态，`path.win32.relative` 算出错误相对路径——standalone 产物被**静默写进 `apps/projects/…` 垃圾树且构建 exit 0**（本机复现两轮，§16 #9）。改为 `fileURLToPath(new URL('../../', import.meta.url))` 后 standalone 正常落到 `.next-build/standalone/`（镜像仓库布局 `apps/console/ + packages/ + node_modules/`）。linux/docker 一直正常（pathname 在 POSIX 无此病），此修复对 Docker 无行为影响。
- **win 本机构建的符号链接权限门（如实记录，未绕过）**：Next 的 copyTracedFiles 对 pnpm 布局用 `fs.symlink` 复建符号链接（next/dist/build/utils.js:1219-1222），win 上无 Developer Mode/管理员时 EPERM——本机实测 symlink 探针 DENIED、构建在 standalone 尾段报 `EPERM symlink` 且 server.js 未写出。**对策**：本机构建完整安装包需开一次 Windows 开发者模式（设置→隐私和安全性→开发者选项，或管理员终端跑 dist:win）；stage-stack.mjs 检测构建日志含 EPERM 时给出一句话指引后非零退出。CI 侧 linux/mac 无此问题；GH windows runner 进程提权运行、预期可建（**未本机验证**，desktop.yml win job 是验证点，若踩中则 win 安装包改由本机开启开发者模式产出——README 已有「安装包取得方式」双通道）。
- 拉起：`ELECTRON_RUN_AS_NODE=1 <execPath> server.js`，env `PORT=3000 HOSTNAME=127.0.0.1 GATEWAY_URL=http://localhost:8080 NODE_ENV=production`（HOSTNAME 语义=docker-entrypoint L117 的 0.0.0.0 改本机回环——桌面形态无需对外）；`.next/static` 与 `public` 按 standalone 约定摆到 server.js 旁的对应位置。
- **distDir 约定**：打包构建用 `NEXT_DIST_DIR=.next-build`（不踩 dev 的 `.next`——AGENTS.md 已知问题），standalone 内部路径随 distDir 镜像（`standalone/apps/console/.next-build/server.js`），stage-stack.mjs 按此定位并在缺失时报错。`.next-build` 补进根 `.gitignore`（现状未忽略，实测 `git status` 暴露）。

### 11.4 打包布局与模式开关

extraResources 布局（electron-builder.yml 新增）：

```
resources/                          ← process.resourcesPath
  pg/native/{bin,lib,share,…}       ← @embedded-postgres tarball 的 package/native
  services/gateway/
    dist/  node_modules/  builtin-library/  quickstart-library/  package.json
  services/console/
    apps/console/.next-build/{server.js,server/,…}   ← standalone 镜像树
    node_modules/  packages/  package.json
    .next-build/static/  public/                    ← 静态三件套（按 standalone 约定落位）
```

- 源 staging 目录 `apps/desktop/stage/`：`.gitignore` 补条目 + **`.dockerignore` 补条目**（现状两处均未覆盖该路径——`.dockerignore` 的 `dist/`/`.next/` 是顶层锚定，嵌套目录不命中；bfac702 的教训是 desktop 物料进构建上下文会弄挂镜像，双护不可省）。asar 只装 desktop 自身 dist（files 不变），服务栈/pg 全在 extraResources（不进 asar——node-pty 等原生/文件 glob 资源本就不该进 asar）。
- **模式开关（三级，零配置默认 packaged）**：
  1. `resources/services/gateway` 存在 → **packaged 模式**（默认形态）：spawn 全走 §11.1 命令；repoRoot 不再需要。
  2. `config.json` 显式 `mode: 'dev'` → dev 模式（现行为：发现 repoRoot + pnpm dev 栈 + 依赖外部 PG）——需求 userStory「开发者仍可指向仓库 dev 栈」。
  3. 附加模式（8080/3000 已监听）→ 不 spawn（现行为保留，内嵌 PG 也不启动）。
- `dist:win` 扩展为完整打包入口：`pnpm run build && ensure:electron && ensure:postgres && stage-stack && electron-builder --win nsis`；CI desktop.yml 四 job 各加 ensure:postgres（按 matrix 平台取包）与 stage-stack 步骤。

### 11.4.1 M6 落地增补：三个实测坑与对策（全部本 session 真机踩中）

1. **win standalone 构建的 symlink 门 → pnpm patch 兜底**（R11 对策落地）：Next `copyTracedFiles` 对 pnpm 布局的链接原样 `fs.symlink` 复建，win 无开发者模式即 EPERM（本 session 复现两次）。**对策不是开发者模式**而是 `patches/next@15.5.20.patch`（pnpm patchedDependencies，登记于 pnpm-workspace.yaml）：`symlink EPERM && win32` 时目录链接降级 **junction**（pnpm 在 win 本就用 junction，语义等价且无需特权）、文件链接降级实体复制；**POSIX 行为零变化**（catch 只兜 EPERM+win32）。供应链论证：patch 是显式 diff，无 install script 放宽（onlyBuiltDependencies/ignore-scripts 原样）。
2. **pnpm 布局经分发链 deref 后解析链断裂 → staging 平铺规整**：junction/symlink 在 `cpSync → electron-builder extraResources → NSIS 安装` 三层拷贝中全部 deref 成实体——`apps/console/node_modules/next`（实体）向上 resolve 不到 `.pnpm` 里的同胞依赖，packaged 安装树实测 `Cannot find module 'styled-jsx'`（**仓库内 staging 探针是假阳性**：resolve 会漏到 monorepo 根 node_modules 命中，验证必须断言解析结果落在 staged 树内）。对策：stage-stack.mjs 的 `flattenPnpmToTopLevel` 把 `.pnpm/<entry>/node_modules/<pkg>` 全量提升（O(1) move 优先）到顶层 npm 平铺布局后删除 `.pnpm` + **死链自检非零退**——gateway 实体化 278 包、console 43 包，styled-jsx/node-pty resolve 全部 IN-STAGE。deploy 产出的绝对 junction **不可 move**（目标即断）——deploy 必须直落最终路径。
3. **win 目录锁噪声**：本机曾有系统进程锁死 staging 空目录壳（对删除/改名/rename 进内容全免疫，explorer 重启也不放）——staging 根换名 `stage/dist-services` 绕道（extraResources from 同步），stage-stack 清理策略改逐子项 + 「EBUSY 且已空则保留壳继续」。同款锁也偶发 `release*/win-unpacked/resources/app.asar`——打包遇 EBUSY 换 `--config.directories.output` 新目录即可。

**验收口径兑现（§15 M6 行）**：NSIS 静默安装（`setup.exe /S /D=<dir>`——Git Bash 下须写 `//S` 防 POSIX 路径转换）到仓库外独立目录 + 清空 userData = 全新机器语义；启动后 **30s 内** `/health {"ok":true,"db":"up"}` + console 200（`<title>Dagents</title>` + `_next/static/*.css` 200）+ 内嵌 PG 55432 LISTENING + 窗口接管（takeover 日志）；优雅退出（WM_CLOSE→will-quit）8080/3000/55432 全释放、0 残留进程；**卸载后 pgdata 存活**（NSIS 默认保留 userData）。dev 模式与附加模式回归不破（dev 全链 initdb→迁移→gateway on 8080；8080 被占→pg 诚实不启动 + gateway 附加）。实测安装包 494MB（R12 预算陈述：无 KPI，唯一警戒线 CI artifact 限额；NSIS 压缩率受 pg DLL/node-pty 二进制拖累属预期）。

### 11.5 体积预算（无 KPI，只做预算陈述）

| 组成 | raw | 进安装包（NSIS/dmg 压缩后估） |
|---|---|---|
| 现有 Electron 壳（实测） | ~250MiB | 111MiB |
| pg win-x64 native | 96MiB（tarball 37.3MB） | ~+40MiB |
| gateway deploy | 225MiB | ~+85MiB（node_modules 文本压缩率高） |
| console standalone+static+public | ~16MiB | ~+10MiB |
| **预计 win 安装包** | — | **~245–265MiB** |

darwin 因 PG 141MiB unpacked 会更大（dmg 压缩后另计，CI 实测回填）。outOfScope 明示不做极限优化；唯一主动性裁剪是 staging 排除 src/tsconfig/vitest.config 与 turbo 缓存。

**M6 win 实测回填**：实际安装包 **494MB**（494,001,291B，NSIS lzma）——高于预算陈述，主因 pg 的 20+ 个 DLL/OpenConsole 等原生二进制与 node-pty prebuilds 压缩率低、以及 pnpm 平铺规整后部分硬链接共享退化为独立副本。无 KPI（outOfScope），CI artifact 限额（win 单文件默认无压缩上限限流）为唯一警戒线；若需裁剪，后续可按「按需剔除非 win 平台的 node-pty prebuilds 与 pg DLL」立项。

## 12. 导航架构：根治「启动态页死路」（navArchitecture）——M7 已落地（死路场景/回退回归真机过）
### 12.1 病灶（需求痛点①的机制复核，均已在源码定位）

- `takeover.ts:81-84`：`showStartupPage()` 置 `pinnedBoot=true` 后，唯一解除条件是 `phase` 跌出 `'console'`（takeover.ts:76）——双服务持续健康时 **pin 永不解除**。
- `renderer/status.ts` 全文只有 重试/停止/在浏览器打开 三个出口；`status.ts:166-167` 钉住时 meta 仍写「双服务健康 · 正在接管工作台…」——文案失实（此时根本不会接管）。
- 菜单「打开启动态页」（menu.ts:36-39）同样只进不出。

### 12.2 方案：显式双向入口（内容意愿态模型）

**结论：不做 overlay/常驻状态栏，做「显式返回与重载入口」——零 console 改动的纯壳层方案（约束：兼容修复优先壳层）。**

1. **`pinnedBoot: boolean` → `contentIntent: 'auto' | 'boot' | 'console'`**（takeover.ts）：
   - `auto`：现自动行为（双健康接管、跌落回 boot）；
   - `boot`：钉住启动态页（原 pinnedBoot 语义；phase 跌落时**仍自动回 auto**——回退逻辑不回归，需求原文）；
   - `console`：用户意愿「我要进工作台」——立即解除钉住并尝试 `loadURL`（不健康时按 §12.3 按钮 disabled，但意愿记录保留，双健康一恢复即接管）。
2. **新 IPC 通道 `desktop:enterWorkbench`**（ipc.ts）+ preload 暴露 `enterWorkbench(): Promise<void>`（preload/index.ts）——启动态页「进入工作台」按钮的动作线。
3. **启动态页**（status.ts/index.html）：header actions 区新增主按钮「进入工作台」——`phase === 'console'` 时 enabled（primary 高亮；钉住时尤甚——这就是死路出口）；不健康时 disabled 且 meta 文案给出原因。meta 文案修正：钉住+双健康 → 「服务健康 · 已停留在此页——点「进入工作台」或菜单「服务 → 进入工作台」返回」。
4. **菜单**（menu.ts）：「服务」组重排为：**进入工作台** / 服务状态页（原「打开启动态页」改名，语义即钉）/ 重启服务 / 停止服务 / 在浏览器打开 console。菜单是 Electron 原生层——**任何 web 页面崩溃/卡死都不影响它可达**，这是故障态兜底的第一锚点。
5. **不变式（验收口径）**：任何时刻满足以下之一可达工作台——(a) 自动接管（auto + 双健康）；(b) 启动态页按钮（boot 态 + 双健康）；(c) 菜单「进入工作台」（永远可点，不健康时给 toast/文案反馈而非静默）。反向：任何时候菜单「服务状态页」可达状态页。`did-fail-load` 回退与 phase 跌落自动回 boot 的现有行为保留（回归项写进 M7 验收）。
6. `DesktopSnapshot` 增 `contentIntent` 字段（渲染层可显示「已钉住」徽标）——契约仍由 tsc typecheck 钉住。

**为什么不做常驻状态栏/overlay**：console 是完整 Next 应用，向其注入常驻 UI 需要 webContents.executeJavaScript 或 WebContentsView 叠加——CSP/样式冲突/生命周期（导航瞬间闪烁）三面都是新失败面，而需求只要「随时能回工作台 + 随时能看状态」。菜单 + CTA 双锚点零 console 改动即可满足。WebContentsView 底部状态条列为体验侧可选增强（非阻塞，见 uxPlan），若做则独立于本节不变式。

## 13. 兼容排查框架（痛点②的工程面）——M7 已落地（全表见 docs/desktop-compat-matrix.md，15 项真机结论）

> 具体逐项修复与结论在 **`docs/desktop-compat-matrix.md`**（页面×功能×结论×证据全表 + 死路场景实录 + 壳层修复清单 + 明示边界 + 复验方法学）。本章只定框架与壳层优先原则；M7 落地的壳层接线集中在 `src/main/index.ts` 的 `wireShellCompatibility()`（外链 setWindowOpenHandler/通知双钩子+AppUserModelID/下载 will-download/历史 Alt+Left·Right/导航防护 will-navigate）。**实测翻案**：`window.confirm` 在 Electron 44 原生可用（弹真模态框、返回值正确）——需求「嫌疑清单」对此项系误判，矩阵 #4 留证。

- **修复优先级**（约束原文）：main/preload/session 层（`setWindowOpenHandler → shell.openExternal`、`setPermissionRequestHandler`、`app.setAppUserModelId`、session 下载行为、菜单加速器审查）> console 源码逐处论证（每处必须说明「为什么壳层解决不了 + 浏览器行为不受影响的依据」）。
- **矩阵骨架**（页面 × 功能 × 结论 × 证据），首版必查清单（需求 inScope 原文）：外链/新窗口（assistant-content.tsx:655、form-engine.tsx:159 实测）、剪贴板（12 处 writeText）、系统通知（use-desktop-notification.ts:50 permission 门 + AppUserModelID）、window.confirm（3 处）、终端页（xterm 输入/粘贴/快捷键/多标签/SSE 直播——打包版全链路，§14 已退役 ABI 风险）、下载行为、快捷键/加速器冲突（Ctrl+W/Ctrl+R/Ctrl+Shift+I vs Ctrl+K/S/Enter/Esc）、历史返回（Alt+Left/鼠标侧键）、标题/favicon、缩放、localStorage、拖放。
- 每项结论三值：**可用（真机过）/ 修复后可用（指向 PR）/ 明示边界（文档化降级）**。验收员按矩阵 100% 复验。

## 14. 终端策略（terminalStrategy）

**结论：打包版终端可用（node-pty 经 ELECTRON_RUN_AS_NODE 原样工作），不设降级位、不延后。**

- **论据（全部实测，§16 #2/#3/#6）**：
  1. node-pty 1.1.0 是 **N-API 绑定**（binding.gyp:4 依赖 `node-addon-api` targets；lib/utils.js:19 直接从 `prebuilds/<platform>-<arch>` 加载）——N-API 跨 modules ABI 稳定，不随 Node 大版本重编；
  2. **双运行时真跑 PASS**：系统 Node 22.23.3（modules 127）与 electron 44.5.1 as Node（Node 24.21.0 / modules 149）各自加载同一枚 win32-x64 prebuild、起真 cmd.exe PTY、回读输出、干净退出（两次输出逐字节一致）；
  3. deploy 产物（ignore-scripts 之下 npm 零脚本执行）里 node-pty 带 prebuilds 进包，gateway 在 Electron-as-Node 下健康——含 node-pty 静态 import 链路的整进程验证。
- **平台矩阵**：win-x64 本机实证；darwin-x64/arm64 prebuild 随 tarball（本机不可验，CI 验证；`spawn-helper` 可执行位丢失的老坑由网关启动自愈 chmod 覆盖——AGENTS.md 终端章既有机制）；linux-x64 无 prebuild，CI 编译（§11.2）。
- **UI 呈现**：终端页**零新增降级 UI**——`/terminal` 是 gateway 路由驱动的真 PTY 直通，gateway 活则终端活。仅补一条诚实边界：若未来某平台 node-pty 加载失败（如 CI 编译缺失、napi 不兼容），gateway `/shell` 系路由 503 + 错误信封（沿用 `DAGENTS_SHELL_DISABLED` 同类语义），终端页现有错误态渲染，矩阵记「明示边界」。单一回归点 = CI 重编 prebuild，架构无需改。
- 需求约束原文「node-pty ABI 必须与所选打包运行时真机验证兼容，验证结论与选型理由写入 docs/desktop-architecture.md 增补章后方可定稿」——本章即该增补章，§16 #2/#3 为证据。

## 15. 第二轮里程碑

| # | 里程碑 | 交付内容 | 验收口径 |
|---|---|---|---|
| M5 | **内嵌 PG 切片 + 门禁全绿** | ensure-postgres.mjs；orchestrator pg 服务 + bootstrap 管线（纯度测试覆盖）；config schema（postgres.* + mode）；状态页第三卡 | 根命令 `pnpm test && pnpm lint && pnpm typecheck` 全绿；win 真机：空 userData 首启 → initdb → 迁移 → gateway `db:'up'`；55432 被占自动让位且状态页明示；退出 PG 停净（端口+进程断言） |
| M6 | **服务栈入包** | stage-stack.mjs（console standalone + gateway deploy + 裁剪落位）；electron-builder extraResources；packaged 模式编排（ELECTRON_RUN_AS_NODE spawn + bootstrap 迁移走 staged migrate.mjs）；dist:win 完整入口；desktop.yml matrix 扩展；.gitignore/.dockerignore 补条目 | win 真机全新机器语义（无仓库/docker/pnpm/node）：安装 → 双击 → 内嵌 PG 自动就绪 → 工作台可用 → 退出 8080/3000/PG 端口与进程全净；CI 四 job 产物可下载；dev 模式与附加模式回归不破 |
| M7 | **导航修复 + 兼容矩阵 + 收口** | §12 全量（enterWorkbench 通道/意愿态/文案/菜单）；壳层兼容修复（setWindowOpenHandler、AppUserModelID+通知权限、confirm、下载、加速器）；`docs/desktop-compat-matrix.md` 全表真机结论；README/本文档收口 | 痛点①死路场景（钉住→双健康→一键回工作台）真机过；矩阵逐项 100% 复验；「杀 console→自动重启→窗口恢复」回归；根命令门禁最终态全绿 |
| U1 | **启动态页产品化 + 死路根治（体验侧 uxPlan-1）** | 状态页信息层级重做（全局状态灯/诚实 meta/bootstrap 红横幅/首启五步进度/首启教育/三服务卡分级指引/日志面板 400 行复制+打开完整日志）；文案真值表纯函数层 `renderer/status-copy.ts`（模式分叉：dev 话术不泄漏 packaged）；「进入工作台」呼吸高亮 + S4/S5b/S6/S10 诚实文案；窗口状态记忆（bounds+maximized+zoom，显示器交集回退）；三平台真实图标（零依赖生成器 + build/ 产物入库）；快照 config 增 healthTimeoutMs/logsDir/appVersion；菜单增数据/日志目录与关于面板 | 真机 CDP：S4 钉住+双健康（呼吸高亮+诚实 meta+步条 ⑤◐ 指引）→ 点击回工作台 ✓；pg 崩溃恢复竞态真实触发→红横幅原文+「重试初始化」→恢复自动接管 ✓；等待预算本地 1s 走秒 ✓；Win32 移动缩放 160,120,1188×742 → 优雅关窗 → 重启精确恢复 ✓；优雅退出 8080/3000/55432 全释放 0 残留 ✓；desktop 175 用例/typecheck 双 tsconfig/lint/check-builder-config 全绿 |

（体验侧里程碑 U 系列由 uxPlan 承载，U1 已落地；后续 U 系列沿用本文档 §16 证据表口径。）

## 16. 第二轮实测证据表（win32 真机，2026-10-07）

环境：Windows 10 19045，node v22.23.3 / pnpm 10.26.0；`~/.npmrc` 带**失效代理** `proxy=127.0.0.1:7890`（第一轮 §2.4 已记录的既有网络条件——凡涉 pnpm 元数据请求的探测均以 `HOME=/tmp/fakehome` 隔离该配置后执行）。

| # | 命令（探针目录均用后即删） | 结果 |
|---|---|---|
| 1 | `curl registry.npmmirror.com/@embedded-postgres%2F{windows-x64,linux-x64,darwin-x64,darwin-arm64,windows-arm64}` | 前四者 latest=18.4.0-beta.17、均带 `postinstall: hydrate-symlinks.js`、unpackedSize 96/56/141/141MiB；**windows-arm64 404 不存在** |
| 2 | `node /tmp/pty-abi-test.js`（require 仓库 node-pty → spawn cmd.exe PTY → 回读） | **PASS**（Node 22.23.3 / modules 127 / napi 10） |
| 3 | `ELECTRON_RUN_AS_NODE=1 apps/desktop/release/win-unpacked/dagents.exe /tmp/pty-abi-test.js` | **PASS**（Node 24.21.0 / modules 149 / napi 10；输出与 #2 一致）——ABI 风险退役 |
| 4 | `curl -sL @embedded-postgres/windows-x64-16.14.0-beta.17.tgz`（npmmirror） | 37,303,807 字节下载成功；解包 `package/native/bin/`：initdb.exe/postgres.exe/pg_ctl.exe + DLL（**无 pg_isready/psql/createdb**）；`native/pg-symlinks.json` = `[]` |
| 5 | `initdb -D data -U dagents -A trust` → `pg_ctl -o "-p 55432 -h 127.0.0.1" start` → node pg 8.22 连接/建库/查询 → `POSTGRES_URL=… node packages/db/scripts/migrate.mjs` → `pg_ctl stop -m fast` | 全链路 PASS：PG 16.14 起于 55432、`select 1` ok、迁移链全量应用（输出自 DropOrphanedTables… 至 FlowContextMd 止，无失败项）、停净（端口释放 + 无 postgres.exe）；**deploy 树内 migrate.mjs 亦 PASS**（schema already up to date） |
| 6 | `ELECTRON_RUN_AS_NODE=1 POSTGRES_URL=… GATEWAY_PORT=8090 dagents.exe /tmp/gwdeploy/dist/index.js` | gateway on 127.0.0.1:8090；`/health` → `{"ok":true,"svc":"gateway","db":"up"}`；`/metrics` 200；taskkill 后端口释放——**packaged 运行时全栈语义实证** |
| 7 | `HOME=/tmp/fakehome pnpm --filter @dagents/gateway deploy --prod --legacy /tmp/gwdeploy` | 225MiB（node_modules 222MiB +287 包）；workspace 包真实拷贝；node-pty 带 prebuilds；builtin/quickstart-library 随包；**不带 --legacy 报 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE（pnpm 10 语义）** |
| 8 | `ELECTRON_RUN_AS_NODE=1 dagents.exe -e "console.log(process.versions)"` | Node 24.21.0 / modules 149 / napi 10 / electron 44.5.1 |
| 9 | console standalone：`NEXT_DIST_DIR=.next-build next build` ×2（修前/修后） | 修前：exit 0 但**无 standalone/**，产物错落 `apps/projects/dagens/…` 垃圾树（outputFileTracingRoot pathname 坑，本机复现）；修后（fileURLToPath）：`standalone/{apps/console,packages,node_modules}` 正常出现（11MiB）+ static 5MiB；**随后 EPERM symlink 中断**（本机无 Developer Mode，探针证实 symlink DENIED）——CI/linux 与 Docker 先例不受影响，win 本机需开发者模式（§11.3 对策） |
| 10 | `node_modules/.pnpm/node-pty@1.1.0`：读 binding.gyp / lib/utils.js / prebuilds/ | N-API（node-addon-api）绑定；prebuilds/{darwin-arm64,darwin-x64,win32-arm64,win32-x64}（**无 linux**）；加载路径 build/Release → prebuilds/<plat>-<arch> |

**未验证（如实记录，归 CI 或后续里程碑）**：mac/linux 打包与 node-pty（约束 2 归 CI matrix；linux 需编译步骤 §11.2）；`@embedded-postgres` linux/darwin 包 pg-symlinks.json 内容与 hydrate 效果；GH windows runner 的 symlink 特权（§11.3 风险预案）；三平台真实安装包体积（§11.5 预算待 CI 回填）。

**M7 验收实测（win32 真机，2026-10-07，全部本 session 实跑；CDP 驱动 = electron . --remote-debugging-port + Runtime.evaluate/Input 真实输入流）**：

| # | 场景 | 结果 |
|---|---|---|
| M7-1 | 死路场景（钉住→双健康→一键回） | 工作台 `showStartupPage()`（preload 通道，与菜单同线）→ 钉住；双健康 6s 复核仍钉住（原病灶如实复现）+ meta 诚实文案/钉住徽标/按钮 enabled·primary 三断言过；页面按钮 click → 4s 内回 `localhost:3000` ✅ |
| M7-2 | 回退回归（R16） | taskkill console dev → 窗口自动回启动态页 + 钉住自动解除 + 「意愿保留」文案 → 有界重启（~10s）→ **自动接管回工作台** ✅（did-fail-load 分支原样保留） |
| M7-3 | 矩阵 15 项 | 全表见 docs/desktop-compat-matrix.md：外链（hit-server 收 GET+零子窗口）/剪贴板（Get-Clipboard 读回）/通知（permission granted + onshow）/confirm（**原生可用，翻案**）/终端（xterm 41 行+SSE+真实键入 2 处回显）/下载（落 Downloads）/快捷键零冲突（grep 实录）/Alt+Left·Right（navigationHistory）/标题/localStorage/导航防护/SSE·WS ✅ |
| M7-4 | 方法学坑（复验者须知） | CDP modifiers 位 Alt=1（8 是 Shift）；xterm 只吃带 text 的真实输入；剪贴板项需先真实点击拿焦点；confirm 阻塞 evaluate（SendKeys 驱动模态）——全记矩阵文档末节 ✅ |
| M7-5 | 门禁 | desktop vitest 127 过 + typecheck/lint 净；根门禁三件套见下 ✅ |

**U1 验收实测（win32 真机，2026-10-07，全部本 session 实跑；CDP 9444 + Win32 SetWindowPos/CloseMainWindow + PowerShell 探针）**：

| # | 命令/操作 | 结果 |
|---|---|---|
| U1-1 | `node scripts/generate-icons.mjs` ×2 + sha256 对比 | 三格式生成 + 内建回读自校验（PNG IHDR/IDAT/CRC、ICO 条目、ICNS magic）过；**重跑同字节（确定性）**；ASCII 渲染抽样像素 = #0f1115 底/#7aa2f7 节点、圆角外 alpha=0 ✅ |
| U1-2 | `electron . --remote-debugging-port=9444`（dev 全栈）→ CDP 探针 | 冷启 12s 内全栈健康**自动接管**；状态页逐态实证：启动中（五步 ○◐● 推进 + 「已等 Ns/预算 120s」**本地 1s 走秒** 2s→4s）→ 强杀残留触发真实 pg 崩溃恢复竞态 → 红横幅「数据库初始化失败——服务栈启动已停止」+ **错误原文直译**「建库失败：the database system is starting up」+ gateway/console 卡「待命（等待数据库就绪）」→ 点「重试初始化」→ ~35s 恢复自动接管 ✅ |
| U1-3 | 工作台 → `showStartupPage()` 钉住 → CDP 断言 → 点「进入工作台」 | S4 态全要素：全局灯绿「服务健康」+ meta「服务健康 · 已停留在此页——点『进入工作台』…」（失真文案已灭）+ 钉住徽标 + 步条 ●●●●◐（⑤ note「已就绪——点『进入工作台』」）+ 按钮呼吸高亮（唯一脉动元素）→ 点击 4s 内回 localhost:3000 工作台（死路出口闭环）✅ |
| U1-4 | Win32 `SetWindowPos(160,120,1188,742)` → `CloseMainWindow()` → 读 `window-state.json` → 重启 → `GetWindowRect` | 落盘 `{"bounds":{160,120,1188,742}}`；重启恢复**逐像素一致**（160,120,1188×742）；优雅退出 8080/3000/55432/9444 全释放、0 electron 残留（机器既有 5432/15432 实例不受扰）✅ |
| U1-5 | desktop 自检 | vitest **175 过**（+window-state 10 +status-copy 39）/typecheck（主 CJS + renderer ESM 双 tsconfig）/lint/check-builder-config（新增 icon 契约断言）全绿 ✅ |
| U1-6 | 未验证（如实记录） | Ctrl+= 缩放档位的 E2E 键盘路径（SendKeys 未达 Electron 菜单加速器、CDP Emulation.setPageZoomFactor 在 Electron 44 不可用——zoom 持久化管线由 window-state 单测钉住，bounds/maximized 已 E2E）；菜单「关于/打开文件夹」对话框的人工目击；packaged 形态重打包后的图标四场所（D1）归 CI/desktop.yml |

**M6 验收实测（win32 真机，2026-10-07，全部本 session 实跑）**：

| # | 命令/操作 | 结果 |
|---|---|---|
| M6-1 | `pnpm patch next@15.5.20`（junction 兜底，§11.4.1 #1） | EPERM 复现两轮后 patch 生效：standalone 构建完整产出（server.js+static 5MiB）；patch 登记 pnpm-workspace.yaml patchedDependencies + lockfile patch_hash，**onlyBuiltDependencies/ignore-scripts 零改动** ✅ |
| M6-2 | `node scripts/stage-stack.mjs` ×N | gateway deploy（+287 包，NPM_CONFIG_USERCONFIG 过滤失效代理）+ console standalone 三件套 + **pnpm 平铺规整**（gateway 实体化 278 包/console 43 包 + 死链自检零残留）+ tsconfig 构建污染自动还原；resolve 断言 IN-STAGE（styled-jsx/node-pty/typeorm/@dagents/db）✅ |
| M6-3 | staged 树探针（打包前） | console server.js（node + PORT=3100）：home 200 + `_next/static/*.css` 200；gateway dist/index.js（node + docker PG DSN）：`/health {"ok":true,"db":"up"}` + `/metrics` 200 ✅（首版探针曾因「仓库内 resolve 泄漏」假阳性——§11.4.1 #2 记录） |
| M6-4 | `electron-builder --win nsis`（extraResources pg+services） | 494MB 安装包产出（winCodeSign 走 npmmirror 镜像缓存；EBUSY asar 锁换 output 目录绕道——§11.4.1 #3）✅ |
| M6-5 | **全新机器语义**：卸载旧装 → 清 `%APPDATA%\@dagents` → `setup.exe /S /D=…m6b`（Git Bash `//S`）→ 启动 dagents.exe | **30s 内** gateway `db:up` + console 200（title/css）+ PG 55432 LISTENING + **窗口接管工作台**（takeover 日志）；优雅退出三端口全释放、0 进程；卸载后 pgdata 存活 ✅ |
| M6-6 | dev / 附加模式回归（R17） | dev 全链（initdb→迁移→DSN 注入→`gateway on 127.0.0.1:8080`→优雅停净）；8080 被哑 listener 占→「附加模式：不启动内嵌 Postgres」日志 + 55432 零监听 + gateway attachMode ✅ |
| M6-7 | 根门禁 | `pnpm test`（14/14）/`pnpm lint`/`pnpm typecheck` turbo 全绿；desktop vitest 127 用例（含 run-mode 9 + packaged 编排 2 + pg packaged 迁移载体）；check-builder-config 扩展映射型序列项解析 + extraResources 契约断言 ✅ |

**未验证（如实记录，归 CI）**：desktop.yml 四 job 实跑与 artifact 可下载性（配置已扩展：全仓 build（desktop 除外）→ ensure:postgres → stage:stack → 打包；linux 加 python3/make/g++ + deploy --config.ignore-scripts=false；win runner 的 symlink 提权预期与 npmmirror 可达性是验证点）；mac dmg / linux AppImage 体积与 hydrate-symlinks 非 win 行为。

**M5 验收实测（win32 真机，2026-10-07，全部本 session 实跑）**：

| # | 命令/操作 | 结果 |
|---|---|---|
| M5-1 | `node scripts/ensure-postgres.mjs`（首跑） | 元数据 unpackedSize=100,356,432B；tarball 37,302,807B 下载 → 解包（坑：PATH 命中 GNU tar 把 `C:\` 当远程主机，改 cwd+相对路径双兼容）→ hydrate-symlinks 显式执行 → `native/bin/{initdb,postgres,pg_ctl}.exe` 就位；二跑幂等短路 ✅ |
| M5-2 | 清空 userData → `pnpm --filter @dagents/desktop run dev` | initdb（6.1s）→ postgres 前台直跑 55432 LISTENING → 建库「已创建数据库 dagents」→ 迁移全量应用（尾项 denAgentsVisibilityChk…）→ gateway 注入 `postgresql://dagents@127.0.0.1:55432/dagents` → **50s 内 `/health` `{"ok":true,"db":"up"}`**；console :3000 200；pgdata 结构在位 ✅ |
| M5-3 | 首跑暴露真 bug（已修） | CJS 产物 `await import(file://…)` 被 tsc 降级 require → 建库 `Cannot find module 'file:///…pg/lib/index.js'` → gateway 诚实不启动（失败语义正确）；修为 createRequire 直 require 后全链通 ✅ |
| M5-4 | 让位：哑 listener 占 55432 → 重启 dev | pg.log「默认端口 55432 被占用，让位至 55433（第 2 次探测命中）」；55433=内嵌 PG、55432=dummy 并存；DSN 注入 55433 且 `/health` db:up ✅ |
| M5-5 | 优雅退出（`taskkill /PID <main>` 无 /F = WM_CLOSE → will-quit） | pg.log 三段：「进程退出 code=0（优雅停止流程中，不触发重启）」→「终止进程树 pid=…」→「内嵌 Postgres 已停净（端口 55433 释放）」；8080/3000/55433 全释放、无 electron/node/postgres 本实例残留（机器上既有 5432 原生 + 15432 docker 实例不受扰——55432 选址的现实佐证）✅ |
| M5-6 | 单测/门禁 | desktop vitest 116 passed（pg-service 24 + supervisor 28 + state-machine 24 + config 13 等；purity 守护续钉）；lint/typecheck/build 净 ✅ |

## 17. 第二轮风险增补（第一轮 R1–R8 保留）

| # | 风险 | 对策 |
|---|---|---|
| R9 | **内嵌 PG 数据目录损坏/版本不兼容**（异常关机残留 postmaster.pid 等） | bootstrap 检测 `postmaster.pid` 残留 → 状态页明示 +「重置数据目录」动作（显式用户确认，不静默删数据）；跨 major 升级不做（§10.4） |
| R10 | **ELECTRON_RUN_AS_NODE 泄漏给孙进程**（用户的 CLI agent 若是 Electron GUI 应用会被切 node 模式） | 现网 claude/codex 均非此形态；README 记录边界；config.extraEnv 可针对性覆盖 |
| R11 | **win 本机 standalone 构建的 symlink 权限门**（§16 #9） | 文档化开发者模式一次性开关；stage-stack.mjs 检测 EPERM 给指引非零退；CI win job 验证，踩中则安装包改由 CI/本机开发者模式产出 |
| R12 | **打包体积膨胀**（~245-265MiB 预算） | 无 KPI（outOfScope）；唯一警戒线=CI artifact 上传限额与下载体验，超预算再裁（standalone 本就不含 dev 依赖） |
| R13 | **staging 物料泄进服务镜像/工作树** | `apps/desktop/stage/` 双 ignore（git+docker）+ CI 校验步骤（M6 验收含 `docker build` 不拾取 stage 的检查） |
| R14 | **内嵌 PG 与用户本机 PG 生态抢端口/抢连接** | 55432 默认+让位策略（§10.3）；外部 POSTGRES_URL 三层不抢连接（§10.4）；只绑 127.0.0.1 |
| R15 | **CI linux node-pty 编译失败**（无 prebuild） | Dockerfile 同款工具链 + `--config.ignore-scripts=false` 白名单语义（onlyBuiltDependencies 只放行 node-pty）；失败属 CI 可见性错误，不污染本机门禁 |

---

*第二轮设计完。第一轮 §1–§9 仍是壳体/编排器/供应链机制的真相源；两轮冲突处（Postgres 编排边界、启动态页出口、dev 栈默认形态）以 §10–§17 为准。*
