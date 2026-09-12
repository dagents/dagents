# Agent 开发手册（cookbook）

> 面向 AI agent / 新成员的"常见任务怎么做"。按任务组织，每条给文件位置 + 惯例 + 红线。
> 全景架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；命令与端口见 [`AGENTS.md`](../AGENTS.md)。

---

## 0. 开发红线（先读）

1. **dev server 运行期间勿跑 `pnpm build` / 全仓 `pnpm test`**——会覆盖 `.next` 或重建 packages/dist，导致 dev 全站 500 / gateway tsx watch 重启杀掉进行中的 run。误跑后用 `bash restart-gateway.sh` 恢复。
2. **服务无响应先跑一键重启**：`bash restart-gateway.sh`（杀进程链 + 清缓存 + 健康检查 + 日志到 /tmp）。
3. **gateway 集成测试自动用 `dagents_gw_test` 库**（globalSetup 注入），不碰 dev 库；但**新增全表 DELETE 的测试**必须像 `chat-execute.test.ts` 那样备份/恢复 + 默认数据守护。
4. **改动未提交时说清楚**——多 agent 并行开发是常态，提交前 `git status` 核对只含自己的改动；大文件（备份/tar）绝不入库（.gitignore 已含 backups/）。
5. **测试 flow 数据会变**——别硬编码 flow id/名字到测试；用 API 动态查找或自己创建。

## 1. 加一条界面文案（i18n）

1. 组件里直接写中文并用 `t('中文')` 包裹（`import { useI18n } from '@/i18n'`，组件体首行 `const { t } = useI18n()`）。
2. 英文词条加到 `apps/console/src/i18n/en/` 对应模块（common/chat/agents/flows/daemons/settings）。
3. 插值用 `t('{n} 个', { n })`；属性字符串改 `aria-label={t('…')}`。
4. 模块级常量表里的中文值：值保留中文作 key，渲染处 `t(map[x])`。
5. 测试断言中文不受影响（zh 默认下 `t()` 返回原文）。

## 2. 加一个页面

1. `apps/console/src/app/<route>/page.tsx`：服务端组件拉数据 → 渲染 client 组件；数据经 BFF `/api/*`（gateway URL 只在服务端，参考 `lib/config.ts` 的 `gatewayUrl()`）。
2. BFF 路由：`app/api/<resource>/route.ts`，用 `lib/workflow-proxy.ts` / `lib/proxy-headers.ts` 的公共助手。
3. 导航：`components/nav.ts`（sidebar 条目 + breadcrumb）；i18n 词条同步 `en/common.ts`。
4. 大客户端组件（画布类）必须 `next/dynamic` + `ssr:false`（经 loader 组件），避免顶层 `document` 访问炸 SSR。

## 3. 改工作流引擎 / 加节点类型

1. 节点实现：`packages/workflow/src/nodes/<type>/`；画布元数据（label/inputs/outputs/颜色）在 `nodes/node-registry-canvas.ts` 的 `CANVAS_NODES`。
2. 引擎钩子：`DagExecutor.execute` 的 `onNodeStart/onNodeEnd`（span-writer 消费，画布进度数据源）——不要在钩子里做长阻塞操作（fire-and-forget 惯例）。
3. 测试：`packages/workflow/src/__tests__/executor.test.ts`（纯引擎，无 DB）。
4. 改完 `pnpm --filter @dagents/workflow build`（gateway 消费 dist；dev 模式 tsx watch 会自动重启——注意会杀进行中的 run）。

## 4. 加/改一个 CLI 适配器

1. 实现：`packages/agent-adapters/src/<cli>.ts`，导出 `build<Cli>Args` + backend（事件流解析成 contracts 的 `AgentEvent`）。
2. **非交互权限**：必须带自动授权标志（claude=`--permission-mode bypassPermissions`、codex=`--full-auto`、qwen=`--yolo`、copilot=`--allow-all-tools`），否则写类工具全被拒、模型绕路后报"没权限"。提供 env 覆盖开关。
3. 注册：`apps/gateway/src/inline-executor.ts` 的 `INLINE_SUPPORTED_KINDS` + `createBackend` 工厂。
4. 分级维护单源：`packages/agent-adapters/src/tiers.ts`（core：claude/codex/qwen）。
5. 本机未装的 CLI：按官方文档格式写，在文档标注"未经真实 CLI 回归"。

## 5. 技能 / 人格库

- 均为 registry-not-database：文件系统是真相源，不落库、正文不缓存（60s TTL 目录 + 强制 refresh）。
- 技能：`~/.agents/skills`（`DAGENTS_SKILL_DIRS` 追加）；扫描在 `apps/gateway/src/skills-registry.ts`。
- 人格：`~/.agents/agent-library`（`DAGENTS_AGENT_LIBRARY_DIRS`）；扫描 `agent-library-registry.ts`；启用 = instantiate（`agent-library-instantiate.ts`，frontmatter `kind`/`model` 为建议运行时）。
- 内置快速开始库根：`apps/gateway/quickstart-library/`（rank 50）。

## 6. 聊天 / 执行相关

- 消息发送：`lib/use-chat-execution.ts`（唯一实现；新语境用 resolve* 选项注入，别绕过）。
- 工作流执行卡：`components/workflow-run-card.tsx`（live 模式轮询 node-spans）；改样式配套 `styles/workflow-run-card.css`。
- 判别"回复来自工作流"：消息 `metadata.source === 'workflow'`。
- 拒绝黄警：新增拒绝话术进 `lib/refusal-detect.ts`（保守优先，配单测）。

## 7. 提交与验证惯例

```bash
pnpm --filter @dagents/console typecheck   # 0 error 是底线
cd apps/console && npx vitest run          # 包级全量（避免全仓 turbo 触发 build）
bash restart-gateway.sh                    # 改了 gateway/engine 后重启验证
```
- 真机验证：Playwright 临时脚本（`node /tmp/xx.mjs`，从 `node_modules/.pnpm/playwright@1.61.1/...` 直接 import）+ 截图取证。
- 提交信息：中文、说清"为什么"，多行 body 列验证证据；按主题分笔提交（feat/fix/refactor/chore）。
