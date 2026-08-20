# 文档索引

> 文档地图：新来的读者从这里找到一切。维护规则见文末。

## 根目录指南

| 文档 | 读者 | 内容 |
|---|---|---|
| [`README.md`](../README.md) | 所有人 | 项目简介、安全须知（对外暴露必读）、架构、快速启动 |
| [`AGENTS.md`](../AGENTS.md) | AI agent / 开发者 | 一键重启脚本、常用命令、端口表、架构要点、已知问题、审计摘要 |
| [`CLAUDE.md`](../CLAUDE.md) | Claude Code | 架构分层、关键契约（contracts / daemon / adapters）、命令、提交与测试约定 |

## 主题文档（docs/ 顶层，随代码同步维护）

| 文档 | 内容 |
|---|---|
| [`workflow-engine.md`](workflow-engine.md) | 工作流引擎：执行模型（并行波次/条件路由/循环）、流式、人机协同、子流程、Langfuse、已知限制 |
| [`skills-registry.md`](skills-registry.md) | 技能运行时注册表：发现根/rank、API、Agent 挂载、system prompt 注入 |
| [`agent-library.md`](agent-library.md) | Agent 人格库（2026-08-19）：registry-not-database 挂载 agency-agents 类人格库、启用/drift 同步、团队场景模板、中文衍生目录 |
| [`flow-templates.md`](flow-templates.md) | 流程模板中心（2026-08-20）：内置/我的模板、画布「另存为模板」、personaName 重绑与 LLM 降级 |
| [`test-cases.md`](test-cases.md) | 测试用例目录 v2.0（331 条，2026-08-11）+ 执行态增量索引；历史测试报告在 `archive/testing/` |
| [`e2e-test-plan.md`](e2e-test-plan.md) | 执行态 e2e 测试计划：Mock LLM 地基、Tier A-D 分层、spec 11~17 执行记录 |

## 流程文档（docs/superpowers/）

- [`superpowers/specs/`](superpowers/specs/) — 活跃 spec。其中 **`2026-07-25-system-architecture-redesign.md` 是架构真相源**，顶部「实现状态总览」表反映当前进度。
- [`superpowers/plans/`](superpowers/plans/) — 活跃 plan（TDD 任务清单）。

新功能走 brainstorm → spec → plan → issue → execute 四阶段流水线，见 `CLAUDE.md`。

## 归档（docs/archive/，只读快照）

| 目录 | 内容 |
|---|---|
| `architecture/` | v0.1–v0.3 架构文档 + Gate-2 决策记录 |
| `design/` | 9 屏控制台原型 + Chat-First 原型 |
| `design-audit/` | v0.3 设计保真审计 |
| `plans/` | 已完成的 plans |
| `specs/` | 历史 specs |
| `verification/` | Gate-1/2、M0/M1/M2/M6.7 验证证据 |
| `testing/` | 历史测试报告（按日期归档） |

## 其他

- [`infra/README.md`](../infra/README.md) — 本地基础设施（Postgres :15432 + Langfuse :3001，v2 pin 原因）
- [`opensource-release-checklist.md`](opensource-release-checklist.md) — 开源发布操作手册（org 迁移 / 占位符替换 / 首个 Release / 发布渠道）
- `.claude/skills/dagents-patterns/` — 提交与文档约定（conventional commits 中文描述、spec/plan 命名）

仓库根目录的开源治理文件：`LICENSE`（Apache-2.0）· `CONTRIBUTING.md`（[中文版](../CONTRIBUTING.zh-CN.md)）· `CODE_OF_CONDUCT.md` · `SECURITY.md` · `CHANGELOG.md`。

## 维护规则

1. **历史 spec/plan/报告不修改内容**——它们是当时决策的快照；当前状态以架构真相源顶部状态表为准。
2. **命名**：`YYYY-MM-DD-<topic>-<kind>.md`（kind = design / analysis / implementation / compat / readiness）。
3. **测试报告按日期归档**到 `archive/testing/`，`test-cases.md` 作为活文档随用例增改更新。
4. 主题文档（workflow-engine / skills-registry）与代码同 PR 更新，不滞后。
