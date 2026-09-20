/**
 * Shell session API — 浏览器里的真终端（PTY → SSE）。
 *
 * 会话本体在 ../shell-registry.ts（node-pty 注册表）；这里只做 HTTP 投影：
 *
 * POST   /api/v1/shell                { cwd?, cols?, rows?, agentId? } → 新建 PTY 会话
 *        （agentId = P4 交互式 agent 会话：人格 CLI 托管在 PTY，解析见
 *         ../interactive-agent.ts —— claude v1，其余 runtime 诚实 400）
 * GET    /api/v1/shell                → 会话列表（前端恢复/接管用）
 * GET    /api/v1/shell/:id/stream     → SSE：hello(回放) / data(base64 块) / exit
 * POST   /api/v1/shell/:id/input      { data: base64 }      → 写入 PTY（键入/粘贴）
 * POST   /api/v1/shell/:id/resize     { cols, rows }        → 视口尺寸
 * DELETE /api/v1/shell/:id            → 杀会话并移除
 *
 * 输出用 base64 传输：PTY 原始字节流含 ANSI 转义与换行，SSE 的 data: 行
 * 装不下，base64 保真后由前端 xterm.js 解码直写（颜色/光标原样）。
 * GET stream 首帧 hello 带全量 replay —— 刷新/断线重连不丢历史。
 */

import fs from 'node:fs'
import os from 'node:os'
import { type Context, Hono } from 'hono'
import type { ShellSessionCreated, ShellSessionList } from '@dagents/contracts'
import { resolveInteractiveAgent } from '../interactive-agent.js'
import {
  ShellSessionError,
  attach,
  createSession,
  getSession,
  killSession,
  listSessions,
  resizeSession,
  shellDisabled,
  writeInput,
} from '../shell-registry.js'
import { ensureSweeper } from '../shell-registry.js'

export const shellRoutes = new Hono()

function disabled(c: Context) {
  return c.json({ success: false, error: 'shell sessions disabled (DAGENTS_SHELL_DISABLED=1)' }, 403)
}

shellRoutes.get('/', (c) => {
  if (shellDisabled()) return disabled(c)
  // home 一并返回：前端做 cwd 的 ~ 折叠显示；label null 剥离（契约可选字段）
  const payload: ShellSessionList = {
    home: os.homedir(),
    sessions: listSessions().map(({ label, ...rest }) => ({
      ...rest,
      ...(label != null ? { label } : {}),
    })),
  }
  return c.json({ success: true, data: payload })
})

shellRoutes.post('/', async (c) => {
  if (shellDisabled()) return disabled(c)
  ensureSweeper()

  const body = (await c.req.json().catch(() => ({}))) as {
    cwd?: unknown
    cols?: unknown
    rows?: unknown
    /** P4 交互式 agent 会话：agent id（人格 CLI 托管在 PTY）。 */
    agentId?: unknown
  }

  let cwd: string | undefined
  if (typeof body.cwd === 'string' && body.cwd.trim()) {
    cwd = body.cwd.trim()
    let st: fs.Stats
    try {
      st = fs.statSync(cwd)
    } catch {
      return c.json({ success: false, error: 'cwd 不存在', cwd }, 400)
    }
    if (!st.isDirectory()) {
      return c.json({ success: false, error: 'cwd 不是目录', cwd }, 400)
    }
  }

  // P4：agentId → 人格 CLI argv（不可支持时 4xx 诚实拒绝，不静默降级）
  let agentSpawn: Awaited<ReturnType<typeof resolveInteractiveAgent>> | undefined
  if (typeof body.agentId === 'string' && body.agentId.trim()) {
    try {
      agentSpawn = await resolveInteractiveAgent(body.agentId.trim())
    } catch (err) {
      if (err instanceof ShellSessionError) {
        return c.json({ success: false, error: err.message }, err.status as 400 | 404)
      }
      throw err
    }
  }

  try {
    const session = createSession({
      cwd,
      cols: typeof body.cols === 'number' ? body.cols : undefined,
      rows: typeof body.rows === 'number' ? body.rows : undefined,
      ...(agentSpawn
        ? { command: agentSpawn.command, args: agentSpawn.args, kind: agentSpawn.kind, label: agentSpawn.label }
        : {}),
    })
    const payload: ShellSessionCreated = {
      sessionId: session.id,
      cwd: session.cwd,
      home: os.homedir(),
      cols: session.cols,
      rows: session.rows,
      ...(session.kind !== 'shell' || session.label != null
        ? { kind: session.kind, label: session.label ?? undefined }
        : {}),
    }
    return c.json({ success: true, data: payload })
  } catch (err) {
    if (err instanceof ShellSessionError) {
      return c.json({ success: false, error: err.message }, err.status as 403 | 429 | 500)
    }
    throw err
  }
})

shellRoutes.get('/:id/stream', (c) => {
  if (shellDisabled()) return disabled(c)
  const id = c.req.param('id')
  if (!getSession(id)) {
    return c.json({ success: false, error: 'shell session not found', id }, 404)
  }

  const encoder = new TextEncoder()
  const signal = c.req.raw.signal

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (event: string, payload: unknown) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          )
        } catch {
          closed = true
        }
      }

      // 原子订阅 + 回放快照（见 registry.attach 注释）：hello 带历史，随后实时流。
      // exited/cols/rows 必须取 attach 之后的会话状态 —— getSession 与 attach
      // 之间若进程退出，旧快照会把已死会话报成 live。
      const handle = attach(id, (evt) => {
        if (evt.type === 'data') send('data', { b64: evt.b64 })
        else send('exit', { code: evt.code })
      })
      if (!handle) {
        try {
          controller.close()
        } catch {
          /* 已关 */
        }
        return
      }
      const session = handle.session
      // replay 与 data 帧同契约：base64（二进制安全）—— 前端按 base64 解码直写
      send('hello', {
        replay: Buffer.from(handle.replay, 'utf8').toString('base64'),
        exited: session.exited,
        cols: session.cols,
        rows: session.rows,
      })
      if (session.exited) {
        send('exit', { code: session.exitCode ?? 0 })
      }

      // SSE 保活注释行：防中间层（Next dev 代理等）掐空闲连接；15s 足够
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          closed = true
        }
      }, 15_000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        handle.unsubscribe()
        try {
          controller.close()
        } catch {
          /* 客户端已断开 */
        }
      }
      // 客户端断开（关页/导航）即退订；会话本体留给孤儿回收器按宽限处理
      signal.addEventListener('abort', cleanup, { once: true })
    },
  })

  c.header('content-type', 'text/event-stream')
  c.header('cache-control', 'no-cache')
  c.header('x-accel-buffering', 'no')
  return c.body(readable)
})

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

shellRoutes.post('/:id/input', async (c) => {
  if (shellDisabled()) return disabled(c)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { data?: unknown } | null
  if (!body || typeof body.data !== 'string' || !B64_RE.test(body.data)) {
    return c.json({ success: false, error: 'body must be { data: base64 }' }, 400)
  }
  if (!writeInput(id, body.data)) {
    return c.json({ success: false, error: 'shell session not found or exited', id }, 404)
  }
  return c.json({ success: true, data: {} })
})

shellRoutes.post('/:id/resize', async (c) => {
  if (shellDisabled()) return disabled(c)
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { cols?: unknown; rows?: unknown } | null
  if (!body || typeof body.cols !== 'number' || typeof body.rows !== 'number') {
    return c.json({ success: false, error: 'body must be { cols: number, rows: number }' }, 400)
  }
  // 会话不存在/已退出时如实 404，不假装成功
  if (!resizeSession(id, body.cols, body.rows)) {
    return c.json({ success: false, error: 'shell session not found or exited', id }, 404)
  }
  return c.json({ success: true, data: {} })
})

shellRoutes.delete('/:id', (c) => {
  if (shellDisabled()) return disabled(c)
  const id = c.req.param('id')
  if (!killSession(id)) {
    return c.json({ success: false, error: 'shell session not found', id }, 404)
  }
  return c.json({ success: true, data: {} })
})
