# 中文渠道帖（V2EX / 掘金 / 公众号）

## 1. V2EX「分享创造」节点

**标题：** `[分享创造] Dagents：把本机的 Claude Code / Codex CLI 编排成并行团队的开源画布`

**正文：**

大家好，分享一个做了六周的开源项目 Dagents —— 一个自托管的 Workflow 工作台，
把本机已装好的 CLI coding agent（claude / codex / qwen，共 17 个适配器）
编排成可视化 DAG 工作流。

起因很简单：每个 CLI agent 都是孤岛。Claude Code 有自己的多 agent 模式，
Codex 有自己的；而 Dify / n8n / Flowise 这类云编排默认你要交出 API Key、
跑在它们的后端上。我想要反过来：**我的 agent、我的机器、我的 Postgres，
什么都不外传。**

几个特性：

- **CLI 第一性**：没配任何 LLM provider 也能跑 —— 本地 claude CLI 就是执行引擎；
  配了 OpenAI 兼容端点（本地 vLLM/LM Studio 也行）则自动走快路径
- **看得见的执行**：画布上节点徽章实时翻转、连线点亮、逐节点流式输出正文，
  每次运行都有旁观直链可以事后回看
- **聊天副驾**：`@workflow 一句话` 直接编译成多 agent 流程；`@某agent` 带人格派活
- **人格库**：文件系统挂载 agency-agents 类人格库（270+ 专家人格），按需启用、
  git 同步上游；九个团队场景模板一键生成多人格流程（产品发现、落地页冲刺、
  全机构并行发现……）
- **本地优先**：默认只绑 127.0.0.1，无账号无遥测，API Key AES-256-GCM 加密落库，
  中英双语界面

技术栈：TypeScript monorepo（Next.js console + Hono gateway + 自研 DAG 引擎），
画布 vendor 自 Flowise（Apache-2.0，纯前端），Apache-2.0 开源，CI 里跑 547 个
e2e 用例（Mock LLM 地基）。

首页有 17 秒演示 GIF（三路并行分析 → 汇总；录屏用了脚本化 provider 控制节奏，
引擎/画布/流式都是真实应用）。

仓库：https://github.com/dagents/dagents
Docker 三行起步：`git clone ... && docker compose pull dagents && docker compose up`

诚实清单（README 里也写着）：JS 节点非沙箱（flow 作者 = 机器所有者）、远程 daemon
任务暂不可取消、Retriever 是关键词检索不是向量 RAG。

想听 V2EX 朋友们两个反馈：①「不配 key 也能跑」这个钩子对你们重要吗，还是实际
用起来一定是配 provider 的？②人格库挂文件系统而不是塞数据库，你们觉得顺手吗？

---

## 2. 掘金 / 公众号（短版，适配算法分发）

**标题备选：**
- 《我开源了一个「编排 Claude Code 和 Codex」的画布：零 API Key 起步，数据不出本机》
- 《别再开五个终端跑 Claude Code 了 —— 我写了个 DAG 画布编排它们》

**正文骨架：**

1. 开头放 GIF（掘金支持 GitHub 图床外链，直接贴仓库 README 链接）
2. 痛点段：CLI agent 是孤岛；云编排要你的 key 和数据（80 字）
3. 三张动图/截图讲三个特性：画布并行运行、逐节点流式、聊天 @workflow 编译
4. 快速上手：docker compose 三行（贴终端输出截图更有说服力）
5. 诚实清单 + 技术栈一段（掘金受众吃工程细节：monorepo 结构、e2e 547 用例、
   vendor 声明）
6. 结尾求 star + 求反馈 + 仓库链接

**标签建议：** `开源` `AI Agent` `Claude Code` `工作流引擎` `效率工具`

---

## 发帖备注

- V2EX 分享创造节点规则：需要一定注册时长与活跃度，纯新号发不了；发帖后认真回复
- 掘金可以先发「小册式」深度文（比如《给 Claude Code 做一个编排引擎的六周》），项目帖藏文内，比硬广存活率高
- 公众号/即刻可以更口语化，核心钩子不变：**你的 CLI 就是引擎，数据不出机器**
- 中文社区对「诚实清单」同样买账 —— 别删这节
