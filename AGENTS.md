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
- LLM Provider CRUD + 动态代理转发

## 已知问题

- **旧 mil-agents 僵尸进程**：`mil-agents-main` 项目可能有残留 tsx watch 进程（PID 61329），不占端口但耗内存，定期清理。
- **remote 类型 Agent 需 Daemon 在线**：`auto` 路由已优先选择 CLI 类型 Agent（2026-08-15 修复）；库里残留的 remote Agent（如 "test"）手动选中时会收到引导性报错，建议清理或为其启动 Daemon。
- ~~openclaw agent 需 Node ≥22.22.3~~：已解决 — 系统 node 已升级至 v22.23.1，openclaw 2026.7.1 正常运行（2026-08-15 验证）。

## 配置

- 配置文件：`~/.hermes/config.yaml`（Hermes 网关）
- 环境变量：`infra/.env.example`（基础设施模板）
- 认证：无登录（本机模式）。Gateway 默认开放；如需对外暴露可设 `GATEWAY_API_KEY`（16+ 字符 bearer key）
