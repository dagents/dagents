# Dagents 产品 + 设计优化方案

> **日期**: 2026-08-09
> **角色**: 产品经理 + 设计师
> **评估基础**: 全量代码审查 + 用户旅程分析 + Trial Readiness Spec

---

## 一、核心诊断

### 1.1 产品定位

Dagents 是一个 **Chat-First 的异构 Coding Agent 编排平台**。核心叙事：
> 用户在对话框里输入指令 → 平台自动路由到 Agent/Flow/Daemon → 流式返回执行结果

### 1.2 当前阶段："Demo 可演，Trial 难用"

| 维度 | 现状 | 问题 |
|------|------|------|
| **首次引导** | 空状态只有"添加目录"按钮 | 用户不知道添加后该做什么，没有引导链 |
| **触发机制** | @flow/@daemon/@agent 已实现 | 但 UI 完全不暴露这些命令，用户无法发现 |
| **执行反馈** | WS 流式 token 已实现 | 缺少进度感知、耗时预估、错误恢复路径 |
| **成本透明** | token usage 已在消息底部 | 但没有汇总视图，用户不知道总共花了多少 |
| **信息架构** | 侧栏 3 个一级入口 (Agent/Flow/Daemon) | 三个概念对新人认知负担大，缺少解释层 |
| **Daemons** | 3 列布局完整 | 但 0 个 e2e 测试保护，且概念抽象 |

---

## 二、优化方案（按优先级排序）

### P0-A：Chat Composer 内置 @ 命令发现 ⭐核心

**问题**: @flow/@daemon/@agent 是核心卖点，但用户根本不知道它们存在。

**方案**: 在 Composer 输入框中实现 @ 触发的命令菜单（类 Slack/Discord）：
- 用户输入 `@` → 弹出命令选择器
- 显示可用命令 + 简要说明 + 快捷键提示
- 选择后自动填充模板（如 `@flow [flow-name] ` 并列出可用 flow）

**实现位置**: `chat-composer.tsx`

### P0-B：首日引导流（Onboarding Checklist）

**问题**: 新用户不知道下一步该做什么。

**方案**: 在 Chat Home 右侧或空状态中展示进度卡片：
```
✅ 1. 添加项目目录     [完成]
⬜ 2. 配置 LLM Provider  [前往设置]
⬜ 3. 启动 Daemon       [复制命令]
⬜ 4. 发起第一次对话     [开始]
```
完成时自动勾选，全完成时折叠为"✨ 全部就绪"。

### P0-C：全局执行状态指示器

**问题**: 用户发送消息后，除了流式文本外，缺少整体执行状态感知。

**方案**: 在 navbar 右侧添加一个全局状态灯：
- 🔘 灰色 = 空闲
- 🟢 脉冲 = 有任务运行中 (N)
- 🔴 = 有失败任务
点击 → 跳转到 Daemons 或展开运行列表面板

### P1-D：成本看板（Cost Dashboard）

**问题**: 消息级有 token/cost 但没有汇总。

**方案**: 在 Settings 或 Daemons 页面增加成本概览卡片：
- 今日总消耗 / 本周 / 本月
- 按 Agent 分组的花费 breakdown
- 简单的趋势 mini-chart

### P1-E：Chat Context Panel 增强

**问题**: 当前 context panel 有运行历史但没有运行参数可视化。

**方案**: 在 context panel 中增加：
- 当前 Agent 的小型 sparkline（近 10 次运行耗时）
- 最近一次运行的 node span 时间线（如果有 flow）

### P2-F：页面标题 + 文案统一

**问题**: 多处品牌名不一致（"DAgent Console"、"Dagents"、"DAgent 控制台"）。

**方案**: 全局统一为 **"Dagents"**，页面 title 统一。

---

## 三、实施计划

| Phase | 内容 | 影响面 |
|-------|------|--------|
| **Phase 1** | P0-A @命令菜单 + P0-B 引导清单 + P0-C 状态指示器 | Chat Composer, Chat Home, Chat Layout |
| **Phase 2** | P1-D 成本看板 + P1-E Context Panel + P2-F 文案统一 | Settings, Chat Detail |
