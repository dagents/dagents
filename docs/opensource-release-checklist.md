# 开源发布检查清单（Phase 4）

> 2026-08-20 开源改造（feat/opensource-prep）已完成 Phase 0~3。本清单是公开发布日的
> 操作手册 —— 其中多数动作涉及仓库归属与对外可见性，需维护者亲自执行。
> 背景与完整计划见 Ob-wiki `concepts/dagents-opensource-plan.md`。

## A. 仓库与归属（已拍板：新建独立 org）

- [ ] **创建独立 GitHub org**（建议先在 GitHub 搜索 `dagents` 查重；若重名可用
      `dagents-ai` / `dagents-dev` / `usedagents` 等），org 名避免与现有项目冲突
- [ ] **迁移仓库**：GitHub Settings → Transfer ownership 到新 org（保留 star/issue/
      历史），或新 org 建仓后 push 全部分支与 tag
- [ ] **可见性切 public** 前最后跑一遍 `git grep -n "TODO(oss)"` 确认占位符已清

## B. 占位符替换（org 定名后全局替换 `<owner>`）

- [ ] `README.md` / `README.zh-CN.md`：clone URL + 取消注释 CI badge（当前注释中指向
      sendwealth，需改新 org）
- [ ] `CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`：clone URL + Discussions 链接
- [ ] `.github/ISSUE_TEMPLATE/config.yml`：两个链接
- [ ] `CHANGELOG.md`：底部两个 compare 链接

## C. 仓库配置（GitHub 网页操作）

- [ ] **Topics**：`ai-agents` `workflow-orchestration` `claude-code` `cli-agents`
      `multi-agent` `hono` `nextjs` `typescript` `self-hosted` `local-first`
- [ ] **开启 Discussions**（Q&A + Ideas 分类）
- [ ] **开启 Private vulnerability reporting**（Settings → Code security）
      —— `SECURITY.md` 已承诺此渠道
- [ ] 社交预览图（OG image，1280×640）：架构图或 canvas 截图 + slogan
- [ ]（可选）Branch protection：main 要求 CI 通过
- [ ]（可选）CODEOWNERS：有第二个维护者后再加

## D. 首个 Release

- [ ] 确认 `CHANGELOG.md` [0.1.0] 内容完整、日期正确
- [ ] `git tag v0.1.0 && git push origin v0.1.0` → release.yml 自动构建
      多架构镜像（amd64 + arm64 原生 runner）推 GHCR + 创建 GitHub Release
- [ ] 验证 GHCR 包可见性为 public（否则镜像拉取需登录）
- [ ] 在 `docker-compose.yml` 的 dagents 服务加 `image: ghcr.io/dagents/dagents:latest`
      与 `build: .` 并存（本地无镜像时自动构建），README 补镜像拉取说明

## E. 发布叙事与渠道

- [ ] 截图/GIF：聊天主页 @workflow 生成、画布编辑、人格库启用（README 后补
      「产品感 > 文字描述」）
- [ ] 渠道（可用 agent-reach skill 分发）：Show HN、r/LocalLLaMA、r/selfhosted、
      V2EX、即刻；叙事主打「不绑厂商的 CLI agent 编排 + 270+ 人格库生态 +
      诚实限制清单」
- [ ] issue 响应承诺已写入 SECURITY.md（7 个工作日）——上线后遵守

## F. 上线后渐进增强（非阻塞）

- [ ] Dependabot 已配置（月度 + 分组）；考虑迁移 Renovate（pnpm monorepo
      workspace 分组更好）
- [ ] Stale bot / labeler（GitHub 原生即可）
- [ ] AI issue triage / 评论翻译（LobeChat 式，有人气后再上）
- [ ] npm 拆包发布（`@dagents/workflow` 等）——有独立用户需求再启动
