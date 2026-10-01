# Agent 广场内置精选库

Agent 广场（`docs/agent-plaza.md`）的开箱内容：50 个精选人格 / 13 个分部。
**rank 900 兜底语义**——用户挂载的任何库（env / managed / `~/.agents/agent-library`）
同 id 条目自动覆盖内置副本，内置内容只在用户没有该人格时出现。

## 内容归属

全部文件原样拷贝自 [agency-agents](https://github.com/msitarzewski/agency-agents)
（"The Agency"，[MIT License](https://github.com/msitarzewski/agency-agents/blob/main/LICENSE)，
© msitarzewski）。源格式即本库格式（Markdown + YAML frontmatter `name/description` +
`color/emoji/vibe`），零转换拷贝。

## Curation 策略（docs/agent-plaza.md D3）

按优先级三层：

1. **团队模板成员全覆盖（33 个）**——9 个团队场景模板（`routes/agent-library-teams.ts`）
   引用的全部人格 name，内置后新装环境团队模板零 422。
2. **流程模板 personaName 覆盖（+2：Code Reviewer / Senior Developer / Software Architect）**
   ——内置流程模板（`flow-templates/builtin/*.json`）在新装环境自动升级为真 Agent 节点。
3. **dagents 定位高价值（+15）**——开发者本机工作流强相关：SRE、DevOps Automator、
   AI Engineer、RAG Pipeline Engineer、Prompt Engineer、Multi-Agent Systems Architect、
   微信小程序开发、Technical Writer、Codebase Archaeologist、MCP Builder、
   Agents Orchestrator、Product Manager、Penetration Tester、Application Security
   Engineer、Research Synthesist。

分部分布：engineering(14) / product(3) / testing(2) / design(3) / marketing(6) /
support(2) / paid-media(5) / project-management(3) / gis(5) / spatial-computing(1) /
specialized(3) / research(1) / security(2)。

## 维护

- **不自动跟进上游**：内容为冻结快照。升级 = 从 agency-agents 重拷对应文件 + 提交，
  并跑 `__tests__/agent-library.test.ts` 的内置库守卫组（条目数 / 分部 / 团队成员零缺失）。
- **上游 frontmatter name 变化**会同时改 library id（`<division>/<slug>`）与团队模板
  name 解析——重拷后必须跑测试确认 9 个团队模板成员仍全部可解析。
- 新增精选：拷文件 + 若引入新分部则同步 `divisions.json`。
- 完整库（282+）引导用户自行挂载：
  `git clone https://github.com/msitarzewski/agency-agents ~/.agents/agent-library`
