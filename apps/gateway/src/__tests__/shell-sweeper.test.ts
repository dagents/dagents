import { describe, it, expect } from 'vitest'

/**
 * 孤儿清扫器专项测试 —— 此前唯一零覆盖的生命周期路径（默认 60s 间隔 +
 * 10min 宽限根本跑不动测试）。压缩两个时间窗（env 在 import app 前设置，
 * registry 惰性读取）后实测三种命运：
 *
 *   1. 无订阅者 + 空闲超宽限 → kill + 移除（孤儿回收）
 *   2. 有订阅者 → 永不回收（旁观中的会话不是孤儿），且回来键入仍可用
 *   3. 已退出 → 保留一小段供重连看结果，宽限后移除
 *
 * 坑位记录：读活会话的 SSE 流必须有界（流因心跳永不结束，.text() 会挂）；
 * 竞速超时器必须在每次 read 落定后 clearTimeout —— 否则输掉的定时器稍后
 * reject 成 unhandled rejection，vitest 会把已成功的用例判死。
 */

process.env.DAGENTS_SHELL_SWEEP_INTERVAL_MS = '300'
process.env.DAGENTS_SHELL_ORPHAN_MS = '1500'
// win32 上 node-pty 需要 Windows 可执行文件；/bin/bash 仅在 POSIX 钉。
if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'

const { app } = await import('../app.js')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function createSession(): Promise<string> {
  const res = await app.request('/api/v1/shell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { sessionId: string } }).data.sessionId
}

async function listIds(): Promise<string[]> {
  const res = await app.request('/api/v1/shell')
  const body = (await res.json()) as { data: { sessions: Array<{ id: string }> } }
  return body.data.sessions.map((s) => s.id)
}

/** 打开一个保持订阅的流（订阅者在线 = 非孤儿）。 */
async function holdStream(id: string): Promise<() => void> {
  const res = await app.request(`/api/v1/shell/${id}/stream`)
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  void reader.read().catch(() => {}) // 首帧（hello）读完保持流不自动关
  return () => void reader.cancel().catch(() => {})
}

describe('shell orphan sweeper', () => {
  it('reaps an idle session with no subscribers after the grace window', async () => {
    const id = await createSession()
    expect(await listIds()).toContain(id)

    // bash 启动横幅最后一次输出后开始计空闲；1500ms 宽限 + 300ms 周期，
    // 4s 足以覆盖清扫点（CI 慢机也留了余量）
    await sleep(4000)
    expect(await listIds()).not.toContain(id)

    // 回收后所有操作如实 404
    const input = await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: '' }),
    })
    expect(input.status).toBe(404)
  }, 10_000)

  it('never reaps a session that has a live subscriber', async () => {
    const id = await createSession()
    const release = await holdStream(id)

    await sleep(4000) // 远超宽限 —— 有订阅者必须活着
    expect(await listIds()).toContain(id)

    // 而且活着可用：键入后重连读回放应见到回显。
    // 两个坑：活会话的 SSE 流因心跳永不结束（必须的有界读）；marker 藏在
    // base64 载荷里（断言前必须解帧 —— 对着线路原文 includes 永远 false）。
    await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('echo SWEEPER_ALIVE\r').toString('base64') }),
    })
    const stream2 = await app.request(`/api/v1/shell/${id}/stream`)
    expect(stream2.status).toBe(200)
    const reader2 = stream2.body!.getReader()
    const dec = new TextDecoder()
    let wire = ''
    let decoded = ''
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !decoded.includes('SWEEPER_ALIVE')) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const { done, value } = await Promise.race([
        reader2.read(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('read timeout')), Math.max(1, deadline - Date.now()))
        }),
      ]).finally(() => clearTimeout(timer))
      if (done) break
      wire += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = wire.indexOf('\n\n')) >= 0) {
        const block = wire.slice(0, idx)
        wire = wire.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const payload = JSON.parse(line.slice(6)) as { replay?: string; b64?: string }
            if (payload.replay) decoded += Buffer.from(payload.replay, 'base64').toString('utf8')
            if (payload.b64) decoded += Buffer.from(payload.b64, 'base64').toString('utf8')
          } catch {
            /* 非 JSON 行跳过 */
          }
        }
      }
    }
    void reader2.cancel().catch(() => {})
    expect(decoded.includes('SWEEPER_ALIVE')).toBe(true)

    release()
    await app.request(`/api/v1/shell/${id}`, { method: 'DELETE' })
  }, 12_000)

  it('retains an exited session briefly for reconnect, then removes it', async () => {
    const id = await createSession()
    await app.request(`/api/v1/shell/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from('exit 4\r').toString('base64') }),
    })

    // 刚退出：还在列表（重连可见 exited:true 与退出码）
    let seen = false
    for (let i = 0; i < 20 && !seen; i++) {
      await sleep(150)
      const res = await app.request('/api/v1/shell')
      const body = (await res.json()) as { data: { sessions: Array<{ id: string; exited: boolean }> } }
      seen = body.data.sessions.some((s) => s.id === id && s.exited)
    }
    expect(seen).toBe(true)

    // 宽限过后由清扫器移除
    await sleep(4000)
    expect(await listIds()).not.toContain(id)
  }, 12_000)
})
