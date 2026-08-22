# 开源发布检查清单（Phase 4）

> 2026-08-20 开源改造（feat/opensource-prep）已完成 Phase 0~3。本清单是公开发布日的
> 操作手册 —— 其中多数动作涉及仓库归属与对外可见性，需维护者亲自执行。
> 背景与完整计划见 Ob-wiki `concepts/dagents-opensource-plan.md`。

## A. 仓库与归属（已拍板：新建独立 org）

- [x] **创建独立 GitHub org** —— `dagents`（2026-08-22）
- [x] **迁移仓库**：经 API `POST /repos/<个人账户>/dagents/transfer` transfer 到 org
      （保留 Actions 历史；旧地址自动重定向）
- [x] **可见性切 public** 前 `git grep -n "TODO(oss)"` 已确认占位符清零

## B. 占位符替换（org 定名后全局替换 `<owner>`）

- [x] `README.md` / `README.zh-CN.md`：clone URL + CI badge 已启用（指向 dagents org）
- [x] `CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`：clone URL + Discussions 链接
- [x] `.github/ISSUE_TEMPLATE/config.yml`：两个链接
- [x] `CHANGELOG.md`：底部两个 compare 链接（0.1.0 日期对齐 2026-08-22）

## C. 仓库配置（GitHub 网页操作）

- [x] **Topics**：10 个已设置
- [x] **开启 Discussions**（默认分类已含 Q&A + Ideas）
- [x] **开启 Private vulnerability reporting**（API `PUT .../private-vulnerability-reporting`）
- [x] 社交预览图（OG image，1280×640）：`docs/assets/social-preview.png` 已生成入库
      —— **GitHub 无该设置的上传 API，需网页手动上传**（Settings → General → Social preview）
- [x] （可选）Branch protection：main 禁 force-push/删除，PR 必须过
      `build • typecheck • lint • test` + `analyze (js/ts)`；playwright e2e 不设为
      required（其 PR 触发带路径过滤，docs-only PR 不产生该 check 会永久卡住）
- [ ] （可选）CODEOWNERS：有第二个维护者后再加

## D. 首个 Release

- [x] 确认 `CHANGELOG.md` [0.1.0] 内容完整、日期正确（2026-08-22）
- [x] `git tag v0.1.0 && git push origin v0.1.0` → release.yml 自动构建
      多架构镜像（amd64 + arm64 原生 runner）推 GHCR + 创建 GitHub Release
- [x] 验证 GHCR 包可见性为 public（否则镜像拉取需登录）
- [x] 在 `docker-compose.yml` 的 dagents 服务加 `image: ghcr.io/dagents/dagents:latest`
      与 `build: .` 并存（本地无镜像时自动构建），README 补镜像拉取说明

## E. 发布叙事与渠道

- [ ] 截图/GIF：聊天主页 @workflow 生成、画布编辑、人格库启用（README 后补
      「产品感 > 文字描述」）
- [ ] 渠道（可用 agent-reach skill 分发）：Show HN、r/LocalLLaMA、r/selfhosted、
      V2EX、即刻；叙事主打「不绑厂商的 CLI agent 编排 + 270+ 人格库生态 +
      诚实限制清单」
- [x] issue 响应承诺已写入 SECURITY.md（7 个工作日）——上线后遵守

## F. 上线后渐进增强（非阻塞）

- [x] Dependabot 已配置（月度 + 分组）；考虑迁移 Renovate（pnpm monorepo
      workspace 分组更好）
- [ ] Stale bot / labeler（GitHub 原生即可）
- [ ] AI issue triage / 评论翻译（LobeChat 式，有人气后再上）
- [ ] npm 拆包发布（`@dagents/workflow` 等）——有独立用户需求再启动

## G. 发布日执行记录（2026-08-22）

发布过程中发现并修复的 CI/镜像 bug（此前均未被 CI 覆盖到——docker 镜像构建
无任何工作流验证，是本次最大的盲区）：

1. **Dockerfile builder 只 COPY 根 manifest**：pnpm install 时各 workspace 包
   目录为空 → 只装根依赖 → turbo 构建时各包 devDeps（tsup）缺失秒挂。修复：
   install 前补齐全部 9 个 workspace 成员的 package.json。
2. **base 镜像 node:20-slim 与 engines ≥22 不符** → 统一 node:22-slim。
3. **runtime 缺 tsconfig**：typeorm-ts-node-esm 按 CJS 默认值编译
   data-source.ts，`import.meta` 报 TS1470 → runtime 补拷 tsconfig.base.json
   + packages/db/tsconfig.json（module: NodeNext）。
4. **console 无 public/ 目录**：runtime `COPY .../console/public` 必挂 → 补
   `apps/console/public/.gitkeep`。
5. **entrypoint `wait -n` 是 bashism**：dash 直接 `Illegal option -n`，容器起
   来即死 → shebang 换 bash（node:*-slim 自带 bash 5.2）。
6. **ci.yml `--filter='!@dagents/e2e'` 指向已删包**：turbo 2.10 对不存在的
   排除目标直接报错，任何触源 PR 的 Test 步骤必红 → 移除过滤器。
7. **Dependabot PR 的受限 token 问题**：ci.yml 补 `pull-requests: read`
   （paths-filter）、codeql.yml 补 `actions: read`（读 workflow run）。

镜像修复后本地端到端冒烟验证通过：迁移 → gateway `/health` db:up →
console HTTP 200。教训：**给 Docker build 也配一条 CI 路径**（至少
`docker build --target builder`），否则镜像只在发 tag 时才第一次被构建。
