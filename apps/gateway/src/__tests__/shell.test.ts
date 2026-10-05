import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'

/**
 * Shell 会话（浏览器终端）路由测试：真 PTY、真 shell —— 不 mock node-pty，
 * 走 app.request 全链路（SSE 流解析 = 前端同款语义）。
 *
 * SHELL 钉到平台默认保证确定性：POSIX 是 /bin/bash（CI 容器与 dev 机默认
 * zsh 配置各异，bash 的提示符/启动输出最可预测；macOS 自带 bash 3.2，
 * Linux 常见 5.x，断言只用两者共有的行为 echo / exit code）。win32 上
 * node-pty 需要 Windows 可执行文件 —— 用 PowerShell（shell-registry 的
 * 同款平台默认），输入行同样以 
 结尾，两者语义一致。
 */

const ORIG_SHELL = process.env.SHELL

beforeAll(() => {
  if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'
})

afterAll(() => {
  if (ORIG_SHELL === undefined) delete process.env.SHELL
  else process.env.SHELL = ORIG_SHELL
})

interface StreamFrame {
  event: string
  data: Record<string, unknown>
}

/** 持续打开的 SSE 帧读取器：多次 until() 复用同一 reader（无 tee 背压）。 */
class FrameReader {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private decoder = new TextDecoder()
  private buf = ''

  constructor(res: Response) {
    if (!res.body) throw new Error('no stream body')
    this.reader = res.body.getReader()
  }

  /** 逐帧推进，直到 predicate 命中或超时（不关流，可继续读）。 */
  async until(predicate: (frame: StreamFrame) => boolean, timeoutMs = 8000): Promise<StreamFrame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        this.reader!.read(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('frame read timeout')), Math.max(1, deadline - Date.now())),
        ),
      ])
      if (done) break
      this.buf += this.decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = this.buf.indexOf('\n\n')) >= 0) {
        const block = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        if (!block || block.startsWith(':')) continue
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (!data) continue
        const frame: StreamFrame = { event, data: JSON.parse(data) as Record<string, unknown> }
        if (predicate(frame)) return frame
      }
    }
    throw new Error('expected SSE frame not observed before timeout')
  }

  close(): void {
    void this.reader?.cancel().catch(() => {})
    this.reader = null
  }
}

async function createSession(cwd?: string): Promise<string> {
  const res = await app.request('/api/v1/shell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cwd ? { cwd } : {}),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { success: boolean; data: { sessionId: string } }
  expect(body.success).toBe(true)
  return body.data.sessionId
}

/** 轮询列表直到会话标记 exited（PTY 退出是异步的）。 */
async function waitForExited(id: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await app.request('/api/v1/shell')
    const list = (await res.json()) as {
      data: { sessions: Array<{ id: string; exited: boolean }> }
    }
    if (list.data.sessions.find((s) => s.id === id)?.exited) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('session did not exit in time')
}

/** 清掉注册表内全部残留会话（已退出的也占会话计数，影响上限类用例）。 */
async function drainSessions(): Promise<void> {
  const res = await app.request('/api/v1/shell')
  const list = (await res.json()) as {
    data: { sessions: Array<{ id: string }> }
  }
  for (const s of list.data.sessions) {
    await app.request(`/api/v1/shell/${s.id}`, { method: 'DELETE' })
  }
}

describe('shell sessions', () => {
  it('creates a session and lists it', async () => {
    const id = await createSession()
    expect(id.startsWith('shl_')).toBe(true)

    const listRes = await app.request('/api/v1/shell')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as {
      data: { sessions: Array<{ id: string; exited: boolean }> }
    }
    expect(list.data.sessions.some((s) => s.id === id && !s.exited)).toBe(true)

    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  })

  it('rejects a non-existent cwd', async () => {
    const res = await app.request('/api/v1/shell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/definitely/not/a/real/dir' }),
    })
    expect(res.status).toBe(400)
  })

  it('streams hello + live output, and input reaches the PTY', async () => {
    const id = await createSession()
    const streamRes = await app.request(`/api/v1/shell/${id}/stream`)
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream')
    const frames = new FrameReader(streamRes)

    // hello 帧先到（含回放字段，前端重连语义）
    const hello = await frames.until((f) => f.event === 'hello', 3000)
    expect(typeof hello.data.replay).toBe('string')

    // 键入 → PTY 执行 → 输出回流（echo 输出被 data 帧带回）
    const inputRes = await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('echo SHELL_E2E_MARKER_7f3\r').toString('base64') }),
    })
    expect(inputRes.status).toBe(200)

    const echoFrame = await frames.until((f) => {
      if (f.event !== 'data') return false
      const text = Buffer.from(String(f.data.b64 ?? ''), 'base64').toString('utf8')
      return text.includes('SHELL_E2E_MARKER_7f3')
    })
    expect(echoFrame.event).toBe('data')
    frames.close()

    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  })

  it('DELETE kills the session and input then 404s', async () => {
    const id = await createSession()
    const del = await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const listRes = await app.request('/api/v1/shell')
    const list = (await listRes.json()) as {
      data: { sessions: Array<{ id: string }> }
    }
    expect(list.data.sessions.some((s) => s.id === id)).toBe(false)

    const inputRes = await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('ls\r').toString('base64') }),
    })
    expect(inputRes.status).toBe(404)
  })

  it('exit event fires when the shell process exits', async () => {
    const id = await createSession()
    const streamRes = await app.request(`/api/v1/shell/${id}/stream`)
    expect(streamRes.status).toBe(200)
    const frames = new FrameReader(streamRes)
    await frames.until((f) => f.event === 'hello', 3000)

    await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('exit 3\r').toString('base64') }),
    })

    const exitFrame = await frames.until((f) => f.event === 'exit')
    expect(exitFrame.data.code).toBe(3)
    frames.close()

    // 会话已退出：后续输入明确 404（不静默丢弃）
    const inputRes = await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('ls\r').toString('base64') }),
    })
    expect(inputRes.status).toBe(404)
  })
})

describe('shell session guards', () => {
  it('rejects malformed input/resize bodies and unknown sessions', async () => {
    const id = await createSession()

    // input：缺字段 / 非 base64 / 非 JSON
    for (const body of ['{}', JSON.stringify({ data: 'not base64!!!' }), 'garbage']) {
      const res = await app.request(`/api/v1/shell/${id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      expect(res.status).toBe(400)
    }

    // resize：缺字段 / 非数值
    const badResize = await app.request(`/api/v1/shell/${id}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 'wide' }),
    })
    expect(badResize.status).toBe(400)

    // 未知会话：如实 404（input 与 resize 一致）
    const unknownInput = await app.request('/api/v1/shell/shl_nonexistent/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('ls\r').toString('base64') }),
    })
    expect(unknownInput.status).toBe(404)
    const unknownResize = await app.request('/api/v1/shell/shl_nonexistent/resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    })
    expect(unknownResize.status).toBe(404)
    const unknownStream = await app.request('/api/v1/shell/shl_nonexistent/stream')
    expect(unknownStream.status).toBe(404)

    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  })

  it('enforces the session cap (429)', async () => {
    await drainSessions()
    process.env.DAGENTS_SHELL_MAX_SESSIONS = '2'
    try {
      const a = await createSession()
      const b = await createSession()
      const res = await app.request('/api/v1/shell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(res.status).toBe(429)
      const body = (await res.json()) as { success: boolean; error: string }
      expect(body.success).toBe(false)
      expect(body.error).toContain('too many shell sessions')
      await app.request(`/api/v1/shell/${a}`, { method: 'DELETE' })
      await app.request(`/api/v1/shell/${b}`, { method: 'DELETE' })
    } finally {
      delete process.env.DAGENTS_SHELL_MAX_SESSIONS
    }
  })

  it('hello reports exited=true for an already-dead session (attach 竞态回归)', async () => {
    const id = await createSession()
    await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('exit 7\r').toString('base64') }),
    })
    await waitForExited(id)

    // 退出后订阅：hello 必须如实报 exited，且补发 exit 帧 —— 否则前端假活
    const streamRes = await app.request(`/api/v1/shell/${id}/stream`)
    expect(streamRes.status).toBe(200)
    const frames = new FrameReader(streamRes)
    const hello = await frames.until((f) => f.event === 'hello', 3000)
    expect(hello.data.exited).toBe(true)
    const exitFrame = await frames.until((f) => f.event === 'exit', 3000)
    expect(exitFrame.data.code).toBe(7)
    frames.close()

    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  })

  it('replays history to a reconnecting subscriber', async () => {
    const id = await createSession()
    const first = new FrameReader(await app.request(`/api/v1/shell/${id}/stream`))
    await first.until((f) => f.event === 'hello', 3000)

    await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('echo REPLAY_UNIT_MARKER\r').toString('base64') }),
    })
    await first.until((f) => {
      if (f.event !== 'data') return false
      return Buffer.from(String(f.data.b64 ?? ''), 'base64').toString('utf8').includes('REPLAY_UNIT_MARKER')
    })
    first.close() // 断开（模拟刷新页面）

    const second = new FrameReader(await app.request(`/api/v1/shell/${id}/stream`))
    const hello = await second.until((f) => f.event === 'hello', 3000)
    const replay = Buffer.from(String(hello.data.replay ?? ''), 'base64').toString('utf8')
    expect(replay.includes('REPLAY_UNIT_MARKER')).toBe(true)
    expect(hello.data.exited).toBe(false)
    second.close()

    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  })

  it('DAGENTS_SHELL_DISABLED=1 gates every endpoint with 403', async () => {
    process.env.DAGENTS_SHELL_DISABLED = '1'
    try {
      const post = await app.request('/api/v1/shell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(post.status).toBe(403)
      const list = await app.request('/api/v1/shell')
      expect(list.status).toBe(403)
      const stream = await app.request('/api/v1/shell/shl_any/stream')
      expect(stream.status).toBe(403)
      const input = await app.request('/api/v1/shell/shl_any/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: '' }),
      })
      expect(input.status).toBe(403)
      const resize = await app.request('/api/v1/shell/shl_any/resize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      })
      expect(resize.status).toBe(403)
      const del = await app.request('/api/v1/shell/shl_any', { method: 'DELETE' })
      expect(del.status).toBe(403)
    } finally {
      delete process.env.DAGENTS_SHELL_DISABLED
    }
  })
})
