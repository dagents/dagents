# 测试环境保障报告（zcode-borrow）

> 生成：2026-10-07 21:52（本机 darwin 25.6.0 arm64，仓库 `/Users/rowan/Projects/dagents`，分支 `feat/zcode-borrow`）
> 所有结论均来自当次实际执行的命令，命令与关键输出原样摘录。

## 结论速览

| 项 | 状态 | 一句话 |
|---|---|---|
| infra Postgres (:15432) | ✅ 可用 | 容器 healthy 2 周，pg_isready accepting，凭据连库返回 1 |
| 根 `.env` | ✅ 就绪 | POSTGRES_URL 指向该实例，凭据/库名与 compose 默认一致 |
| :8080 gateway dev | ⚠️ **在跑，须避让** | 本仓库 tsx dev（PID 5282），`/health` svc:gateway db:up |
| :3000 console dev | ⚠️ **在跑，须避让** | 本仓库 next-server（PID 5351），首页 title `Dagents` |

## 1. infra Postgres（localhost:15432）

**无需启动**——实例已在跑。证据：

```bash
$ docker compose -f infra/docker-compose.yml ps
dagents-postgres-1   postgres:16-alpine   ...   Up 2 weeks (healthy)   127.0.0.1:15432->5432/tcp
dagents-langfuse-1   langfuse/langfuse:2.95.11   ...   Up 2 weeks (healthy)   127.0.0.1:3001->3000/tcp

$ nc -z -w 3 localhost 15432
Connection to localhost port 15432 [tcp/*] succeeded!

$ docker exec dagents-postgres-1 pg_isready -U dagents -d dagents
/var/run/postgresql:5432 - accepting connections

# 凭据级验证（host 无 psql，落在容器内执 psql，连的是容器自身 5432）：
$ docker exec dagents-postgres-1 psql "postgresql://dagents:dagents_dev@localhost:5432/dagents" -tAc 'select 1'
1
```

host 侧 15432 → 容器 5432 的映射由 `docker ps` 的 `127.0.0.1:15432->5432/tcp` 证明；
host 侧全链路（URL+凭据）另由 gateway `/health` 返回 `"db":"up"` 佐证（gateway 在 host 上用 POSTGRES_URL 连库）。

附：Langfuse（:3001）同栈也在跑且 healthy，本阶段未触碰。

## 2. 根 `.env`

已存在（`-rw-r--r-- 1841 字节，Sep 24 23:11`），关键行：

```
POSTGRES_URL=postgresql://dagents:dagents_dev@localhost:15432/dagents
GATEWAY_URL=http://localhost:8080
GATEWAY_PORT=8080
```

与 `infra/docker-compose.yml` 默认值一致（`POSTGRES_USER:-dagents` / `POSTGRES_PASSWORD:-dagents_dev` /
`POSTGRES_DB:-dagents` / `127.0.0.1:${POSTGRES_HOST_PORT:-15432}:5432`，见该文件 29-33 行）。
无需从 `.env.example` 重新生成。

## 3. 端口 8080 / 3000 占用鉴别（后续阶段避让依据）

**两个端口均被本仓库 dev server 占用**，身份判定采用 AGENTS.md 桌面编排器的监听者身份判别法
（gateway `/health` 的 `svc` 字段 / console 首页 `title`）：

```bash
$ curl -sS -m 5 http://localhost:8080/health
{"ok":true,"svc":"gateway","db":"up"}

$ curl -sS -m 5 http://localhost:3000/ | grep -oE '<title>[^<]*</title>'
<title>Dagents</title>
```

进程溯源（lsof + ps）：

| 端口 | PID | 进程 | cwd | 启动时间 |
|---|---|---|---|---|
| 127.0.0.1:8080 | 5282 | node（tsx，`--require tsx/dist/preflight.cjs ... src/index.ts`） | `/Users/rowan/Projects/dagents/apps/gateway` | 2026-10-07 20:11:31 |
| *:3000 | 5351 | `next-server (v15.5.20)` | `/Users/rowan/Projects/dagents/apps/console` | 2026-10-07 20:11:36 |

两者 PPID 分别为 5276 / 5345（各自的 pnpm/turbo 启动链），命令行与 cwd 表明均为**本仓库 dev 形态**
（gateway 为 tsx 直跑 `src/index.ts`，即 `pnpm --filter @dagents/gateway dev` 的产物）。

### 后续阶段必须遵守的避让约束

1. **不重启/不停止**这两个进程（本阶段任务纪律，已遵守）。
2. dev server 运行期间**禁跑 `pnpm build` / `pnpm --filter @dagents/console build`**——
   会覆盖 `apps/console/.next` 致 console 全站 500（AGENTS.md 已知问题）。
3. **长任务运行时禁并发全仓 build/test**——turbo 重建 `packages/*/dist` 会触发 gateway `tsx watch`
   自动重启，进行中的 run 连同 CLI 子进程被终止。
4. 需要访问 gateway/console 的操作一律**附加到现有实例**（8080/3000 固定端口纪律），不要另起。
5. gateway 单测走专用库 `dagents_gw_test`（vitest globalSetup 自动建），不碰 dev 库，可正常跑；
   e2e 栈如启用需自配端口并同步 `GATEWAY_URL`，避免与现有 dev 栈互踩。
