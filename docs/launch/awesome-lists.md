# Awesome 清单提交计划（长尾流量主通道）

> 2026-09-04 搜索验证：搜「CLI agent orchestration」出来的第一个社区清单就是
> awesome-agent-orchestrators —— 目标受众的必经之路，而 dagents 不在其中。

## 目标清单（按命中率排序）

### 1. andyrewlee/awesome-agent-orchestrators —— 直接命中，最高优先级

- 仓库：https://github.com/andyrewlee/awesome-agent-orchestrators
- 形态：先 fork → 编辑 → PR（先看该文件近期合并的条目格式，照抄结构）
- PR 标题建议：`Add Dagents — local-first CLI agent orchestration canvas`
- 条目文案（按清单现有格式调整缩进/图标）：

```markdown
- [Dagents](https://github.com/dagents/dagents) — Self-hosted, local-first workbench that orchestrates CLI coding agents (claude/codex/qwen + 14 adapters) on a visual DAG canvas. CLI agents are the baseline engine — zero API keys to start; per-node streaming and spectator links for every run.
```

### 2. awesome-claude-code 类清单（受众：Claude Code 重度用户）

搜 `awesome-claude-code` 取 star 最高且仍在维护的一到两个（注意最近一次合并日期，
死清单不投）。条目放在「GUI / orchestration / multi-agent」分区（没有就开新分区）：

```markdown
- [Dagents](https://github.com/dagents/dagents) — Open-source canvas for running multiple Claude Code instances in parallel with DAG workflows, live streaming and a persona library. Self-hosted, works with your existing `claude` CLI.
```

### 3. awesome-ai-agents（e2e-scripts/awesome-ai-agents 或同名的维护中版本）

框架/平台分区，一句话条目：

```markdown
- [Dagents](https://github.com/dagents/dagents) - Local-first orchestration platform for CLI coding agents; visual DAG canvas, streaming runs, self-hosted. (TypeScript)
```

### 4. awesome-selfhosted（要求严格，可选）

要求：必须有完整 README、license、截图、明确安装方式、活跃维护 —— dagents 基本满足，
但该清单偏好「终端用户可长期运行的服务」。若被拒不纠结，优先级最低。
条目归 `Automation` 分区，按其 CONTRIBUTING 格式（含 license/website/demos 字段）提交。

## PR 操作备注

- 一个 PR 只加一个条目，commit message：`Add Dagents to <section>`
- PR 描述里贴 README 首屏 GIF 的 raw 链接，维护者扫一眼就懂
- 同一清单近 30 天没合并任何 PR = 半死，跳过换下一个
- 被要求改动就快速改；被拒问原因（对下一个清单有用）
- 提交记录保持个人账号（gh CLI 已登录的就是），不要用小号
