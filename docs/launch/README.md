# Launch Kit — dagents 发布材料包

> 背景：2026-09-04 诊断结论 —— 仓库公开 6 周，14 天访问量 29 次 / 3 个独立访客，
> 全网零提及。**不是质量问题，是零分发**。本目录把「让别人知道」这件事变成可执行的清单。

## 里面有什么

| 文件 | 用途 |
|---|---|
| [`checklist.md`](./checklist.md) | 发布前验证 + 发布日操作顺序（先读这个） |
| [`show-hn.md`](./show-hn.md) | Hacker News「Show HN」帖子（标题 + 正文，可直接粘贴） |
| [`reddit.md`](./reddit.md) | r/LocalLLaMA · r/selfhosted · r/ClaudeAI 三份帖子 |
| [`chinese.md`](./chinese.md) | V2EX「分享创造」+ 掘金/公众号短文 |
| [`awesome-lists.md`](./awesome-lists.md) | 目标 awesome 清单 + 每家的 PR 文案（直接可提） |

## 核心叙事（所有帖子共用的一句话）

**Dify/n8n 这类云编排要你的 API Key 和数据；Dagents 反过来 —— 你本机已装好的
claude/codex CLI 就是执行引擎，画布编排并行团队，零配置起步，数据不出机器。**

三个可复用的钩子：
1. **零配置就能跑** —— 不配任何 provider，流程照跑（CLI 兜底是架构层的第一性设计，不是兜底补丁）
2. **执行过程看得见** —— 节点徽章实时转、连线点亮、逐节点流式输出（README 的 GIF 就是这个）
3. **诚实清单** —— README 把「JS 节点非沙箱、daemon 任务暂不可取消」写在前头；HN 受众吃这套

## 发布节奏建议

```
第 0 天  合并素材 → commit + push（帖子里的图片/GIF 链接依赖仓库里的文件！）
第 1 天  Show HN（周二~周四，美西上午）→ 前 2 小时守评论
第 1-2 天 HN 结果出来后决定：上首页 → Reddit 当晚跟上；没上 → Reddit 照发（错峰）
第 2-3 天 V2EX「分享创造」+ 掘金
第 3 天+  awesome-list PR（长期长尾流量，与上面的发帖互不影响）
```

## 诚实例外说明

- README 首屏 GIF 为**真实本地 claude CLI 运行**录制（约 2 分钟压缩为 25 秒）；
  发帖时可以放心直说「真实运行录屏」。
- 不要刷 star（小号互点），GitHub 会降权，得不偿失。
