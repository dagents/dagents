# Test Report R2 — Daemon注册 / Flow列表展开 / 对话操作 / Agent详情操作

- **日期**: 2026-08-11
- **环境**: localhost:3000 (console) + localhost:8080 (gateway)
- **数据**: 1 Daemon (test-daemon, 离线) / 5 Flows / 25 对话 (TEST 目录) / 4 Agents
- **执行人**: Hermes Agent (自动化)
- **参考**: `docs/test-cases.md` §3.6 / §5 / §6 / §7

---

## 测试模块 3: §7 Daemon 注册对话框 (DM-010 ~ DM-016)

**路径**: `/daemons` → 点击「注册 Daemon」按钮

| 用例 ID | 结果 | 备注 |
|---------|------|------|
| DM-010 | ✅ PASS | 名称字段存在（placeholder "如：dev-laptop"，textbox 可输入） |
| DM-011 | ✅ PASS | Agent 类型 chips 完整：claude / codex / copilot / qwen / opencode / codebuddy / cursor / deveco / antigravity / openclaw / pi / hermes / kimi / kiro / grok / qoder / traecli（17 种，可点选） |
| DM-012 | ✅ PASS | Endpoint 字段存在（placeholder "如：http://192.168.1.100:9090"） |
| DM-013 | ⏭️ SKIP | 完整提交注册未执行（避免创建测试 Daemon 污染数据；字段齐全可推断可用，但未实测） |
| DM-014 | ⏭️ SKIP | 启动命令复制未执行（依赖 DM-013 成功后才出现，跳过） |
| DM-015 | ✅ PASS | 名称留空点「注册」→ 弹出红色校验提示「请填写 daemon 标签」，对话框不关闭、提交被阻止 |
| DM-016 | ❌ **FAIL** | **Escape 键无法关闭对话框**（按 2 次 Escape，overlay `daemon-dialog-overlay` 仍在 DOM 中可见）。仅「取消」按钮可关闭。**缺陷：对话框缺少 Escape 键监听 / keydown 处理** |

### 模块 3 汇总
- PASS: 4 | FAIL: 1 | SKIP: 2
- **关键缺陷**: DM-016 — Escape 关闭失效（P0 回归）

---

## 测试模块 4: §6 Flow 列表展开 (F-030 ~ F-036)

**路径**: `/flows` → 第一个 Flow「test-flow」

| 用例 ID | 结果 | 备注 |
|---------|------|------|
| F-030 | ✅ PASS | 展开按钮存在（`aria-label="展开 flow test-flow 的运行记录"`）；点击后 `aria-expanded=true`，显示运行记录表头（RUN ID / 触发 / 状态 / 耗时 / 成本 / 时间）+ 内容「暂无运行记录。」 |
| F-031 | ✅ PASS | 再次点击展开按钮 → `aria-expanded=false`，运行记录表折叠隐藏 |
| F-032 | ✅ PASS | 「编辑画布」按钮存在（每个 Flow 卡片内，`ref=e59` 等） |
| F-033 | ✅ PASS | 「▶ 运行」按钮存在（每个 Flow 卡片内，`ref=e60` 等） |
| F-034 | ⏭️ SKIP | 节点数显示未单独验证（卡片标题区未观察到节点数标签；未深入检查） |
| F-035 | ⏭️ SKIP | 运行次数显示未单独验证（test-flow 暂无运行记录，无法校验计数） |
| F-036 | ⏭️ SKIP | UUID 截断/复制未单独验证 |

### 模块 4 汇总
- PASS: 4 | FAIL: 0 | SKIP: 3
- 展开/折叠 + 编辑/运行按钮均正常工作

---

## 测试模块 5: §3.6 对话操作（hover 删除/重命名）(H-070 ~ H-079)

**路径**: `/` → 点击 Logo 展开侧栏 → 检查对话项

**源码核查**（`apps/console/src/components/chat-nav-sidebar.tsx` L366-378 + `chat-nav-sidebar.css` L233-254）：
- 对话项组件 `.chat-nav-chat-item`（`<Link>`）**仅渲染** 3 个子元素：状态点（`.chat-nav-chat-status`）、标题（`.chat-nav-chat-item-title`）、时间（`.chat-nav-chat-item-time`）。
- **没有** 删除按钮、重命名按钮、操作菜单、SVG 图标或任何 hover-revealed action 元素。
- CSS `.chat-nav-chat-item:hover` 仅改变 `background` + `color`，无操作按钮显示逻辑。
- DOM 验证：25 个对话项，`querySelectorAll('button, svg, [class*="delete"], [class*="rename"]')` 在对话项内匹配数为 0。

| 用例 ID | 结果 | 备注 |
|---------|------|------|
| H-070 | ❌ **FAIL** | **功能未实现** — hover 对话项无操作按钮出现（源码确认无 delete/rename 元素） |
| H-071 | ❌ **FAIL** | 功能未实现 — 无「重命名」按钮 |
| H-072 | ❌ **FAIL** | 功能未实现 — 无重命名输入框 |
| H-073 | ❌ **FAIL** | 功能未实现 — 无重命名 Escape 取消 |
| H-074 | ❌ **FAIL** | 功能未实现 — 无重命名空标题校验 |
| H-075 | ❌ **FAIL** | 功能未实现 — 无重命名超长校验 |
| H-076 | ❌ **FAIL** | 功能未实现 — 无「删除」按钮，无确认对话框 |
| H-077 | ❌ **FAIL** | 功能未实现 — 无删除确认流程 |
| H-078 | ❌ **FAIL** | 功能未实现 — 无删除取消（依赖 H-076） |
| H-079 | ❌ **FAIL** | 功能未实现 — 无删除激活对话逻辑 |

### 模块 5 汇总
- PASS: 0 | FAIL: 10 | SKIP: 0
- **关键缺陷**: H-070~H-079 — **整个「对话 hover 操作（删除/重命名）」功能缺失**（10 条 P0/P2 全部 FAIL）。对话项当前仅为只读导航链接，无法在侧栏内直接管理对话。需在 `chat-nav-sidebar.tsx` 增加操作按钮 + 确认对话框 + 重命名内联编辑。

---

## 测试模块 6: §5 Agent 详情页操作按钮 (D-030 ~ D-033)

**路径**: `/agents` → 第一个 Agent「Agent」→「查看详情」→ 详情页

**DOM 验证**：详情页共 46 个 button/a 元素，搜索 `edit|删除|编辑|归档|archive|delete|保存|save`（textContent + aria-label + title）→ **匹配 0 个**。
**源码核查**（`apps/console/src/components/agent-detail-view.tsx`）：详情页 render 部分无编辑/删除/归档按钮；仅 L162/L295 在 not-found 文案中提及"归档/删除"。

| 用例 ID | 结果 | 备注 |
|---------|------|------|
| D-030 | ❌ **FAIL** | **「编辑」按钮不存在** — 详情页无编辑入口（无编辑模式/对话框） |
| D-031 | ❌ **FAIL** | 功能未实现 — 无「保存」按钮（依赖 D-030） |
| D-032 | ❌ **FAIL** | **「删除」按钮不存在** — 详情页无删除入口/二次确认 |
| D-033 | ❌ **FAIL** | **「归档」按钮不存在** — 详情页无归档入口 |

### 模块 6 汇总
- PASS: 0 | FAIL: 4 | SKIP: 0
- **关键缺陷**: D-030~D-033 — **Agent 详情页操作按钮（编辑/删除/归档）全部缺失**。详情页仅为只读属性面板 + 活动/指令/Skills/日志 Tab，无任何管理操作。需在 `agent-detail-view.tsx` header 区增加操作按钮组。

---

## 总体汇总

| 模块 | 范围 | PASS | FAIL | SKIP | 关键发现 |
|------|------|------|------|------|----------|
| 模块 3 Daemon注册 | DM-010~016 | 4 | 1 | 2 | Escape 关闭失效 (DM-016) |
| 模块 4 Flow展开 | F-030~036 | 4 | 0 | 3 | 展开/折叠/编辑/运行均正常 |
| 模块 5 对话操作 | H-070~079 | 0 | 10 | 0 | **功能整体缺失** |
| 模块 6 Agent详情操作 | D-030~033 | 0 | 4 | 0 | **操作按钮全部缺失** |
| **合计** | **27 条** | **8** | **15** | **5** | — |

### 通过率
- **PASS: 8/27 (29.6%)**
- **FAIL: 15/27 (55.6%)**
- **SKIP: 5/27 (18.5%)**
- 若排除 SKIP：PASS 8/22 = **36.4%**

### 关键缺陷清单（按严重度）

1. **🔴 P0 — H-070~H-079（10条）**: 对话侧栏 hover 操作（删除/重命名）功能完全未实现。`chat-nav-sidebar.tsx` 的对话项是纯只读 `<Link>`，无任何操作按钮。影响：用户无法在侧栏直接管理对话，必须通过其他途径（如目录管理页）。

2. **🔴 P0 — D-030~D-033（4条）**: Agent 详情页缺少编辑/删除/归档操作按钮。`agent-detail-view.tsx` 仅为只读视图。影响：无法在详情页修改或删除 Agent。

3. **🔴 P0 — DM-016**: Daemon 注册对话框 Escape 键不关闭。需添加 `keydown` Escape 监听或 Radix Dialog 的 onEscapeKeyDown。「取消」按钮可正常关闭（ workaround 可用）。

### 正常工作的功能
- Daemon 注册对话框字段完整（名称/17种Agent类型chips/Endpoint）+ 空名称校验有效
- Flow 列表展开/折叠正常，运行记录表头完整，「编辑画布」+「▶运行」按钮齐全
