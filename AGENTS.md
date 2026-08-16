# Dagents — Agent Guide

## 一键重启

**当 gateway 或 console 无响应时，先跑这个：**

```bash
bash /Users/rowan/Projects/dagents/restart-gateway.sh
```

此脚本会同时重启 gateway (8080) 和 console (3000)：
- 杀干净所有相关进程（多层进程链 + esbuild）
- 等端口释放
- 后台 `nohup` 启动
- 健康检查（`/health` + HTTP 200）
- 日志输出到 `/tmp/dagents-gateway.log` 和 `/tmp/dagents-console.log`

## 常用命令

```bash
# 单独重启 gateway
pnpm --filter @dagents/gateway dev

# 单独重启 console
pnpm --filter @dagents/console dev

# 单独重启 daemon
pnpm --filter @dagents/daemon dev -- http://localhost:8080 dev-laptop claude

# 基础设施 (Postgres + Langfuse)
cd infra && docker compose up -d

# 测试 / 构建
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # tsup → dist/
```

## 端口

| 服务 | 端口 |
|---|---|
| Gateway (Hono) | 8080 |
| Console (Next.js) | 3000 |
| Postgres | 15432 → 5432 |
| Langfuse | 3001 |

## 架构要点

```
console (Next) → gateway (Hono) → @dagents/workflow engine
   → [dispatch routes inline] → local daemon → claude/codex CLI
```

- Chat-First UX：聊天主页 `/` + 聊天详情 `/chats/{id}`
- `inline-executor` 是默认执行路径（不需要 daemon）
- Workflow 画布编辑器：`/workflows/[id]/canvas`（vendor/agentflow/）
- Workflow 引擎文档：`docs/workflow-engine.md`（架构 / 执行模型 / Langfuse 开启方式 / 已知限制）
- LLM Provider CRUD + 动态代理转发

## 已知问题

- **旧 mil-agents 僵尸进程**：`mil-agents-main` 项目可能有残留 tsx watch 进程（PID 61329），不占端口但耗内存，定期清理。
- **remote 类型 Agent 需 Daemon 在线**：`auto` 路由已优先选择 CLI 类型 Agent（2026-08-15 修复）；库里残留的 remote Agent（如 "test"）手动选中时会收到引导性报错，建议清理或为其启动 Daemon。
- ~~openclaw agent 需 Node ≥22.22.3~~：已解决 — 系统 node 已升级至 v22.23.1，openclaw 2026.7.1 正常运行（2026-08-15 验证）。

## 2026-08-16 审计修复（摘要）

全库审计后修复的主要问题（详见当次会话）：

- **安全**：llm 代理 SSRF（绝对 URL 劫持 + 密钥外泄）已封堵；`/internal` 与 dispatch 非 daemon-protocol 路由纳入 `GATEWAY_API_KEY` 门禁；dispatch 任务生命周期路由校验认领 daemon 的 token；WS 升级在 key 模式下校验 token + Origin、非 `/ws` 升级请求显式拒绝；HTTP 节点加 scheme 白名单/15s 超时/32KB 截断；pi 适配器 resumeSessionId 约束到会话目录。
- **引擎**：画布 `data.inputs` 配置归一化（此前画布 flow 全部按空配置跑）；锚点 handle 路由修复（普通数据节点的下游不再被静默跳过，画布 Condition 数字/Else 锚点映射 true/false）；DirectReply/CustomFunction 字段名对齐；workflow LLM client 改用 AES-GCM 解密（此前开加密必 401）；Iteration 100 项上限；HumanInput/ExecuteFlow 无注入时显式报错。
- **适配器**：codex 重写为 `codex exec --json` + 真实事件流（旧版双幻觉）；openclaw 支持多行 JSON blob + 纯文本错误行判失败（实测 openclaw 失败时退出码是 0）；codebuddy 去掉自相矛盾的 `--input-format`；copilot 加自主 flag；gemini 模板移除（无适配器，建了也跑不了）。**注意：codex/codebuddy/copilot/qwen 本机未安装，修复基于官方文档格式，未经真实 CLI 回归。**
- **前端**：daemon 删除死按钮接通代理；Daemons「日志」改为真实 task events；Settings 五个假数据 tab 标注「未接入」；onboarding 条件对齐 inline 架构；AgentSelector 快速创建 bug 修复；Flows 假筛选/假运行记录移除；cost/load 标注估算。
- **基础设施**：`@dagents/db` 构建产物现在包含 entities/migrations（此前 dist 下 `runMigrations()` 静默 no-op）；audit 测试不再回退 CHECK 约束（dev 库已同步修复）；daemon 401/403 触发重注册（此前只听 404 永不触发）、注册失败 exit 1；空壳 e2e 包已删除。

仍存在的已知取舍见 `docs/workflow-engine.md` 的「现状与限制」（LLM fetch 无超时、Agent 节点无工具循环、new Function 非沙箱、adapter 无取消路径等）。

## 配置

- 配置文件：`~/.hermes/config.yaml`（Hermes 网关）
- 环境变量：`infra/.env.example`（基础设施模板）
- 认证：无登录（本机模式）。Gateway 默认开放；如需对外暴露可设 `GATEWAY_API_KEY`（16+ 字符 bearer key）
