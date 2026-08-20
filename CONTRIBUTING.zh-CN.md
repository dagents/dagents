# 贡献指南（Dagents）

感谢参与贡献！本指南带你从零 clone 到跑通开发栈并提交第一个 PR。

**[English](./CONTRIBUTING.md) · 简体中文**

## 前置依赖

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22** | `node -v` 检查；部分 CLI agent（openclaw）需要较新的 22.x 补丁版本 |
| pnpm | 10.x | `corepack enable` 会按 `package.json` 的 `packageManager` 锁定版本 |
| Docker | 近期版本 | 跑 Postgres（+ 可选 Langfuse）开发栈 |
| Git | 任意 | |

建议至少安装一个 coding-agent CLI（如 `claude`）以便端到端运行，但多数测试不依赖它。

## 获取代码

```bash
git clone https://github.com/<owner>/dagents.git
cd dagents
pnpm install
```

> `.npmrc` 设了 `ignore-scripts=true` —— 有意为之：vendored 的 `vendor/agentflow`
> 包的 `husky install` postinstall 会失败（它没有 `.git`），因此全局跳过脚本。

## 启动开发栈

```bash
# 1. Postgres (:15432) + Langfuse (:3001，可选 profile)
cd infra && docker compose up -d && cd ..

# 2. 环境变量（默认值与 infra 栈一致，通常无需修改）
cp .env.example .env

# 3. 数据库迁移
pnpm --filter @dagents/db migration:run

# 4. Gateway (:8080)
pnpm --filter @dagents/gateway dev

# 5. Console (:3000) —— 另开一个终端
pnpm --filter @dagents/console dev
```

打开 http://localhost:3000。如需运行 daemon（仅 `remote` 类型 Agent 需要，
默认执行路径是 inline）：

```bash
pnpm dev:daemon
```

### Docker 全栈（不需要 dev server）

```bash
docker compose up
# → 构建整个 monorepo、等待 Postgres、自动跑迁移、
#   启动 gateway + console。打开 http://localhost:3000
```

## 常用命令

```bash
pnpm build          # turbo 构建（tsup → dist/，console 走 next build）
pnpm test           # vitest run，按包执行
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint（vendored agentflow 不参与）

# 单文件 / 单测试
pnpm --filter @dagents/gateway exec vitest run src/__tests__/cli-first.test.ts
pnpm --filter @dagents/gateway exec vitest run -t "degrades to a placeholder"

# 数据库迁移（TypeORM，packages/db）
pnpm --filter @dagents/db migration:generate   # 从 entity 改动生成
pnpm --filter @dagents/db migration:revert     # 回滚最近一条
```

## 测试

- **单元测试** —— Vitest，与源码同目录（`*.test.ts` 或 `src/__tests__/`）。
  Gateway 测试直接通过 `app.request()` 驱动 Hono 应用。
- **依赖数据库的测试** —— gateway/db 的部分套件会初始化真实 Postgres 连接。
  先启动 infra 栈（:15432），或依赖 CI 中的 Postgres service。
- **E2E** —— `apps/console/tests/e2e/` 的 Playwright 套件跑在
  **Mock LLM Provider**（:4010 的 OpenAI 兼容假服务）上，无需真实 key。
  完整说明见 `apps/console/tests/e2e/README.md` 与 `docs/e2e-test-plan.md`
  （专用 `dagents_e2e` 库、`flow-builder` 构造器）。
  - e2e 中途强杀可能在 dev 库残留 mock provider 行（`e2e-mock-%`），导致
    真实 LLM 调用指向死掉的 mock。清理：
    `DELETE FROM llm_providers WHERE name LIKE 'e2e-mock-%';`

功能开发遵循 TDD：失败测试 → 最小实现 → 提交，每个任务随测试落地。

## 仓库结构

```
apps/console        Next.js App Router 界面（Chat-First，中英双语）
apps/gateway        Hono API 服务（认证、工作流、dispatch、LLM 代理）
packages/contracts  零依赖共享类型（agent、协议）—— 最先构建
packages/agent-adapters  17 种 CLI agent 适配器（claude、codex、…）
packages/daemon     pull-based daemon（register → heartbeat → claim → execute）
packages/db         TypeORM entities + migrations
packages/workflow   仓库内工作流引擎（14 节点、DAG 执行器、SSE）
packages/shared     OTel、日志、Langfuse 客户端
vendor/agentflow    vendored Flowise Agentflow 画布（Apache-2.0，见 NOTICE）
```

依赖方向无环：`contracts ← {agent-adapters, daemon, db} ← gateway`；
`workflow ← gateway`；`vendor/agentflow ← console`。完整契约见 `CLAUDE.md`。

## 代码风格与提交

- TypeScript strict 模式，跟随周边风格。ESLint warning
  （`no-unused-vars`、`react-hooks/exhaustive-deps`）设计上不阻断；
  error 会挂 CI。
- **约定式提交**：`feat(scope): …`、`fix(scope): …`、`docs: …`、`ci: …`
  —— 单行，不加署名 trailer。
- 界面文案直接写中文并用 `t('…')` 包裹，英文词条加到
  `apps/console/src/i18n/en/`，缺译自动回退中文。

## Pull Request

1. 从 `main` fork / 切分支。
2. PR 保持小而聚焦；用 `Closes #123` 关联 issue。
3. 填写 PR 模板（改了什么 / 为什么 / 怎么测的 / 风险）。
4. 新行为必须带测试（happy path + 至少一个失败/边界场景）。
5. 行为变更的文档同 PR 更新 —— 文档地图在 `docs/README.md`，主题文档
   （`docs/workflow-engine.md` 等）与代码同步演进，不允许滞后。

较大的功能走 brainstorm → spec → plan 流水线（`docs/superpowers/`）；
重大架构变更请先开 Discussion / issue 讨论，不要直接甩 PR。

## 已知的坑

- **console dev server 运行期间不要跑 `pnpm build`**。生产构建会覆盖
  `apps/console/.next`，dev server 会全站 500。turbo 的 `pnpm test` 也可能
  触发 —— 拿不准就用包级测试（`pnpm --filter <pkg> test`）。中招后跑
  `bash restart-gateway.sh` 清缓存重启。
- gateway 默认绑定 `127.0.0.1` —— 对外暴露前必读 `README.md` 安全须知。

## 求助渠道

- 问题讨论开 [Discussion](https://github.com/<owner>/dagents/discussions)。
- 可复现问题用 bug 模板开 issue。
