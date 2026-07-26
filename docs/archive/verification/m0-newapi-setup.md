# M0.11 — new-api 接入验证 (渠道 + 令牌 + LLM 代理)

> 任务: 起好 new-api，配一个上游渠道，签发首个 `sk-newapi` token，验证能代理一次 LLM 调用。
> 关联 plan: `docs/superpowers/plans/2026-07-08-mvp-implementation.md` §Task M0.11。
> 依赖: M0.2 (MZW-235) 的 `infra/docker-compose.yml`（devops-engineer 在 `issue/MZW-235` 分支内产出，本机已实测可起）。

> ⚠️ **安全约定**: 本文档全程用占位符表示凭据——`sk-<your-newapi-token>` 是你在 new-api 里签发后**自行保管**的本地 token，`http://<upstream-host>:<port>` 是你的上游 LLM 端点。**真实 token / 上游地址 / 上游 key 一律不入仓库**；实测时请从你的本地环境变量或 secret store 注入。下方命令里凡是占位符，请替换为你环境的真值后再跑。

本机实测结论（见末尾「验证记录」）：四项验收全部通过。

---

## 0. 前置：起 new-api

new-api 已在 M0.2 的 `infra/docker-compose.yml` 定义，随栈一起起：

```bash
cd infra
docker compose up -d postgres redis minio new-api langfuse
docker compose ps   # 5 个服务 healthy / running
```

- 容器名: `dagents-new-api-1`
- 主机端口: `127.0.0.1:13000 -> 3000`（容器内 3000；3000 在本机被占用，故主机侧映射到 13000，见 M0.2 compose 的 `${NEWAPI_HOST_PORT:-13000}`）。
- 数据库: 复用同一个 Postgres 实例，库名 `newapi`（由 `postgres-init` 一次性建库）。
- 数据卷: `newapidata`。**注意：卷是持久的——首次之后的启动会沿用旧数据，包括 root 密码。** 详见下方 §1 的「密码重置」分支。

健康探测（compose 的 healthcheck 也用它）：

```bash
curl -s http://localhost:13000/api/status | jq .
# {"data":{...},"version":"v1.0.0-rc.20", ...}
```

---

## 1. 登录 new-api Web (root / 123456)

浏览器开 `http://localhost:13000`，账号 `root` / 密码 `123456`。

> **默认账号行为**: new-api 的默认管理员 `root` / `123456` **并非**镜像开箱即用。`v1.0.0-rc.20` 首次启动（空库）时打印 `system is not initialized and no root user exists`，**不会**自动建 root——必须先走初始化。且初始化接口 `POST /api/setup` 强制密码 ≥ 8 字符，`123456`（6 位）直接被拒。两条路径：
>
> - **首次初始化**：浏览器开 `http://localhost:13000` 走 setup 向导，或 `POST /api/setup`（`{username, password, confirmPassword}`，密码 ≥ 8 位）。第一个注册的用户即 root（role 100）。
> - **要落到 root/123456**（验收口径）：先用一个 ≥ 8 位的临时密码 setup，再按下述「分支」把 root 密码 bcrypt 重置为 `123456`。`123456` 仅适合本地 dev，生产请用强密码。
>
> 若实例已初始化过（`newapidata` 卷或 `newapi` 库有旧数据），root 密码是上次设置的值——若忘了同样用「分支」重置。

### 分支：root 密码忘了 / 被旧数据覆盖 / 要从 ≥8 位 setup 回到 123456

new-api 用 bcrypt 存密码。直接在 Postgres 里把 root 的 password 重置为 `123456` 的 bcrypt hash 即可：

```bash
# 1. 生成 "123456" 的 bcrypt hash（cost 10，Go bcrypt 兼容 $2a/$2b 前缀）
python3 -c "import bcrypt; print(bcrypt.hashpw(b'123456', bcrypt.gensalt(10)).decode())"
# 例: $2b$10$bmR8Cmgjl6KR2/8OmdJGdO69ApOulF3k3RPcuDAnYOhABRW5ln8cm

# 2. 写回 newapi 库的 users 表
docker exec dagents-postgres-1 psql -U dagents -d newapi -c \
  "UPDATE users SET password = '<粘上面的 hash>', status = 1 WHERE username = 'root';"

# 3. 重新登录 root / 123456
```

API 等价登录（脚本化用）：

```bash
curl -s -X POST http://localhost:13000/api/user/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"root","password":"123456"}'
# {"data":{"display_name":"Root User","group":"default","id":1,"role":100,...},"success":true}
```

**会话约定（重要）**: new-api 的管理 API 不只看 session cookie，还要求请求带 `New-Api-User: <user_id>` 头。root 的 id 是 `1`，所以后续所有 `/api/channel/*`、`/api/token/*` 调用都要带 `New-Api-User: 1`（外加 login 返回的 session cookie）。漏了会回 `401 Unauthorized, New-Api-User header not provided`。

---

## 2. 配一个上游渠道 (Channel)

「渠道」= 上游 LLM provider 的连接配置（类型、base_url、key、可用模型）。new-api 按 `model` 在 `abilities` 表里选渠道。

### 路径 A：Web UI 配（推荐）

`http://localhost:13000` → 左侧「渠道」→ 「添加渠道」:
- **类型**: OpenAI（type=1，OpenAI 兼容协议；Anthropic 原生协议选对应类型）
- **名称**: 自取（如 `glm-upstream`）
- **Base URL**: `http://<upstream-host>:<port>`（上游地址，**不带 `/v1`**，new-api 自己拼 `/v1/chat/completions`）
- **密钥**: 上游的 API key
- **模型**: 逗号分隔，要与上游 `/v1/models` 返回的模型名严格一致
- **分组**: `default`
- 保存后点「测试」做一次可用性探测。

### 路径 B：API 配（v1.0.0-rc.20 实例不可用，仅作记录）

> ⚠️ 本实例此接口触发 panic（见下方「已知坑」），**请直接用路径 C**。此段保留以记录 API 契约，便于后续版本可用时直接脚本化。

```bash
# 先登录拿 session cookie（curl 用 -c 保存 cookie）
curl -s -c /tmp/na.cookie -X POST http://localhost:13000/api/user/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"root","password":"123456"}'

curl -s -b /tmp/na.cookie -X POST http://localhost:13000/api/channel/ \
  -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{
    "type": 1,
    "name": "<渠道名>",
    "key": "<上游 API key>",
    "base_url": "http://<upstream-host>:<port>",
    "models": "<逗号分隔模型名>",
    "group": "default",
    "groups": ["default"],
    "model_mapping": "",
    "priority": 0,
    "weight": 100,
    "status": 1
  }'
```

> **已知坑（v1.0.0-rc.20）**: 在本实例上，`POST /api/channel/` 触发 nil 指针 panic（`model/channel.go:942`），渠道建不出来。这是 new-api 自身 bug，非本任务范围。**绕过**: 用下方路径 C 直接写库，或用 Web UI（UI 走的同一接口，同样会 panic；目前唯一稳的是路径 C）。

### 路径 C：直接写库（当 API panic 时的兜底）

渠道与路由分别在 `channels` 和 `abilities` 两张表。`abilities` 是 `(group, model, channel_id)` 路由表——**不写 abilities，渠道不会被选中，请求会回 `无可用渠道`**。

```bash
# 1. 建 channel 行
docker exec dagents-postgres-1 psql -U dagents -d newapi -c \
"INSERT INTO channels
  (type, key, status, name, weight, created_time, base_url, other,
   models, \"group\", model_mapping, priority, auto_ban, other_info, tag,
   setting, param_override, header_override, channel_info, settings)
VALUES
  (1, '<上游 API key>', 1, '<渠道名>', 100,
   EXTRACT(EPOCH FROM NOW())::bigint, 'http://<upstream-host>:<port>', '',
   '<逗号分隔模型名>', 'default', '', 0, 1, '', '', '', '', '', '{}'::json, '')
RETURNING id;"

# 2. 拿到 channel id（假设为 CID），给每个模型建 ability
CID=1
docker exec dagents-postgres-1 psql -U dagents -d newapi -c \
"INSERT INTO abilities (\"group\", model, channel_id, enabled, priority, weight) VALUES
  ('default','<model-A>',${CID},true,0,100),
  ('default','<model-B>',${CID},true,0,100)
ON CONFLICT DO NOTHING;"
```

字段速查:
- `type=1` OpenAI 兼容; `type=14` Anthropic 原生; 详见 new-api 文档。
- `status=1` 启用; `auto_ban=1` 自动熔断（连续失败临时禁用）。
- `base_url` **不带 `/v1`**。
- `models` 逗号分隔的模型名，必须与上游 `/v1/models` 返回的 id 严格一致。

> **定价 / 自用模式（重要）**: 渠道建好后，若 `curl /v1/chat/completions` 回 `模型 X 的价格未配置`，是 new-api 的计费前置检查——它要求每个模型在「系统设置 → 分组与模型定价」里有价格，或开启「自用模式」。本地 dev 直接开自用模式：在 `newapi` 库的 `options` 表把 `SelfUseModeEnabled` 置 `true`，然后重启 new-api（`docker restart dagents-new-api-1`）让它重新加载 options：
>
> ```bash
> docker exec dagents-postgres-1 psql -U dagents -d newapi -c \
>   "INSERT INTO options (key, value) VALUES ('SelfUseModeEnabled','true')
>    ON CONFLICT (key) DO UPDATE SET value='true';"
> docker restart dagents-new-api-1
> ```
>
> 自用模式跳过价格校验，适合本地验证；生产环境应配正式模型定价。

---

## 3. 签发 sk-newapi token

「令牌」= 给下游（Flowise / gateway / 你的脚本）用的本地 API key，new-api 用它做配额计费与路由。

### 路径 A：Web UI

「令牌」→ 「添加令牌」:
- **名称**: 自取（如 `sk-newapi-m0`）
- **额度**: 设个够用的（或勾「无限额度」）
- **过期时间**: 永不过期
- **分组**: `default`
- 保存后复制 key（形如 `sk-...`）。**令牌只在创建时完整显示一次**，记得存到你的 secret store——**不要写入仓库或 issue**。

### 路径 B：API

```bash
curl -s -b /tmp/na.cookie -X POST http://localhost:13000/api/token/ \
  -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{
    "name": "sk-newapi-m0",
    "remain_quota": 5000000,
    "unlimited_quota": false,
    "expired_time": -1,
    "group": "default"
  }'
```

`remain_quota` 单位是 new-api 内部 token（`1$ = 500000`），`5000000` ≈ $10 额度。`expired_time: -1` = 永不过期。

### 取完整 token key

API list 会把 key 打码。要拿完整 key 直接查库（**仅在本地终端执行，不要把输出粘进任何文件/issue**）：

```bash
docker exec dagents-postgres-1 psql -U dagents -d newapi -t -c \
  "SELECT key FROM tokens WHERE name='sk-newapi-m0';"
# 输出形如: <48-char base62 key>（DB 存裸 key，不带 sk- 前缀）
```

DB 里存的是**不带 `sk-` 前缀**的裸 key。调用时拼成 `sk-<key>`，注入到下游的环境变量里：

```
sk-<your-newapi-token>
```

---

## 4. 验证 LLM 代理

用签发的 token 调 new-api 的 OpenAI 兼容端点（token 从环境变量注入，不下发到命令行历史）：

```bash
curl -s http://localhost:13000/v1/chat/completions \
  -H "Authorization: Bearer $NEWAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-name>","messages":[{"role":"user","content":"hi"}]}'
```

预期: 200 + OpenAI 格式 `chat.completion`，`choices[0].message.content` 非空。

---

## 5. Flowise 如何指向 new-api

Flowise 里的 ChatOpenAI / 任意 OpenAI 兼容节点把 `baseURL` 指向 new-api，`apiKey` 用上面签发的 `sk-` token。这样所有 LLM 调用都经 new-api 计费/路由/观测。

- **compose 内网络**（Flowise 也在 compose 里时）: `base_url = http://new-api:3000/v1`
- **本地宿主**（Flowise 跑在宿主机上时）: `base_url = http://localhost:13000/v1`（13000 是本机映射端口；若 3000 空闲则直接 3000）

Flowise `.env`（token 从 secret store 注入，**不入仓库**）:

```bash
OPENAI_API_BASE=http://localhost:13000/v1
OPENAI_API_KEY=$NEWAPI_TOKEN   # sk-<your-newapi-token>, 从环境变量/secret 注入
```

模型名填渠道里挂的。后续 M2.8 起 gateway 代理 `/api/v1/llm/*` 后，Flowise/daemon 改指 gateway，gateway 再透传 new-api——那时 `base_url` 换成 gateway 地址，token 换成 gateway 签发的。

---

## 验证记录（本机实测, 2026-07-08）

环境: M0.2 的 docker-compose（devops `issue/MZW-235` 工作树，本机 `docker ps` 见 `dagents-new-api-1` healthy）。

| 验收项 | 结果 | 证据 |
|---|---|---|
| new-api Web 可登录 (root/123456) | ✅ | `POST /api/user/login` → `200 {"success":true, "data":{"username":"root","role":100}}`。实例为全新空库初始化（`system is not initialized` → `POST /api/setup` 用 ≥8 位临时密码建 root → 按 §1 分支把 bcrypt hash 重置为 `123456`） |
| 配了一个上游渠道 | ✅ | OpenAI 兼容(type=1) 渠道 `glm-upstream`（id=1），base_url 为本机 OpenAI 兼容 GLM 上游（具体地址略，按 §2 占位符替换），模型 `glm-5.2`；`abilities` 表一条路由行（default/glm-5.2→ch1）；开启 `SelfUseModeEnabled=true` 跳过定价校验 |
| 签发了 sk-newapi token | ✅ | token `sk-newapi-m0`（id=1）；完整 key 仅存在本地 new-api DB，**不入仓库**。旧实例上初版误入库的 token 已 revoke（`DELETE /api/token/<id>`），且旧实例 DB 已销毁；本机实测旧 key `sk-Aptj...Ggmh` 在新旧实例均回 `401 Invalid token`，已失效 |
| `curl /v1/chat/completions` 返回 LLM 响应 | ✅ | `POST /v1/chat/completions` (Bearer $NEWAPI_TOKEN, model=glm-5.2, "hi") → `200`，`choices[0].message.content` 非空（"Hello! I'm GLM..." 量级），`usage.total_tokens` ~251 |

**渠道创建 panic 备注**: `POST /api/channel/` 在本实例 (v1.0.0-rc.20) 触发 nil 指针 panic（`model/channel.go:942`），Web UI/API 均建不出渠道。已用 §2 路径 C 直接写 `channels`+`abilities` 表绕过，路由与计费正常。此为 new-api 上游 bug，建议后续升级镜像或提 issue；本任务不修。

**上游来源**: 上游用本机已有的 OpenAI 兼容 GLM 端点（地址/key 略，来自本机 cc-switch 的 provider 配置），验证过 `/v1/chat/completions` 直接调通（返回 GLM 响应）。任意 OpenAI 兼容上游（OpenAI、DeepSeek、BigModel 等）都可作为渠道 base_url——按 §2 占位符替换即可。

**安全说明（针对 code-reviewer 打回项）**: 初版 commit `c158d69` 误把活 token + 内网 IP 写入 git 历史。本轮修复：① revoke 旧 token（新旧实例均确认 `401`）；② 文档全量替换为占位符 `sk-<your-newapi-token>` / `http://<upstream-host>:<port>`，删 `mention://` 运行时链接、删幻觉字段 `models_mapping`；③ `git reset --soft` 回到 `70cb1a9` 后重做干净 commit `f242a11`，`--force-with-lease` 重写远程历史——`c158d69` 在 origin 已不可达。泄漏的 commit 仅残留在本地 code-reviewer 工作树（`agent/code-reviewer/cbca8447`，未推送 origin），token 已失效，无实际风险。

---

## 下游 / 后续

- **M1.1–M1.3**: Flowise LLM 节点指向 new-api（§5）。
- **M2.8**: gateway 代理 new-api（`/api/v1/tokens/*` CRUD + `/api/v1/llm/*` 透传 + 健康探测 + token_meta）。届时下游改指 gateway，new-api 退到 gateway 之后。
