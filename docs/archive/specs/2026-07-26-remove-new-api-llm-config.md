# 移除 new-api 依赖，改为自定义 LLM Provider 配置

> **状态**: 设计中
> **日期**: 2026-07-26
> **替代文档**: `2026-07-25-system-architecture-redesign.md` §6.2 (token 管理) + §6.3 (LLM 代理)
> **相关计划**: 待生成

## 1. 背景与目标

### 1.1 现状

当前架构依赖 **new-api** (calciumion/new-api) 作为 LLM 网关，承担 4 个角色：

1. **LLM 代理中转** — `/api/v1/llm/*` 透传到 new-api 的 OpenAI 兼容接口
2. **Token 管理** — `/api/v1/tokens/*` 代理 new-api 的 token CRUD + 本地 `token_meta` 扩展
3. **健康探针** — probe worker 定期检查 token 状态
4. **配额/计费** — new-api 管理 token 配额、过期、分组

### 1.2 问题

- new-api 是一个额外的基础设施依赖（需要 Docker 运行）
- 对于"聊天支持自定义配置"的场景，new-api 的多用户/配额/分组功能过重
- 用户只需要配置自己的 OpenAI 兼容 API Key 即可使用聊天功能
- 增加了部署复杂度和维护成本

### 1.3 目标

- **移除 new-api 依赖**：不再需要运行 new-api 服务
- **自定义 LLM Provider**：用户在设置中配置 LLM 提供商（base URL + API Key + 模型名）
- **保持 OpenAI 兼容**：网关仍提供 `/api/v1/llm/*` OpenAI 兼容接口，但直接转发到用户配置的 provider
- **简化架构**：移除 probe worker、token 管理等 new-api 相关模块

## 2. 架构设计

### 2.1 变更总览

```
之前 (new-api 架构):
  Console → Gateway → new-api → LLM Provider (OpenAI/Anthropic/...)
              ↓
         token_meta (本地元数据)

之后 (自定义 LLM 配置):
  Console → Gateway → LLM Provider (用户配置的 OpenAI 兼容端点)
              ↓
         llm_providers (用户配置表)
```

### 2.2 核心变更

| 模块 | 变更前 | 变更后 |
|---|---|---|
| LLM 代理 | `/api/v1/llm/*` → new-api `/v1/*` | `/api/v1/llm/*` → 用户配置的 provider base URL |
| Token 管理 | `/api/v1/tokens/*` CRUD (代理 new-api) | `/api/v1/llm-providers/*` CRUD (本地表) |
| 健康探针 | probe worker (new-api token 状态) | 移除 (用户自行测试连接) |
| 配额管理 | new-api 管理配额/过期/分组 | 简化：仅启用/禁用 + 备注 |
| 数据存储 | `token_meta` 表 (关联 new-api token id) | `llm_providers` 表 (独立存储) |

### 2.3 数据模型

#### 新增表: `llm_providers`

```sql
CREATE TABLE llm_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directory_id  UUID,                    -- 所属目录，null = 全局
  name          TEXT NOT NULL,           -- 显示名称，如 "My OpenAI"
  provider_type TEXT NOT NULL DEFAULT 'openai_compatible',  -- openai_compatible (后续扩展 anthropic, gemini 等)
  base_url      TEXT NOT NULL,           -- API 基础 URL，如 https://api.openai.com/v1
  api_key       TEXT NOT NULL,           -- API Key (加密存储)
  default_model TEXT NOT NULL,           -- 默认模型名
  models        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 可用模型列表 (可选)
  status        TEXT NOT NULL DEFAULT 'active',  -- active / disabled
  remark        TEXT,                    -- 备注
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_providers_directory ON llm_providers (directory_id);
CREATE INDEX idx_llm_providers_status ON llm_providers (status);
```

**关于 API Key 加密**: 初期使用 base64 编码（避免明文存储），后续可升级为 AES 加密。
（说明：这是 dev 环境的简化方案，生产环境应使用 KMS。）

#### 废弃表: `token_meta`

- 不再使用，通过 migration DROP
- 数据不迁移（new-api token 配置与新的 llm_providers 语义不同）

### 2.4 API 设计

#### 2.4.1 LLM Provider CRUD (`/api/v1/llm-providers`)

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/llm-providers` | 列出所有 provider (不返回 api_key 明文) |
| `GET` | `/api/v1/llm-providers/:id` | 获取单个 provider 详情 |
| `POST` | `/api/v1/llm-providers` | 创建 provider |
| `PATCH` | `/api/v1/llm-providers/:id` | 更新 provider (name, base_url, api_key, default_model, models, status, remark) |
| `DELETE` | `/api/v1/llm-providers/:id` | 删除 provider |
| `POST` | `/api/v1/llm-providers/:id/test` | 测试连接 (调用 /v1/models 验证) |

**响应格式**: 统一 `{ success: boolean, data?: ..., error?: string }`

**Provider 列表响应** (不返回 api_key):
```json
{
  "success": true,
  "data": {
    "providers": [
      {
        "id": "uuid",
        "name": "My OpenAI",
        "providerType": "openai_compatible",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyMasked": "sk-...XXXX",
        "defaultModel": "gpt-4o",
        "models": ["gpt-4o", "gpt-4o-mini"],
        "status": "active",
        "remark": null,
        "createdAt": "...",
        "updatedAt": "..."
      }
    ]
  }
}
```

#### 2.4.2 LLM 代理 (`/api/v1/llm/*`)

保持现有路径不变，但行为变更：

- **请求头**：`X-LLM-Provider-Id` 指定使用哪个 provider
  - 未指定时使用目录的默认 provider（或第一个 active provider）
- **路径转发**：`/api/v1/llm/chat/completions` → `{base_url}/chat/completions`
- **认证注入**：用 provider 的 api_key 替换请求中的 Authorization
- **流式支持**：SSE 流式响应直接透传

```
请求流程:
  Browser → Gateway /api/v1/llm/chat/completions
            ↓ 查找 provider (X-LLM-Provider-Id 或默认)
            ↓ 注入 Authorization: Bearer {provider.api_key}
            ↓ 转发到 {provider.base_url}/chat/completions
            ← 响应透传 (支持 SSE stream)
```

#### 2.4.3 移除的 API

- `GET /api/v1/tokens` — 移除
- `POST /api/v1/tokens` — 移除
- `GET /api/v1/tokens/:id` — 移除
- `PATCH /api/v1/tokens/:id` — 移除
- `DELETE /api/v1/tokens/:id` — 移除
- `GET /api/v1/tokens/:id/health` — 移除（改为 provider test 接口）

### 2.5 前端变更

#### 设置页

- **"API Key 管理" tab** → 改为 **"LLM Provider 管理"** tab
- 列表展示 provider：名称 / Base URL / 默认模型 / 状态 / 操作
- 新建/编辑弹窗：
  - 名称 (必填)
  - Provider 类型 (下拉，当前仅 "OpenAI 兼容")
  - Base URL (必填，默认 `https://api.openai.com/v1`)
  - API Key (必填，掩码显示)
  - 默认模型 (必填)
  - 可用模型列表 (可选，逗号分隔)
  - 状态 (启用/禁用)
  - 备注
- "测试连接" 按钮
- 删除确认弹窗

#### Chat 页面

- 增加 Provider 选择器（在 composer 上方或设置中）
- 当前使用的 provider 显示在 UI 上
- 无 provider 时提示用户先去设置页配置

### 2.6 后端变更

#### 移除/替换的文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `apps/gateway/src/newapi.ts` | 删除 | new-api 客户端 |
| `apps/gateway/src/probe.ts` | 删除 | token 健康探针 |
| `apps/gateway/src/routes/tokens.ts` | 删除 | token CRUD 代理 |
| `apps/gateway/src/routes/llm.ts` | 重写 | 改为 provider 路由 + 动态转发 |
| `packages/db/src/entities/token-meta.ts` | 删除 | token_meta 实体 |
| `packages/db/src/migrations/1720000001000-create-token-meta.ts` | 保留 | 历史 migration，新增 DROP migration |

#### 新增文件

| 文件 | 说明 |
|---|---|
| `apps/gateway/src/routes/llm-providers.ts` | LLM Provider CRUD 路由 |
| `apps/gateway/src/llm-proxy.ts` | LLM 代理核心逻辑 (provider 解析 + 转发) |
| `packages/db/src/entities/llm-provider.entity.ts` | LLM Provider 实体 |
| `packages/db/src/migrations/1720000011000-create-llm-providers.ts` | 建表 migration |
| `packages/db/src/migrations/1720000012000-drop-token-meta.ts` | 删除 token_meta 表 |
| `apps/console/src/lib/llm-providers-client.ts` | 前端 API 客户端 |
| `apps/console/src/lib/llm-providers.ts` | 前端类型定义 |

### 2.7 配置变更

#### 移除的环境变量

- `NEWAPI_BASE_URL`
- `NEWAPI_ADMIN_KEY`
- `NEWAPI_ADMIN_USER_ID`
- `TOKEN_PROBE_INTERVAL_MS`

#### 新增的环境变量

- `LLM_PROVIDER_ENCRYPTION_KEY` — API Key 加密密钥 (可选，为空时用 base64)

### 2.8 docker-compose 变更

- 移除 `new-api` 服务
- 移除 `postgres-init` 中 `newapi` 数据库创建
- 保留 postgres / redis / minio / langfuse

## 3. 实施计划

### 阶段 1: 数据层 (实体 + migration)

- [ ] 创建 `llm_providers` 实体 + migration
- [ ] 创建 `DROP token_meta` migration
- [ ] 更新 `@dagents/db` index.ts 导出

### 阶段 2: 后端 API (Gateway)

- [ ] 实现 `/api/v1/llm-providers/*` CRUD 路由
- [ ] 重写 `/api/v1/llm/*` 代理 (从 new-api 转发改为 provider 转发)
- [ ] 实现 provider 测试连接接口
- [ ] 移除 newapi.ts / probe.ts / tokens.ts
- [ ] 更新 app.ts 路由挂载
- [ ] 编写单元测试

### 阶段 3: 前端 (Console)

- [ ] 创建 LLM Provider 类型定义 + API client
- [ ] 重写设置页 "API Key 管理" tab 为 "LLM Provider 管理"
- [ ] 新建/编辑弹窗
- [ ] 测试连接功能
- [ ] Chat 页面 provider 选择器
- [ ] 更新相关测试

### 阶段 4: 清理

- [ ] 移除 docker-compose 中的 new-api 服务
- [ ] 移除环境变量 (`.env.example`, `infra/.env.example`)
- [ ] 移除 new-api 相关文档
- [ ] 移除 `scripts/dev.sh` 中的 new-api 相关逻辑
- [ ] 更新 CLAUDE.md / 架构文档
- [ ] 全量测试通过

## 4. 后续扩展 (不在本期范围)

- 多 provider 自动路由 (按模型名匹配)
- 配额管理 / 使用量统计
- 更多 provider 类型 (Anthropic, Gemini, 通义千问, 等)
- API Key 加密 (AES-KMS)
- Provider 健康监控 / 自动故障转移
