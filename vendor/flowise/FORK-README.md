# Flowise Fork

mil-agents 平台 fork 的 Flowise，直接改源码、暂不裁剪（决策 D1/D2/D15，见
`docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md`）。

## Remote

| 项 | 值 |
|---|---|
| 上游 (upstream) | https://github.com/FlowiseAI/Flowise |
| 我们的 fork (origin) | https://github.com/<OWNER>/Flowise ⚠️ 待创建后回填 |
| 版本 | 3.1.3 |
| 锁定 commit | `bb773ffa` (2026-07, "Fix Flowise 722 node load method workspace (#6593)") |
| 改动策略 | 直接改源码，暂不裁剪 |

## 升级流程

在 GitHub 上的独立 fork repo 操作，再同步回 `vendor/flowise`：

```bash
# 在 fork repo 内
git fetch upstream main
git merge upstream/main
# 解决冲突（重点关注 packages/server 执行引擎与 typeormDataSource.ts）
git push origin main

# 同步回 mil-agents monorepo：重新 cp 或 subtree pull 后核对 diff
```

> 风险：Flowise 大版本升级（如 V1→V2，[#4756](https://github.com/FlowiseAI/Flowise/issues/4756)）可能破坏集成。
> MVP 锁定 3.1.3 / `bb773ffa`，非必要不升级；升级须跑 Gate-2 集成测试。

## 待办（人工）

- [ ] 在 GitHub 手动 fork `FlowiseAI/Flowise` 到本组织账号（如 `mzw/Flowise`）
- [ ] fork 创建后，把上方 "我们的 fork" 的 `<OWNER>` 替换为真实 owner

## 注意（M0.3 执行时）

本目录已先存在 `FORK-README.md`。M0.3 的 `cp -a ~/Projects/Flowise vendor/flowise`
在目标目录已存在时会产生嵌套 `vendor/flowise/Flowise/`，应改为
`cp -a ~/Projects/Flowise/. vendor/flowise/`，或先把本文件暂存再复制后放回。
