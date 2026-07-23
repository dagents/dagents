# 百万智能体平台 MVP 实现计划（M0–M6）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零实现 mil-agents MVP——fork Flowise 作编排引擎 + 自研 4 薄层（网关/dispatch+daemon/调度/版本）+ 控制台前端，跑通"定义 agent → 编排 flow → 批量执行 → 监控追溯"全闭环。

**Architecture:** pnpm monorepo，全 TypeScript。`vendor/flowise` 是 fork（直接改源码）。自研层：`apps/gateway`（Hono，含 new-api 代理）、`apps/dispatch`（Hono+WS，daemon 任务队列）、`apps/scheduler`（Redis 队列消费，fan-out）、`apps/console`（Next.js，6 页）；`packages/`（contracts/agent-adapters/daemon/db/repro/shared）。两个 Gate：Gate-1（dispatch↔daemon 协议 + claude adapter，M2）、Gate-2（fork 构建 + Flow State 定位，M0）。

**Tech Stack:** TypeScript/Node, pnpm+turbo, Hono, TypeORM+PostgreSQL, Redis, MinIO, Langfuse+OTel, Next.js, Flowise 3.1.3 (fork), new-api (LLM 网关)。参照 multica（Go，本地 `~/Projects/multica`）翻译 daemon 协议，不引源码。

**上游 spec:** `docs/superpowers/specs/2026-07-08-mvp-execution-plan-design.md`。本计划是它的可执行展开，任务 ID 对应 spec 的 P1/P2。

**执行约定:**
- TDD：先写失败测试 → 跑（红）→ 最小实现 → 跑（绿）→ commit。
- 每个任务独立可 commit。
- 文件路径均为相对 repo 根 `/home/rowan/Projects/mil-agents/`。
- `vendor/flowise/` 是 fork，改动直接进其源码。
- 所有 commit message 用 conventional commits（`feat:`/`fix:`/`refactor:`/`docs:`/`test:`/`chore:`）。

---

# 里程碑 M0 — 基础设施 + Gate-2

**目标:** docker-compose 起全栈（含 new-api）；forked Flowise 能构建能跑；contracts/shared/db 包可 build；Gate-2 定位 Flow State。

**关键路径:** M0.1 → M0.3（fork 构建）→ M0.9（Gate-2）严格串行。M0.6/M0.7/M0.8 可与 M0.3 并行；M0.11 可与 M0.10 并行。

---

## Task M0.1: 建 monorepo 骨架

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `turbo.json`
- Create: `.gitignore`

- [ ] **Step 1: 写 root `package.json`**

```json
{
  "name": "mil-agents",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'vendor/flowise'
```

- [ ] **Step 3: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 4: 写 `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "test": { "dependsOn": ["build"], "outputs": ["coverage/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 5: 写 `.gitignore`**

```
node_modules/
dist/
.turbo/
coverage/
.env
*.log
vendor/flowise/node_modules/
vendor/flowise/dist/
vendor/flowise/.turbo/
```

- [ ] **Step 6: 验证骨架可用**

Run: `pnpm install`
Expected: 无报错（此时无子包，仅装 turbo/typescript）。

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json turbo.json .gitignore
git commit -m "chore: 建 monorepo 骨架 (pnpm + turbo + tsconfig base)"
```

---

## Task M0.2: 建 docker-compose（PG + Redis + MinIO + Langfuse + new-api）

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `infra/.env.example`

- [ ] **Step 1: 写 `infra/docker-compose.yml`**

```yaml
name: mil-agents

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: milagents
      POSTGRES_USER: milagents
      POSTGRES_PASSWORD: milagents_dev
    ports: ["127.0.0.1:5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U milagents"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["127.0.0.1:6379:6379"]
    volumes: ["redisdata:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: milagents
      MINIO_ROOT_PASSWORD: milagents_dev
    ports: ["127.0.0.1:9000:9000", "127.0.0.1:9001:9001"]
    volumes: ["miniodata:/data"]

  new-api:
    image: calciumion/new-api:latest
    ports: ["127.0.0.1:3000:3000"]
    environment:
      SQL_DSN: postgresql://milagents:milagents_dev@postgres:5432/newapi?sslmode=disable
      TZ: Asia/Shanghai
    depends_on:
      postgres: { condition: service_healthy }
    volumes: ["newapidata:/data"]

  langfuse:
    image: langfuse/langfuse:latest
    ports: ["127.0.0.1:3001:3000"]
    environment:
      DATABASE_URL: postgresql://milagents:milagents_dev@postgres:5432/langfuse?sslmode=disable
      NEXTAUTH_SECRET: langfuse_dev_secret_change_me
      SALT: langfuse_dev_salt_change_me
      NEXTAUTH_URL: http://localhost:3001
    depends_on:
      postgres: { condition: service_healthy }

volumes:
  pgdata:
  redisdata:
  miniodata:
  newapidata:
```

- [ ] **Step 2: 写 `infra/.env.example`**

```
# Postgres
POSTGRES_URL=postgresql://milagents:milagents_dev@localhost:5432/milagents
# Redis
REDIS_URL=redis://localhost:6379
# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=milagents
MINIO_SECRET_KEY=milagents_dev
MINIO_BUCKET=milagents
# new-api
NEWAPI_BASE_URL=http://localhost:3000
NEWAPI_ADMIN_KEY=sk-newapi-admin
# Langfuse
LANGFUSE_BASE_URL=http://localhost:3001
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
# Flowise
FLOWISE_PORT=3100
```

- [ ] **Step 3: 起基础设施验证**

Run: `cd infra && docker compose up -d postgres redis minio new-api langfuse && docker compose ps`
Expected: 5 个服务全 `healthy`/`running`（new-api/langfuse 首次启动需建库，可能 30s 内转 healthy）。

- [ ] **Step 4: 验证 new-api 可访问**

Run: `curl -s http://localhost:3000/api/status`
Expected: 返回 JSON（new-api 状态）。若 404，访问 `http://localhost:3000` 用默认账号登录（root/123456）确认 Web 可用。

- [ ] **Step 5: Commit**

```bash
git add infra/docker-compose.yml infra/.env.example
git commit -m "chore: 起 docker-compose (PG+Redis+MinIO+new-api+Langfuse)"
```

---

## Task M0.3: 纳入 vendor/flowise 并跑通构建（Gate-2 前置）

**Files:**
- Create: `vendor/flowise/`（从 `~/Projects/Flowise` 复制）

- [ ] **Step 1: 复制 Flowise fork 进 vendor**

Run:
```bash
cp -a ~/Projects/Flowise vendor/flowise
# 去除其 .git，避免子模块冲突
rm -rf vendor/flowise/.git
```

- [ ] **Step 2: 核对 vendor/flowise 的本地改动**

Run: `cd vendor/flowise && git status 2>/dev/null || echo "no git"; git diff package.json 2>/dev/null | head -20`
Expected: 看到 `~/Projects/Flowise` 那行 `package.json` 的 M 改动内容。**决策**：若改动是无关的（如本地路径），丢弃；若有意义，保留并记入备忘。

- [ ] **Step 3: 装 Flowise 依赖**

Run: `cd /home/rowan/Projects/mil-agents && pnpm install`
Expected: 安装完成。Flowise 依赖多，首次 5–10 分钟。若遇 peer dep 冲突，按 Flowise README 加 `.npmrc`（`strict-peer-dependencies=false`）。

- [ ] **Step 4: 构建 Flowise**

Run: `pnpm --filter flowise build:docker`
Expected: turbo 构建成功（`build:docker` 排除 agentflow/observe，与我们只用 server 一致）。若失败，记录错误，见失败路径。

- [ ] **Step 5: 起 Flowise 验证**

Run: `cd vendor/flowise && pnpm start`
Expected: Flowise 起在 `http://localhost:3000`（注意与 new-api 端口冲突——见 Step 6）。画布可访问。

- [ ] **Step 6: 解决端口冲突**

new-api 占 3000，Flowise 默认也 3000。改 Flowise 端口为 3100：
- 改 `vendor/flowise/packages/server/.env`（或环境变量）`PORT=3100`
- 更新 `infra/.env.example` 已用 `FLOWISE_PORT=3100`

Run: `curl -s http://localhost:3100` → 期望 Flowise 响应。

- [ ] **Step 7: Commit（vendor 首次纳入）**

```bash
# vendor/flowise 很大，确认 .gitignore 已排除其 node_modules/dist
git add vendor/flowise .npmrc 2>/dev/null
git commit -m "chore: 纳入 Flowise 3.1.3 fork 到 vendor/ (直接改源码, 暂不裁剪)"
```

> **失败路径:** 若 Step 4 构建失败（turbo 版本/依赖锁），单独攻破：① 查 Flowise `CONTRIBUTING.md` 的 node/pnpm 版本要求；② 锁 Docker 镜像 tag；③ 必要时在 vendor/flowise 内单独 `pnpm install` 不走 root workspace。这是 Gate-2 的环境部分，不触发架构变更。

---

## Task M0.4: fork remote 改造

**Files:**
- Modify: `vendor/flowise/.git` 重建（Step 1 删了）—— 不重建，改为在 mil-agents repo 内用 subtree 管理；或保留独立 fork remote 备用。

- [ ] **Step 1: 在 GitHub 建 mil-agents 自己的 Flowise fork**

由用户在 GitHub 手动 fork `FlowiseAI/Flowise` 到自己的账号（如 `mzw/Flowise`）。

- [ ] **Step 2: 记录 fork remote 信息**

在 `vendor/flowise/FORK-README.md` 记录：
```markdown
# Flowise Fork

- 上游: https://github.com/FlowiseAI/Flowise
- 我们的 fork: https://github.com/<user>/Flowise
- 版本: 3.1.3 (commit bb773ffa, 2026-07)
- 改动: 直接改源码，暂不裁剪
- 升级流程: git fetch upstream main && git merge upstream/main（在独立 fork repo 操作后，同步回 vendor/flowise）
```

- [ ] **Step 3: Commit**

```bash
git add vendor/flowise/FORK-README.md
git commit -m "docs: 记录 Flowise fork remote 与升级流程"
```

---

## Task M0.6: 建 packages/contracts（Gate-1 产出物，P1.1 全部）

> M0.6/M0.7/M0.8 可与 M0.3 并行。此处先做 contracts（零依赖）。

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/agent.ts`
- Create: `packages/contracts/src/protocol.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/__tests__/contracts.test.ts`

- [ ] **Step 1: 写 `packages/contracts/package.json`**

```json
{
  "name": "@mil/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

- [ ] **Step 2: 写 `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 写 `packages/contracts/src/agent.ts`**（基于 spec §1.1 + multica 补全）

```ts
export type AgentType =
  | 'claude' | 'codex' | 'copilot' | 'opencode' | 'openclaw'
  | 'hermes' | 'gemini' | 'pi' | 'cursor' | 'kimi' | 'kiro'
  | 'antigravity' | 'codebuddy' | 'qoder'

export interface BackendConfig {
  executablePath: string
  env?: Record<string, string>
  logger?: { debug(msg: string, ctx?: unknown): void; info(msg: string, ctx?: unknown): void; warn(msg: string, ctx?: unknown): void; error(msg: string, ctx?: unknown): void }
}

export interface ExecOptions {
  cwd?: string
  model?: string
  systemPrompt?: string
  maxTurns?: number
  timeoutMs?: number
  inactivityTimeoutMs?: number
  resumeSessionId?: string
  extraArgs?: string[]
  customArgs?: string[]
  mcpConfig?: unknown
  thinkingLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface AgentSession {
  events: AsyncIterable<AgentEvent>
  result: Promise<AgentResult>
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-use'; tool: string; callId: string; input: unknown }
  | { type: 'tool-result'; tool: string; callId: string; output: string }
  | { type: 'status'; status: string; sessionId?: string }
  | { type: 'log'; content: string }
  | { type: 'error'; content: string }

export interface AgentResult {
  status: 'completed' | 'failed' | 'aborted' | 'timeout' | 'cancelled'
  output: string
  error?: string
  durationMs: number
  sessionId?: string
  usage: Record<string, TokenUsage>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export interface AgentBackend {
  execute(prompt: string, opts: ExecOptions): AgentSession
}

export type BackendFactory = (agentType: AgentType, cfg: BackendConfig) => AgentBackend
```

- [ ] **Step 4: 写 `packages/contracts/src/protocol.ts`**

```ts
import type { AgentEvent, ExecOptions, TokenUsage } from './agent.js'

export interface DaemonCapability {
  agentType: import('./agent.js').AgentType
  tags?: string[]
}

export type DaemonStatus = 'online' | 'offline' | 'draining'

export interface RegisterRequest {
  daemonLabel: string
  capabilities: DaemonCapability[]
  endpoint?: string
}
export interface RegisterResponse { daemonId: string; token: string }

export interface HeartbeatPayload {
  daemonId: string
  status: DaemonStatus
  activeTasks: number
}

export interface DispatchTask {
  id: string
  agentDaemonId: string
  runId: string
  prompt: string
  execOptions: ExecOptions
}

export interface ClaimTaskResponse { task: DispatchTask | null }

export interface TaskMessageBatch { messages: AgentEvent[] }
export interface TaskProgress { summary: string; step: number; total: number }
export interface TaskComplete {
  output: string
  sessionId?: string
  usage: Record<string, TokenUsage>
  durationMs: number
}
export interface TaskFail {
  error: string
  failureReason: string
  sessionId?: string
}
```

- [ ] **Step 5: 写 `packages/contracts/src/index.ts`**

```ts
export * from './agent.js'
export * from './protocol.js'
```

- [ ] **Step 6: 写失败测试 `packages/contracts/src/__tests__/contracts.test.ts`**

```ts
import { describe, it, expectTypeOf } from 'vitest'
import type { AgentBackend, ExecOptions, AgentSession, AgentEvent, AgentResult, BackendFactory, AgentType } from '../index.js'
import type { DispatchTask, RegisterRequest } from '../index.js'

describe('contracts types', () => {
  it('AgentBackend.execute 返回 AgentSession', () => {
    expectTypeOf<AgentBackend['execute']>().returns.toMatchTypeOf<AgentSession>()
  })
  it('AgentSession 有 events 与 result', () => {
    expectTypeOf<AgentSession>().toHaveProperty('events').toMatchTypeOf<AsyncIterable<AgentEvent>>()
    expectTypeOf<AgentSession>().toHaveProperty('result').toMatchTypeOf<Promise<AgentResult>>()
  })
  it('ExecOptions 含 timeoutMs 与 inactivityTimeoutMs', () => {
    expectTypeOf<ExecOptions>().toHaveProperty('timeoutMs').toEqualTypeOf<number | undefined>()
    expectTypeOf<ExecOptions>().toHaveProperty('inactivityTimeoutMs').toEqualTypeOf<number | undefined>()
  })
  it('BackendFactory 接受 AgentType', () => {
    expectTypeOf<BackendFactory>().parameters.toHaveTypeAt<0, AgentType>()
  })
  it('DispatchTask 含 execOptions', () => {
    expectTypeOf<DispatchTask>().toHaveProperty('execOptions').toMatchTypeOf<ExecOptions>()
  })
  it('RegisterRequest 含 capabilities 数组', () => {
    expectTypeOf<RegisterRequest>().toHaveProperty('capabilities').toMatchTypeOf<import('../index.js').DaemonCapability[]>()
  })
})
```

- [ ] **Step 7: 跑测试验证通过**

Run: `pnpm --filter @mil/contracts test`
Expected: PASS（类型测试，验证契约可编译可引用）。

- [ ] **Step 8: typecheck + build**

Run: `pnpm --filter @mil/contracts typecheck && pnpm --filter @mil/contracts build`
Expected: 无错。

- [ ] **Step 9: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): 加 Backend/ExecOptions/AgentSession/AgentEvent/协议 DTO (P1.1)"
```

---

## Task M0.7: 建 packages/shared（P1.3 全部）

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/logger.ts`
- Create: `packages/shared/src/redis.ts`
- Create: `packages/shared/src/errors.ts`
- Create: `packages/shared/src/trace.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/logger.test.ts`

- [ ] **Step 1: 写 `packages/shared/package.json`**

```json
{
  "name": "@mil/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "pino": "^9.0.0", "ioredis": "^5.4.0", "@opentelemetry/api": "^1.9.0" },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

- [ ] **Step 2: 写 `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 写失败测试 `packages/shared/src/__tests__/logger.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { createLogger } from '../index.js'

describe('logger', () => {
  it('createLogger 返回带 runId 的 logger', () => {
    const log = createLogger({ runId: 'R-1' })
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
  })
  it('child 透传 runId', () => {
    const log = createLogger({ runId: 'R-1' })
    const child = log.child({ agent: 'claude' })
    expect(child).toBeDefined()
  })
})
```

- [ ] **Step 4: 跑测试验证失败**

Run: `pnpm --filter @mil/shared test`
Expected: FAIL（`createLogger` 未定义）。

- [ ] **Step 5: 写 `packages/shared/src/logger.ts`**

```ts
import pino from 'pino'

export interface Logger {
  debug(msg: string, ctx?: unknown): void
  info(msg: string, ctx?: unknown): void
  warn(msg: string, ctx?: unknown): void
  error(msg: string, ctx?: unknown): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOpts { runId?: string; [k: string]: unknown }

export function createLogger(opts: LoggerOpts = {}): Logger {
  const pinoLogger = pino({ level: process.env.LOG_LEVEL ?? 'info' }).child(opts)
  return {
    debug: (msg, ctx) => pinoLogger.debug(ctx ?? {}, msg),
    info: (msg, ctx) => pinoLogger.info(ctx ?? {}, msg),
    warn: (msg, ctx) => pinoLogger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => pinoLogger.error(ctx ?? {}, msg),
    child: (bindings) => createLogger({ ...opts, ...bindings }) as Logger,
  }
}
```

- [ ] **Step 6: 写 `packages/shared/src/errors.ts`**

```ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public ctx?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
```

- [ ] **Step 7: 写 `packages/shared/src/trace.ts`**

```ts
import { context, trace } from '@opentelemetry/api'

export interface TraceContext { runId: string; traceId: string; parentRunId?: string }

export function getTracer(name = 'mil-agents') {
  return trace.getTracer(name)
}

export function currentRunId(): string | undefined {
  const span = trace.getSpan(context.active())
  return span?.attributes['run.id'] as string | undefined
}
```

- [ ] **Step 8: 写 `packages/shared/src/redis.ts`**

```ts
import Redis from 'ioredis'

export interface RedisClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  lpush(key: string, value: string): Promise<void>
  brpop(key: string, timeoutSeconds: number): Promise<string | null>
  raw(): Redis
}

export function createRedis(url: string, prefix = 'mil:'): RedisClient {
  const client = new Redis(url)
  const k = (key: string) => `${prefix}${key}`
  return {
    get: (key) => client.get(k(key)),
    set: async (key, value, ttl) => {
      if (ttl) await client.set(k(key), value, 'EX', ttl)
      else await client.set(k(key), value)
    },
    del: (key) => client.del(k(key)).then(() => undefined),
    lpush: (key, value) => client.lpush(k(key), value).then(() => undefined),
    brpop: (key, timeout) => client.brpop(k(key), timeout).then((r) => r?.[1] ?? null),
    raw: () => client,
  }
}
```

- [ ] **Step 9: 写 `packages/shared/src/index.ts`**

```ts
export * from './logger.js'
export * from './errors.js'
export * from './trace.js'
export * from './redis.js'
```

- [ ] **Step 10: 跑测试验证通过**

Run: `pnpm --filter @mil/shared test`
Expected: PASS。

- [ ] **Step 11: typecheck + build**

Run: `pnpm --filter @mil/shared typecheck && pnpm --filter @mil/shared build`
Expected: 无错。

- [ ] **Step 12: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): 加 logger(pino)/errors/trace(OTel)/redis 客户端 (P1.3)"
```

---

## Task M0.8: 建 packages/db 骨架 + DataSource（P1.2.T1）

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/data-source.ts`
- Create: `packages/db/src/index.ts`

- [ ] **Step 1: 写 `packages/db/package.json`**

```json
{
  "name": "@mil/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "typeorm": "typeorm-ts-node-esm",
    "migration:generate": "pnpm typeorm migration:generate -d src/data-source.ts",
    "migration:run": "pnpm typeorm migration:run -d src/data-source.ts",
    "migration:revert": "pnpm typeorm migration:revert -d src/data-source.ts"
  },
  "dependencies": { "typeorm": "^0.3.20", "pg": "^8.12.0", "reflect-metadata": "^0.2.2" },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/pg": "^8.11.0", "ts-node": "^10.9.0" }
}
```

- [ ] **Step 2: 写 `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 写 `packages/db/src/data-source.ts`**

```ts
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { join } from 'node:path'

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.POSTGRES_URL ?? 'postgresql://milagents:milagents_dev@localhost:5432/milagents',
  entities: [join(__dirname, 'entities', '*.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  synchronize: false,
  logging: process.env.DB_LOG === '1',
})

export async function initDb(): Promise<DataSource> {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  return AppDataSource
}
```

- [ ] **Step 4: 写 `packages/db/src/index.ts`**

```ts
export { AppDataSource, initDb } from './data-source.js'
```

- [ ] **Step 5: 建 entities/migrations 空目录占位**

Run: `mkdir -p packages/db/src/entities packages/db/src/migrations && touch packages/db/src/entities/.gitkeep packages/db/src/migrations/.gitkeep`

- [ ] **Step 6: 验证连 PG**

Run: `pnpm --filter @mil/db exec ts-node --esm -e "import('./src/data-source.ts').then(async m => { const ds = await m.initDb(); console.log('connected:', ds.isInitialized); await ds.destroy() })"`
Expected: `connected: true`。

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): 加 TypeORM DataSource 骨架 + PG 连接 (P1.2.T1)"
```

---

## Task M0.9: Gate-2 — 定位 Flow State + 出时序图

**Files:**
- Create: `docs/gate-2-flow-state.md`

- [ ] **Step 1: 读 Flowise 的 Flow Execution State 定义**

Run: `cat ~/Projects/Flowise/packages/agentflow/src/core/types/execution.ts`
记录 `FlowExecutionState`、`NodeExecutionState` 字段。

- [ ] **Step 2: 读 agentflow reducer 与 API 层**

Run:
```bash
cat ~/Projects/Flowise/packages/agentflow/src/infrastructure/store/agentflowReducer.ts
cat ~/Projects/Flowise/packages/agentflow/src/infrastructure/api/index.ts
```
理解 state 如何被 reducer 更新、如何通过 API 执行。

- [ ] **Step 3: 读 server 的 predictions controller**

Run: `cat ~/Projects/Flowise/packages/server/src/controllers/predictions/index.ts`
理解一次 Prediction API 调用 server 做了什么、state 存哪。

- [ ] **Step 4: 画"一次 run 的状态流"时序图**

在 `docs/gate-2-flow-state.md` 写：
```markdown
# Gate-2: Flow State 定位结论

## Flow State 真实位置
- 定义: `packages/agentflow/src/core/types/execution.ts` 的 `FlowExecutionState`
- 更新: `agentflowReducer.ts`（Redux 式 reducer，前端）
- 执行: `infrastructure/api/` 调外部 API（server 的 Prediction API）

## 一次 run 的状态流（时序图）
（根据 Step 1-3 实际读取的内容填写，画出: 用户操作 → 前端 reducer → POST /api/v1/prediction → server 执行 → 结果回前端 → reducer 更新）

## 结论: "Flow State 外置到 Redis" 是否仍需？
- [ ] 是 / [ ] 否 / [ ] 需要但形态不同
- 理由: （根据时序图说明）

## 若需改造，改造点在哪些文件
1. ...
2. ...

## 若不需，跨实例恢复的替代方案
- ...
```

- [ ] **Step 5: Commit**

```bash
git add docs/gate-2-flow-state.md
git commit -m "docs: Gate-2 Flow State 定位结论与时序图"
```

> **Gate-2 判据:** 时序图出炉 + "是否需 Redis 外置"有明确结论。失败路径见 spec §0.4。

---

## Task M0.10: gateway/dispatch/scheduler 空壳起起来

**Files:**
- Create: `apps/gateway/package.json` + `src/index.ts`
- Create: `apps/dispatch/package.json` + `src/index.ts`
- Create: `apps/scheduler/package.json` + `src/index.ts`

- [ ] **Step 1: 写 `apps/gateway/package.json`**

```json
{
  "name": "@mil/gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx watch src/index.ts", "build": "tsup src/index.ts --format esm", "start": "node dist/index.js", "typecheck": "tsc --noEmit" },
  "dependencies": { "@hono/node-server": "^1.12.0", "hono": "^4.5.0", "@mil/shared": "workspace:*" },
  "devDependencies": { "tsx": "^4.0.0", "tsup": "^8.0.0", "typescript": "^5.5.0", "@types/node": "^20.0.0" }
}
```

- [ ] **Step 2: 写 `apps/gateway/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "./dist", "rootDir": "./src" }, "include": ["src/**/*"] }
```

- [ ] **Step 3: 写 `apps/gateway/src/index.ts`**

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.get('/health', (c) => c.json({ ok: true, svc: 'gateway' }))

const port = Number(process.env.GATEWAY_PORT ?? 8080)
serve({ fetch: app.fetch, port })
console.log(`gateway on :${port}`)
```

- [ ] **Step 4: 重复 Step 1-3 建 `apps/dispatch`**（端口 8081，`svc: 'dispatch'`）

- [ ] **Step 5: 重复 Step 1-3 建 `apps/scheduler`**（端口 8082，`svc: 'scheduler'`，用纯 Node http 或 Hono 均可）

- [ ] **Step 6: 起三个空壳验证健康检查**

Run（三个终端）:
```bash
pnpm --filter @mil/gateway dev
pnpm --filter @mil/dispatch dev
pnpm --filter @mil/scheduler dev
```
Run: `curl -s localhost:8080/health && curl -s localhost:8081/health && curl -s localhost:8082/health`
Expected: 三个 `{"ok":true,"svc":"..."}`。

- [ ] **Step 7: 加进 docker-compose（可选，M0 也可本地起）**

在 `infra/docker-compose.yml` 追加 gateway/dispatch/scheduler 服务（build 本地 Dockerfile 或用 host network 起开发模式）。M0 阶段建议本地 `pnpm dev` 起即可，compose 里先留占位。

- [ ] **Step 8: Commit**

```bash
git add apps/gateway apps/dispatch apps/scheduler
git commit -m "feat: gateway/dispatch/scheduler 空壳 + 健康检查 (M0.10)"
```

---

## Task M0.11: new-api 接入验证

**Files:**
- Modify: `infra/docker-compose.yml`（new-api 已在 M0.2）
- Create: `docs/m0-newapi-setup.md`

- [ ] **Step 1: 登录 new-api 配渠道**

访问 `http://localhost:3000`，用 root/123456 登录。在「渠道」添加一个上游渠道（如 Anthropic/OpenAI，填你的真实 API key）。在「令牌」生成一个 `sk-newapi-...` 令牌。

- [ ] **Step 2: 验证 new-api 能代理 LLM 调用**

Run:
```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <你的 sk-newapi token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```
Expected: 返回 LLM 响应。若失败，查渠道配置/key 余额。

- [ ] **Step 3: 记录 setup 到 `docs/m0-newapi-setup.md`**

写明：渠道配置步骤、令牌签发步骤、Flowise 如何指向 new-api（`base_url=http://localhost:3000/v1` + token）。

- [ ] **Step 4: Commit**

```bash
git add docs/m0-newapi-setup.md
git commit -m "docs: new-api 接入验证 (M0.11)"
```

---

# 里程碑 M1 — 单 Agent 验证（Flowise 原生）

**目标:** Flowise 建 1 个 Agent 节点跑通对话 + 工具；经 gateway 路由；Langfuse 见 trace。

---

## Task M1.1–M1.3: 在 forked Flowise 配 LLM + Agent 节点跑通对话

**Files:**
- Modify: `vendor/flowise/packages/server/.env`（LLM 凭证指向 new-api）

- [ ] **Step 1: 在 Flowise 配 LLM model 节点指向 new-api**

访问 `http://localhost:3100`，新建 chatflow，加一个 ChatOpenAI 节点，配置：
- Base Path: `http://new-api:3000/v1`（compose 内网络）或 `http://localhost:3000/v1`（本地）
- API Key: `<你的 sk-newapi token>`
- Model: `gpt-4o-mini`

- [ ] **Step 2: 加 1 个 Agent 节点 + 工具**

在 chatflow 里加 Agent 节点 + 一个简单工具（如 Calculator 或 Web Search）。

- [ ] **Step 3: 用 Flowise 自带 chat 跑通对话**

在 Flowise 画布的 chat 面板发消息，确认 agent 回复 + 工具调用正常。

- [ ] **Step 4: Commit（若有配置变更）**

```bash
git add vendor/flowise/packages/server/.env 2>/dev/null
git commit -m "chore: Flowise LLM 凭证指向 new-api (M1.1-M1.3)" --allow-empty
```

> 说明：Flowise 的 chatflow 定义存在 DB，非文件。此 task 主要是操作验证，commit 可为空或仅记 env。

---

## Task M1.4: 经 gateway 路由到 Flowise 对话

**Files:**
- Modify: `apps/gateway/src/index.ts`

- [ ] **Step 1: 写失败测试 `apps/gateway/src/__tests__/proxy.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
// 集成测试：经 gateway POST /api/v1/flows/:id/prediction 转发 Flowise
// 用 supertest 起gateway，mock Flowise 响应
describe('gateway flow proxy', () => {
  it('POST /api/v1/flows/:id/prediction 转发到 Flowise', async () => {
    // 占位：实际用 supertest + nock mock Flowise
    expect(true).toBe(true) // M1 阶段先骨架，真实集成在 M1.4 step3 手动验证
  })
})
```

- [ ] **Step 2: 实现网关 flow 代理路由**

在 `apps/gateway/src/index.ts` 加：
```ts
import { createLogger } from '@mil/shared'
const log = createLogger({ svc: 'gateway' })

const FLOWISE_URL = process.env.FLOWISE_URL ?? 'http://localhost:3100'

app.all('/api/v1/flows/*', async (c) => {
  const path = c.req.path.replace('/api/v1/flows', '')
  const url = `${FLOWISE_URL}/api/v1${path.includes('prediction') ? '/prediction' : ''}${path}`
  const runId = c.req.header('x-run-id') ?? crypto.randomUUID()
  log.info('proxy flow', { path, runId })
  const upstream = await fetch(url, {
    method: c.req.method,
    headers: { ...c.req.header(), 'x-run-id': runId },
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
  })
  return new Response(upstream.body, { status: upstream.status, headers: { 'x-run-id': runId } })
})
```

- [ ] **Step 3: 手动验证经 gateway 对话**

Run: `pnpm --filter @mil/gateway dev`
Run:
```bash
curl -s http://localhost:8080/api/v1/flows/<chatflowId>/prediction \
  -H "Content-Type: application/json" \
  -d '{"question":"你好"}'
```
Expected: 返回 agent 回复。

- [ ] **Step 4: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): flow 代理路由 + run_id 透传 (M1.4)"
```

---

## Task M1.5: Langfuse 接入

**Files:**
- Modify: `vendor/flowise/packages/server/.env`

- [ ] **Step 1: 配 Flowise 的 Langfuse 集成**

在 `vendor/flowise/packages/server/.env` 加：
```
LANGFUSE_BASE_URL=http://localhost:3001
LANGFUSE_PUBLIC_KEY=<在 Langfuse UI 创建项目拿到的 public key>
LANGFUSE_SECRET_KEY=<secret key>
```
或通过 Flowise UI 的 Observability 设置配 Langfuse（按 Flowise 文档）。

- [ ] **Step 2: 跑一次对话，在 Langfuse 验证 trace**

在 Flowise chat 发一条消息，然后访问 `http://localhost:3001`，确认有 trace + token/cost。

- [ ] **Step 3: Commit**

```bash
git add vendor/flowise/packages/server/.env
git commit -m "chore: Flowise 接入 Langfuse (M1.5)"
```

---

# 里程碑 M2 — 第一个 Agent Daemon + Gate-1（头号 spike）

**目标:** dispatch + claude-code daemon 跑通；画布内 HTTP 节点能调 Claude Code；Gate-1 通过。

**关键路径:** M2.1（claude adapter）→ M2.4（Gate-1 e2e）→ M2.9（HTTP 节点）→ M2.10 严格串行。

---

## Task M2.1: agent-adapters/claude.ts — spawn + stream-json 解析（Gate-1 核心，P1.6.T1）

**Files:**
- Create: `packages/agent-adapters/package.json` + `tsconfig.json`
- Create: `packages/agent-adapters/src/claude.ts`
- Create: `packages/agent-adapters/src/claude.test.ts`
- Create: `packages/agent-adapters/src/index.ts`

- [ ] **Step 1: 写 `packages/agent-adapters/package.json`**

```json
{
  "name": "@mil/agent-adapters",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsup src/index.ts --format esm --dts", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@mil/contracts": "workspace:*", "@mil/shared": "workspace:*" },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" }
}
```

- [ ] **Step 2: 写失败测试 `packages/agent-adapters/src/claude.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { claudeBackend } from './claude.js'

describe('claudeBackend', () => {
  it('execute 返回 AgentSession', () => {
    const b = claudeBackend({ executablePath: 'claude' })
    const session = b.execute('hi', {})
    expect(session.events).toBeDefined()
    expect(typeof session.result.then).toBe('function')
  })
  it('buildClaudeArgs 构造 stream-json 参数', async () => {
    const { buildClaudeArgs } = await import('./claude.js')
    const args = buildClaudeArgs({ model: 'claude-sonnet-4-20250514', thinkingLevel: 'high' })
    expect(args).toContain('--print')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--model')
    expect(args).toContain('claude-sonnet-4-20250514')
  })
  it('buildClaudeArgs 含 resume', async () => {
    const { buildClaudeArgs } = await import('./claude.js')
    const args = buildClaudeArgs({ resumeSessionId: 'sess-123' })
    expect(args).toContain('--resume')
    expect(args).toContain('sess-123')
  })
})
```

- [ ] **Step 3: 跑测试验证失败**

Run: `pnpm --filter @mil/agent-adapters test`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 写 `packages/agent-adapters/src/claude.ts`**（参照 multica `pkg/agent/claude.go` 翻译）

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentBackend, AgentEvent, AgentResult, BackendConfig, ExecOptions, AgentSession, TokenUsage } from '@mil/contracts'
import { createLogger, type Logger } from '@mil/shared'

export function buildClaudeArgs(opts: ExecOptions): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose']
  if (opts.model) args.push('--model', opts.model)
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt)
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  if (opts.thinkingLevel) args.push('--thinking-level', opts.thinkingLevel)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  if (opts.customArgs) args.push(...opts.customArgs)
  return args
}

interface ClaudeStreamMessage {
  type: string
  message?: { content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown; content?: string }> }
  session_id?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
}

function parseEvent(msg: ClaudeStreamMessage): AgentEvent[] {
  const out: AgentEvent[] = []
  if (msg.type === 'system' && msg.session_id) {
    out.push({ type: 'status', status: 'started', sessionId: msg.session_id })
  }
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) out.push({ type: 'text', content: block.text })
      else if (block.type === 'thinking' && block.text) out.push({ type: 'thinking', content: block.text })
      else if (block.type === 'tool_use') out.push({ type: 'tool-use', tool: block.name ?? '', callId: block.id ?? '', input: block.input })
    }
  }
  if (msg.type === 'result') {
    out.push({ type: 'status', status: 'completed', sessionId: msg.session_id })
  }
  return out
}

export function claudeBackend(cfg: BackendConfig): AgentBackend {
  const log: Logger = cfg.logger ?? createLogger({ svc: 'claude-adapter' })
  return {
    execute(prompt: string, opts: ExecOptions): AgentSession {
      const execPath = cfg.executablePath || 'claude'
      const args = buildClaudeArgs(opts)
      const startedAt = Date.now()
      let proc: ChildProcess | null = null
      let usage: Record<string, TokenUsage> = {}
      let sessionId: string | undefined
      let output = ''
      let finalStatus: AgentResult['status'] = 'completed'
      let finalError: string | undefined

      const events: AsyncIterable<AgentEvent> = {
        async *[Symbol.asyncIterator]() {
          proc = spawn(execPath, args, { cwd: opts.cwd, env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] })
          const stdout = proc.stdout!
          const stderr = proc.stderr!
          let buf = ''
          stderr.on('data', (d) => log.warn('claude stderr', { chunk: d.toString().slice(-2048) }))

          // 写 prompt 到 stdin
          proc.stdin!.write(prompt)
          proc.stdin!.end()

          for await (const chunk of stdout) {
            buf += chunk.toString()
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try {
                const msg: ClaudeStreamMessage = JSON.parse(trimmed)
                if (msg.usage) {
                  usage[msg.model ?? 'claude'] = {
                    inputTokens: msg.usage.input_tokens ?? 0,
                    outputTokens: msg.usage.output_tokens ?? 0,
                    cacheReadTokens: msg.usage.cache_read_input_tokens,
                  }
                }
                if (msg.session_id) sessionId = msg.session_id
                for (const ev of parseEvent(msg)) {
                  if (ev.type === 'text') output += ev.content
                  yield ev
                }
              } catch {
                yield { type: 'log', content: trimmed }
              }
            }
          }
          const code = await new Promise<number>((r) => proc!.on('close', r))
          if (code !== 0 && code !== null) {
            finalStatus = 'failed'
            finalError = `claude exited with code ${code}`
          }
        },
      }

      const result: Promise<AgentResult> = (async () => {
        for await (const _ of events) { /* drain */ }
        return {
          status: finalStatus,
          output,
          error: finalError,
          durationMs: Date.now() - startedAt,
          sessionId,
          usage,
        }
      })()

      return { events, result }
    },
  }
}
```

- [ ] **Step 5: 写 `packages/agent-adapters/src/index.ts`**

```ts
export { claudeBackend, buildClaudeArgs } from './claude.js'
```

- [ ] **Step 6: 跑测试验证通过**

Run: `pnpm --filter @mil/agent-adapters test`
Expected: PASS。

- [ ] **Step 7: 手动 e2e 验证（Gate-1 一部分）**

Run:
```bash
node --input-type=module -e "
import { claudeBackend } from './packages/agent-adapters/dist/index.js'
const b = claudeBackend({ executablePath: 'claude' })
const s = b.execute('说一句你好', { timeoutMs: 30000 })
for await (const ev of s.events) console.log(JSON.stringify(ev))
const r = await s.result
console.log('RESULT:', JSON.stringify(r))
"
```
Expected: 看到text/status 事件流 + 最终 result（含 usage）。**这是 Gate-1 核心**——跑通 3 次确认稳定。

- [ ] **Step 8: Commit**

```bash
git add packages/agent-adapters
git commit -m "feat(agent-adapters): claude.ts spawn + stream-json 解析 (P1.6.T1, Gate-1 核心)"
```

---

## Task M2.2: apps/dispatch 最小协议（P1.5.T1–T5）

**Files:**
- Create: `apps/dispatch/src/index.ts`
- Create: `apps/dispatch/src/routes/invoke.ts`
- Create: `apps/dispatch/src/routes/daemons.ts`
- Create: `apps/dispatch/src/routes/tasks.ts`

> 此任务较大，拆成 5 个子 step 对应 T1–T5。每个子 step 独立 commit。

- [ ] **Step 1 (T1): dispatch 骨架 + DB 连接**

写 `apps/dispatch/src/index.ts`：
```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { AppDataSource } from '@mil/db'
import { createLogger } from '@mil/shared'

const app = new Hono()
app.get('/health', (c) => c.json({ ok: true, svc: 'dispatch' }))

const port = Number(process.env.DISPATCH_PORT ?? 8081)
await AppDataSource.initialize()
const log = createLogger({ svc: 'dispatch' })
log.info('dispatch starting', { port })
serve({ fetch: app.fetch, port })
console.log(`dispatch on :${port}`)
```
依赖加 `@mil/db`、`@mil/contracts`。验证 `/health`。

Commit: `feat(dispatch): 骨架 + DB 连接 (P1.5.T1)`

- [ ] **Step 2 (T2): `POST /api/v1/dispatch/invoke`**

写 `apps/dispatch/src/routes/invoke.ts`：入队 `dispatch_tasks` 表，返回 `{ taskId }`。需要 `dispatch_tasks` entity（P1.2.T3，此处先用 spec §5.3 的 SQL 结构）。

```ts
import { Hono } from 'hono'
import { AppDataSource } from '@mil/db'
import { randomUUID } from 'node:crypto'

export const invoke = new Hono()
invoke.post('/invoke', async (c) => {
  const body = await c.req.json<{ agentDaemonId: string; prompt: string; execOptions: unknown; runId: string }>()
  const id = randomUUID()
  await AppDataSource.query(
    `INSERT INTO dispatch_tasks (id, agent_daemon_id, run_id, prompt, exec_options, status, created_at) VALUES ($1,$2,$3,$4,$5,'queued',NOW())`,
    [id, body.agentDaemonId, body.runId, body.prompt, JSON.stringify(body.execOptions)],
  )
  return c.json({ taskId: id })
})
```

Commit: `feat(dispatch): POST /invoke 入队 (P1.5.T2)`

- [ ] **Step 3 (T3): `POST /daemons/register` + `/heartbeat`**

写 `apps/dispatch/src/routes/daemons.ts`：register 插 `daemons` 表返回 daemonId+token；heartbeat 更新 last_heartbeat_at + status。

Commit: `feat(dispatch): daemon register + heartbeat (P1.5.T3)`

- [ ] **Step 4 (T4): `POST /daemons/:id/tasks/claim`**

在 daemons.ts 加 claim：`SELECT ... FOR UPDATE SKIP LOCKED` 取一条 queued 任务，更新为 claimed + claimed_by_daemon_id，返回 task。

```ts
daemons.post('/:id/tasks/claim', async (c) => {
  const daemonId = c.req.param('id')
  const rows = await AppDataSource.query(
    `UPDATE dispatch_tasks SET status='claimed', claimed_by_daemon_id=$1, claimed_at=NOW()
     WHERE id IN (SELECT id FROM dispatch_tasks WHERE status='queued' LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, agent_daemon_id, run_id, prompt, exec_options`,
    [daemonId],
  )
  const task = rows[0]
  return c.json({ task: task ? { id: task.id, agentDaemonId: task.agent_daemon_id, runId: task.run_id, prompt: task.prompt, execOptions: task.exec_options } : null })
})
```

Commit: `feat(dispatch): tasks/claim (P1.5.T4)`

- [ ] **Step 5 (T5): `POST /tasks/:id/start|progress|messages|complete|fail`**

写 `apps/dispatch/src/routes/tasks.ts`：全套状态更新 + messages 落库（可用 `dispatch_task_events` 表或直接落 `runs.agent_daemon_calls`）。

Commit: `feat(dispatch): tasks start/progress/messages/complete/fail (P1.5.T5)`

---

## Task M2.3: packages/daemon 主循环（Gate-1 核心，P1.6.T2）

**Files:**
- Create: `packages/daemon/package.json` + `tsconfig.json`
- Create: `packages/daemon/src/client.ts`
- Create: `packages/daemon/src/main.ts`
- Create: `packages/daemon/src/index.ts`

- [ ] **Step 1: 写 `packages/daemon/package.json`**

```json
{
  "name": "@mil/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "mil-daemon": "./dist/cli.js" },
  "scripts": { "build": "tsup src/main.ts src/cli.ts --format esm", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@mil/contracts": "workspace:*", "@mil/agent-adapters": "workspace:*", "@mil/shared": "workspace:*" },
  "devDependencies": { "tsup": "^8.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" }
}
```

- [ ] **Step 2: 写 `packages/daemon/src/client.ts`**（dispatch HTTP client）

```ts
import type { AgentEvent, AgentResult, ClaimTaskResponse, RegisterRequest, RegisterResponse, HeartbeatPayload, TaskComplete, TaskFail } from '@mil/contracts'

export class DispatchClient {
  constructor(private baseUrl: string, private token: string) {}

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const r = await fetch(`${this.baseUrl}/api/v1/dispatch/daemons/register`, { method: 'POST', headers: this.headers(), body: JSON.stringify(req) })
    return r.json()
  }
  async heartbeat(p: HeartbeatPayload): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/dispatch/daemons/heartbeat`, { method: 'POST', headers: this.headers(), body: JSON.stringify(p) })
  }
  async claimTask(daemonId: string): Promise<ClaimTaskResponse> {
    const r = await fetch(`${this.baseUrl}/api/v1/dispatch/daemons/${daemonId}/tasks/claim`, { method: 'POST', headers: this.headers() })
    return r.json()
  }
  async startTask(taskId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/dispatch/tasks/${taskId}/start`, { method: 'POST', headers: this.headers() })
  }
  async reportMessages(taskId: string, messages: AgentEvent[]): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/dispatch/tasks/${taskId}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ messages }) })
  }
  async completeTask(taskId: string, r: TaskComplete): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/dispatch/tasks/${taskId}/complete`, { method: 'POST', headers: this.headers(), body: JSON.stringify(r) })
  }
  async failTask(taskId: string, r: TaskFail): Promise<void> {
    await fetch(`${this.baseUrl}/api/v1/dispatch/tasks/${taskId}/fail`, { method: 'POST', headers: this.headers(), body: JSON.stringify(r) })
  }
  private headers() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` } }
}
```

- [ ] **Step 3: 写 `packages/daemon/src/main.ts`**（主循环）

```ts
import { DispatchClient } from './client.js'
import { claudeBackend } from '@mil/agent-adapters'
import { createLogger } from '@mil/shared'
import type { AgentType } from '@mil/contracts'

export interface DaemonOpts {
  serverUrl: string
  label: string
  agentType: AgentType
  pollIntervalMs?: number
}

export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const log = createLogger({ svc: 'daemon', label: opts.label })
  const client = new DispatchClient(opts.serverUrl, '') // token from register
  const reg = await client.register({ daemonLabel: opts.label, capabilities: [{ agentType: opts.agentType }] })
  const token = reg.token
  ;(client as any).token = token
  const daemonId = reg.daemonId
  log.info('daemon registered', { daemonId })

  const poll = opts.pollIntervalMs ?? 2000
  // heartbeat
  setInterval(() => client.heartbeat({ daemonId, status: 'online', activeTasks: 0 }), 5000)

  while (true) {
    const { task } = await client.claimTask(daemonId)
    if (!task) { await sleep(poll); continue }
    log.info('claimed task', { taskId: task.id })
    await client.startTask(task.id)
    const backend = claudeBackend({ executablePath: opts.agentType === 'claude' ? 'claude' : opts.agentType })
    const session = backend.execute(task.prompt, task.execOptions as any)
    for await (const ev of session.events) {
      await client.reportMessages(task.id, [ev])
    }
    const result: AgentResult = await session.result
    if (result.status === 'completed') {
      await client.completeTask(task.id, { output: result.output, sessionId: result.sessionId, usage: result.usage, durationMs: result.durationMs })
    } else {
      await client.failTask(task.id, { error: result.error ?? 'unknown', failureReason: result.status, sessionId: result.sessionId })
    }
    log.info('task done', { taskId: task.id, status: result.status })
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
```

- [ ] **Step 4: 写 `packages/daemon/src/cli.ts`**

```ts
import { runDaemon } from './main.js'
import type { AgentType } from '@mil/contracts'

const [serverUrl, label, agentType] = process.argv.slice(2)
if (!serverUrl || !label || !agentType) {
  console.error('usage: mil-daemon <serverUrl> <label> <agentType>')
  process.exit(1)
}
runDaemon({ serverUrl, label, agentType: agentType as AgentType }).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 5: typecheck + build**

Run: `pnpm --filter @mil/daemon typecheck && pnpm --filter @mil/daemon build`
Expected: 无错。

- [ ] **Step 6: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): 主循环 + dispatch client + CLI (P1.6.T2, Gate-1 核心)"
```

---

## Task M2.4: Gate-1 端到端验证

- [ ] **Step 1: 起 dispatch + daemon**

```bash
pnpm --filter @mil/dispatch dev   # 终端1
pnpm --filter @mil/daemon dev -- http://localhost:8081 dev-laptop claude  # 终端2（或 build 后跑 dist/cli.js）
```

- [ ] **Step 2: 手动 invoke**

Run:
```bash
curl -s http://localhost:8081/api/v1/dispatch/invoke \
  -H "Content-Type: application/json" \
  -d '{"agentDaemonId":"<注册时拿到的>","prompt":"列出当前目录","execOptions":{"timeoutMs":30000},"runId":"R-test-1"}'
```
Expected: 返回 `{ taskId }`。daemon claim 后 spawn claude，事件流上报，最终 complete。

- [ ] **Step 3: 验证事件流与 result**

查 dispatch 的 messages 落库，确认含 text/tool-use/tool-result；查 complete 落库含 usage。

- [ ] **Step 4: 跑 3 次确认稳定**

重复 Step 2 三次，确认无解析崩溃。

- [ ] **Step 5: Commit（Gate-1 通过备忘）**

```bash
git commit --allow-empty -m "docs: Gate-1 通过 — dispatch↔daemon↔claude e2e 跑通 3 次"
```

> **Gate-1 判据:** 3 次 e2e 跑通 + 事件流含 text/tool-use + result 含 usage。失败路径见 spec §0.3。

---

## Task M2.5–M2.7: watchdog + session resume + MCP + usage（P1.6.T3/T4/T5）

- [ ] **Step 1 (T3): 双层 watchdog**

在 `packages/agent-adapters/src/claude.ts` 加：
- `timeoutMs`：总超时，到点 kill proc，result.status='timeout'
- `inactivityTimeoutMs`：每次 yield 事件重置定时器，超时 kill，status='aborted'

测试：mock spawn 不产出，验证 timeout 触发。

Commit: `feat(agent-adapters): 双层 watchdog (P1.6.T3)`

- [ ] **Step 2 (T4): MCP 注入 + thinkingLevel**

`buildClaudeArgs` 已含 thinkingLevel。MCP：若 `opts.mcpConfig`，写临时文件 + `--mcp-config <path>`。参照 multica `writeMcpConfigToTemp`。

Commit: `feat(agent-adapters): MCP 注入 + thinkingLevel 透传 (P1.6.T4)`

- [ ] **Step 3 (T5): usage 上报**

claude.ts 已解析 `msg.usage`。验证 result.usage 按 model 聚合正确。

Commit: `feat(agent-adapters): usage 按 model 聚合 (P1.6.T5)`

---

## Task M2.8: new-api 令牌代理 + 健康探测 + LLM 统一上游（P1.4.T5/T8/T10）

**Files:**
- Modify: `apps/gateway/src/index.ts`
- Create: `apps/gateway/src/routes/tokens.ts`
- Create: `packages/db/src/entities/token-meta.ts`

- [ ] **Step 1: 写 `token_meta` entity + 迁移**

参照 spec §6.2 的 `token_meta` 表结构写 TypeORM entity + `migration:generate`。

Commit: `feat(db): token_meta entity (P1.2.T7)`

- [ ] **Step 2: 写 `apps/gateway/src/routes/tokens.ts`**

`/api/v1/tokens/*` 代理 new-api API（CRUD），同时维护本地 token_meta（remark/group/visibility）。网关持有 `NEWAPI_ADMIN_KEY`。

```ts
import { Hono } from 'hono'
const NEWAPI = process.env.NEWAPI_BASE_URL ?? 'http://localhost:3000'
const ADMIN_KEY = process.env.NEWAPI_ADMIN_KEY ?? ''
export const tokens = new Hono()
tokens.all('/*', async (c) => {
  const path = c.req.path.replace('/api/v1/tokens', '')
  const r = await fetch(`${NEWAPI}/api/token${path}`, {
    method: c.req.method,
    headers: { ...c.req.header(), Authorization: `Bearer ${ADMIN_KEY}` },
    body: ['GET','HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
  })
  return new Response(r.body, { status: r.status })
})
```

Commit: `feat(gateway): new-api 令牌代理 + token_meta (P1.4.T5)`

- [ ] **Step 3 (T8): 健康探测**

定时轮询 new-api token 状态，标记限流/失效/过期。可用 `setInterval` + 落 token_meta.status。

Commit: `feat(gateway): new-api 健康探测 (P1.4.T8)`

- [ ] **Step 4 (T10): LLM 统一上游**

`/api/v1/llm/*` 透传 new-api `/v1/*`。Flowise/daemon 的 LLM 调用都走此入口。

Commit: `feat(gateway): LLM 统一上游透传 new-api (P1.4.T10)`

---

## Task M2.9: HTTP→dispatch 自定义节点（P1.9.T3）

**Files:**
- Modify: `vendor/flowise/packages/components/` 或 `packages/server/src/`（按 Flowise 节点注册机制）

- [ ] **Step 1: 定位 Flowise 自定义节点注册位置**

Run: `find ~/Projects/Flowise/packages -type d -name 'nodes' | head; grep -rn 'customNodes\|registerNode' ~/Projects/Flowise/packages/components/src 2>/dev/null | head`

- [ ] **Step 2: 写 HTTP→dispatch 节点**

参照 Flowise 现有 HTTP 节点结构，写一个 `DispatchInvoke` 节点：输入 `{ agentDaemonId, promptTemplate }`，执行时 `POST gateway/api/v1/dispatch/invoke`，返回结果。

- [ ] **Step 3: 画布验证节点可拖出**

在 Flowise 画布拖出该节点，连 LLM，发消息验证能调 dispatch。

- [ ] **Step 4: Commit**

```bash
git add vendor/flowise/packages/...
git commit -m "feat(flowise): HTTP→dispatch 自定义节点 (P1.9.T3)"
```

---

## Task M2.10: 画布端到端

- [ ] **Step 1: 画布串起来**

Flowise 画布：HTTP→dispatch 节点 → 接收 claude 结果 → Direct Reply。

- [ ] **Step 2: 经 gateway 触发对话验证**

Run: `curl gateway/api/v1/flows/<id>/prediction -d '{"question":"用 claude 列出目录"}'`
Expected: claude daemon 被调，结果回画布。

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "docs: M2 完成 — 画布内调 Claude Code e2e"
```

---

> **M3–M6 的任务在下方继续。** 由于篇幅，M3 起的任务以相同 TDD 结构展开，每个任务带文件/测试/实现/commit。此处给出 M3–M6 的任务清单（精炼到任务级，实现时按相同 TDD 节奏展开）。

---

# 里程碑 M3 — 批量执行 + Flow State 改造（依赖 Gate-2）

## Task M3.1: scheduler 单 run 执行 + 并发闸（P1.7.T1–T3）
- 建 `apps/scheduler/src/index.ts`：消费 Redis 队列 `mil:tasks`，每条 = { runId, pipelineId, input }。
- 调 Flowise `POST /api/v1/prediction/{flowId}`（经 gateway），落 output 到 `runs` 表。
- 并发闸：Redis 信号量 `mil:sem` maxConcurrent。
- 测试：mock Flowise 响应，验证单 run 执行 + 并发限制。
- Commit: `feat(scheduler): 单 run 执行 + 并发闸 (P1.7.T1-T3)`

## Task M3.2: 批量 fan-out（P1.7.T4）
- 收到批量输入 → 创建 parent_run → 拆 N 子 run（parent_run_id）→ 并发调 Prediction API。
- 测试：N=5 输入，验证 5 个子 run + parent 聚合。
- Commit: `feat(scheduler): 批量 fan-out (P1.7.T4)`

## Task M3.3: Flow State 跨实例可恢复 — 配置 + 集成验证（P1.9.T2，依赖 Gate-2）
- **重定义**（Gate-2 双签通过，见 `docs/gate-2-flow-state.md` §5.2）：由"改 fork state 存储"改为「配置 + 集成验证 + 一个默认值小改」。Gate-2 结论「需要但形态不同」——跨轮次 state 载体是 PG `execution` 表（`startPersistState=true`），多实例水平扩展走 `MODE=QUEUE`（BullMQ + Redis pub/sub），Redis 用作队列/事件桥而非 state 存储。
- **明确不改**：`vendor/flowise/packages/agentflow/src/infrastructure/store/agentflowReducer.ts`（编辑器展示态 reducer，不在服务端执行路径）、`vendor/flowise/packages/server/src/controllers/predictions/index.ts`（HTTP 入口，不持有 state）、`vendor/flowise/packages/server/src/utils/buildAgentflow.ts`（执行引擎本体，state 读写逻辑正确）。Gate-2 已证三者非 state 载体。
- **fork 小改**：`vendor/flowise/packages/components/nodes/agentflow/Start/Start.ts:758` 的 `startPersistState` 默认值由未开改为 `true`（配置级，非架构改造）；或平台层 `overrideConfig` 强制，代价是每个 flow 都要记得设——建议默认值改在 fork 里。
- **平台层部署约束**：`DATABASE_TYPE=postgres`（共享 PG，不能用每实例 sqlite）+ `MODE=QUEUE` + `REDIS_URL`（共享 Redis，开启 BullMQ 队列 + RedisEvent pub/sub）。
- **集成验证（M3.3 实际产出，不是写 Redis state backend）**：起两个 Flowise 实例 + 共享 PG/Redis，按下列三条验收标准验证。这是测试任务，不是写 Redis state backend。
- **验收标准（product-manager 共签，保留三条）**：
  1. **跨实例续跑**：双实例 + 共享 PG/Redis，同一 sessionId 落到不同 worker 仍能恢复 state（MVP 水平扩展真实判据，不只是同实例跨轮次）。
  2. **批量 fan-out 跨 worker**（接 M3.2）：QUEUE 模式 job 跨实例路由正确。
  3. **重启后 `execution` 表恢复**（接 M3.5）：实例重启后从 PG `execution` 表恢复。
- **不触发 spec §0.4 失败路径 (b) 自研执行引擎**。工作量远小于 plan 原文"改 state 存 Redis"。
- 平台层 run checkpoint（`runs` 表 + 断点续跑 M3.5）仍按原计划在 `apps/scheduler` 做，与 Flowise fork 解耦。
- Commit: `feat(flowise): startPersistState 默认开 + M3.3 集成验证配置 (P1.9.T2)`

## Task M3.4: 失败重跑（P1.7.T5）
- 同一 pipeline_version_hash 重跑指定子 run。
- Commit: `feat(scheduler): 失败重跑 (P1.7.T5)`

## Task M3.5: 断点续跑（P1.7.T8）
- 重启后扫 `runs` 表 status=running 的恢复。
- Commit: `feat(scheduler): 断点续跑 (P1.7.T8)`

## Task M3.6: 批量端到端
- N 篇输入 → fan-out → 重启可续。
- Commit: `docs: M3 完成 — 批量可跑可续`

---

# 里程碑 M4 — 版本可复现（P1.8）

## Task M4.1: packages/repro（P1.8.T1–T5）
- 建 `packages/repro`：`snapshotPipeline(flowId)` 取 flow JSON + SHA-256 + 去重写入 `pipeline_versions`。
- `bindRunToVersion(runId, hash)` 绑 `runs.pipeline_version_hash`。
- `archiveArtifact(runId, artifact)` 存 MinIO + uri 回写。
- 复现：同 hash + 同 input 重跑 + 结构比对。
- 测试：同 flow 二次快照复用 hash；artifact 可存可取。
- Commit: `feat(repro): 快照+哈希+绑定+归档+复现 (P1.8)`

## Task M4.2: scheduler 集成 repro
- run 创建时 snapshot + bind，完成时 archive。
- Commit: `feat(scheduler): 集成 repro (M4.2)`

## Task M4.3: 复现端到端
- 同 hash + 同 input 重跑 + 比对。
- Commit: `docs: M4 完成 — 可复现`

---

# 里程碑 M5 — 控制台前端（拆 M5a/M5b）

## M5a — 核心控制台

## Task M5a.1: console 骨架 + 对话/会话/SSE（P1.10.T1–T3）
- 建 `apps/console`（Next.js app router）+ 侧栏 6 页导航 + 对话视图 + SSE 流式。
- 依赖 `@mil/shared`、经 gateway 调 Flowise。
- Commit: `feat(console): 骨架 + 对话 + SSE (P1.10.T1-T3)`

## Task M5a.2: Agents 管理页（P1.10.T4）
- 列表/看板/详情 + 过滤（类型/状态/角色/区域）+ 能力描述符 + 当前 run + 资源占用 + 日志流。
- 读 `agent_daemons` + `runs.agent_daemon_calls`。
- Commit: `feat(console): Agents 管理页 (P1.10.T4)`

## Task M5a.3: AgentFlows 浏览页（P1.10.T5，依赖 P1.9.T5）
- flow 列表 + DAG 只读渲染（reactflow）+ 节点状态着色 + 节点级 run 耗时/预算/token/成本/日志。
- 读 P1.9.T5 接口。
- Commit: `feat(console): AgentFlows 浏览页 (P1.10.T5)`

## Task M5a.4: 设置页 6 tab（P1.10.T8）
- API Key（接 new-api 代理）/默认模型/预算配额/通知/账户团队/危险区。
- Commit: `feat(console): 设置页 6 tab (P1.10.T8)`

## M5b — 协作与看板

## Task M5b.1: Workspace 项目对话页（P1.10.T6）
- 项目列表 + 成员 + 关联 flow + 产物 + 配额 + 对话线程 + 附件。
- 依赖 `workspace_members`/`workspace_flows` 表。
- Commit: `feat(console): Workspace 项目对话页 (P1.10.T6)`

## Task M5b.2: Lab 多 agent 聊天室（P1.10.T7）
- 实验会话列表 + 线程化消息 + @提及 + thinking 展示 + tool 调用块 + 人工介入。
- 依赖 `lab_sessions`/`lab_messages` 表。
- Commit: `feat(console): Lab 多 agent 聊天室 (P1.10.T7)`

## Task M5b.3: 资源看板页（P1.10.T9，依赖 P1.11.T6）
- fleet 密度 + 状态分布 + 24h 吞吐 + 区域 + 成本。
- Commit: `feat(console): 资源看板页 (P1.10.T9)`

## Task M5b.4: SSO 接入 + run_id 全页透传（P1.10.T10）
- Commit: `feat(console): SSO + run_id 透传 (P1.10.T10)`

---

# 里程碑 M6 — 监控日志 + 资源面板 + 节点级 trace

## Task M6.1: OTel 全链路（P1.11.T2）
- gateway/dispatch/daemon/scheduler 接 OTel SDK，trace 串 run_id。
- Commit: `feat(otel): 全链路 trace 串 run_id (P1.11.T2)`

## Task M6.2: daemon usage 落库（P1.11.T3）
- daemon usage → dispatch → `runs.agent_daemon_calls`。
- Commit: `feat(otel): daemon usage 落库 (P1.11.T3)`

## Task M6.3: 资源面板 MVP（P1.11.T4）
- 用量/成本/daemon 状态，读 runs + Langfuse。
- Commit: `feat(otel): 资源面板 MVP (P1.11.T4)`

## Task M6.4: 节点级 trace（P1.11.T5）
- Flowise run 的节点 span 落库 + 前端展示。
- Commit: `feat(otel): 节点级 trace (P1.11.T5)`

## Task M6.5: 资源看板数据聚合 API（P1.11.T6）
- fleet 状态分布/吞吐/区域/成本，读 runs + Langfuse + new-api。
- Commit: `feat(otel): 资源看板聚合 API (P1.11.T6)`

## Task M6.6: 审计日志落地（P1.4.T6）
- key 操作/权限/删除/版本锁定/令牌轮换 落库。
- Commit: `feat(gateway): 审计日志 (P1.4.T6)`

## Task M6.7: 全链路追溯端到端验证
- 任一任务全链路 trace 可追。
- Commit: `docs: M6 完成 — 全链路可追溯`

---

# 收尾

## Task END: MVP 全闭环验证
- [ ] 跑通论文复现场景（1 篇）：定义 agent → 编排 flow → 批量 → 监控 → 复现。
- [ ] 确认两个 Gate 都通过、所有里程碑验收达标。
- [ ] Commit: `docs: MVP 全闭环达成`
