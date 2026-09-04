# 发布前检查清单

## A. 素材与链接（发帖前必须全绿）

- [ ] `docs/assets/canvas-demo.gif` 已 commit + push 到 GitHub（帖子链接指向 raw.githubusercontent 或仓库 README）
- [ ] README 双语在 GitHub 网页端渲染正常（GIF 能动、截图不裂）—— 用无痕窗口打开 https://github.com/dagents/dagents 验证
- [ ] GitHub 仓库 description / topics 已更新（见下方命令）
- [ ] `docker compose up` 从干净克隆跑通一次（帖子必被点进去试装，装不起来 = 差评 + 取消 star）
  ```bash
  git clone https://github.com/dagents/dagents.git /tmp/dagents-verify && cd /tmp/dagents-verify
  docker compose pull dagents && docker compose up -d
  # 打开 http://localhost:3000 冒烟：新建空流程 → 加一个 LLM 节点 → 运行
  ```

## B. 仓库元数据（已备好命令，直接执行）

```bash
gh repo edit dagents/dagents \
  --description "Orchestrate local CLI coding agents (claude, codex, qwen) into parallel teams — visual DAG canvas, workflow-first, local-first, self-hosted."
gh repo edit dagents/dagents --add-topic agent-orchestration --add-topic autonomous-agents --add-topic workflow-automation
```

## C. 发布日操作

1. **Show HN**（内容见 `show-hn.md`）
   - 时间：周二~周四，美西 6:00–9:00 AM（HN 流量峰前）
   - 标题 = `Show HN: Dagents – ...`（Show HN 规则：正文首段自述，不回复顶自己帖）
   - **前 2 小时在线回复每一条评论**——Show HN 的存亡在评论区
2. **Reddit**（内容见 `reddit.md`，各 sub 规则不同，先读版规再发）
   - r/LocalLLaMA 允许文本帖带链接；r/selfhosted 要 flair；r/ClaudeAI 注意自我推广比例（历史里不能只有推广）
   - HN 若上首页，Reddit 当晚错峰跟（同一 GIF、不同标题与开头，避免判重复内容）
3. **V2EX**「分享创造」节点 + 掘金（内容见 `chinese.md`）
4. **awesome-lists PR**（内容见 `awesome-lists.md`，随时可提，不依赖发帖日）

## D. 发帖后的动作

- [ ] 每条帖子的评论区当天清零（未回复 = 流量漏斗漏水）
- [ ] 有 issue/PR 进来：24h 内首响，哪怕只是「收到，周末看」
- [ ] star 不涨也别删帖改发——同一内容多平台反复发会被判 spam；换钩子换平台，不换内容重发
- [ ] 一周后复盘：GitHub traffic API（`gh api repos/dagents/dagents/traffic/views`）对比 3 UV 基线
