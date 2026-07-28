# Flowise 迁移期数据兼容承诺

> **日期**: 2026-07-28
> **状态**: Active
> **关联**: `docs/superpowers/plans/2026-07-27-flowise-migration-v2-workflow.md`

## 兼容窗口期定义

从 2026-07-27（Plan A 完成）到 Plan C 完成（`vendor/flowise/` 删除）之间为"兼容窗口期"。期间新 `flows` 表与旧 Flowise `chatflows` 表并存。

## 用户承诺

1. **数据保留**: 用户在 Flowise 中创建的所有 chatflows 不会被删除。
2. **迁移路径**: Plan C 提供一次性 migration 脚本，把 `chatflows.flowData` 导入 `flows.flow_data`（形状一致，ReactFlow 兼容）。
3. **API 兼容**: 旧 `/api/v1/flows/*` / `/api/v1/chatflows/*` proxy 路由在 Plan C 完成前保留。新代码应使用 `/api/v1/workflows/*`。
4. **执行引擎**: Plan A 已完成 `@dagents/workflow` 引擎；Plan B/C 完成前，部分节点（Start/LLM/Agent）仍走 Flowise prediction 路径。Plan C 完成后所有执行走 `@dagents/workflow`。

## 迁移完成判据

- [ ] `vendor/flowise/` 目录从仓库删除
- [ ] gateway 不再有任何 Flowise proxy 路由
- [ ] `FLOWISE_URL` / `FLOWISE_API_KEY` 环境变量从所有 .env.example 移除
- [ ] E2E UC-WF-01~12 全部 active（当前 0/12）
- [ ] 一次性 migration 脚本已执行并归档

## 用户行动指引

- **兼容窗口期内**: 优先在 `/workflows` 新页面编辑 flow；旧 `/flows` 页面仍可用。
- **Plan C 完成后**: 旧 `/flows` 路由重定向到 `/workflows`；用户无需手动迁移。

## 回滚预案

若 Plan C 出现重大问题，可回滚到兼容窗口期状态：
- 保留 `vendor/flowise/` 不删除
- 恢复 gateway Flowise proxy 路由
- 已迁移的 `flows` 表数据保留，不影响新功能使用
