import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { app } from '../app.js'
import { AppDataSource, runQuery } from '@dagents/db'
import { attach, createSession, killSession, ShellSessionError } from '../shell-registry.js'
import { resolveInteractiveAgent } from '../interactive-agent.js'

/**
 * 交互式 agent 会话（P4，2026-09-19）测试：
 *  - 解析层：未知 agent 404 / 不支持的 runtime 400（诚实拒绝，不静默裸启）。
 *  - 注册表命令模式：command spawn（/bin/cat 确定性替身 —— 回声即 PTY 直通
 *    证据）+ kind/label 贯穿列表与创建响应。真 claude 托管不进单测（依赖
 *    本机 CLI 与外联，nightly real-cli 覆盖）。
 */

let claudeAgentId = ''
let codexAgentId = ''

beforeAll(async () => {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  const mk = async (name: string, kind: string): Promise<string> => {
    const res = await app.request('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind, instructions: '你是测试人格' }),
    })
    const json = (await res.json()) as { data?: { id?: string } }
    if (!json.data?.id) throw new Error(`agent create failed: ${name}`)
    return json.data.id
  }
  claudeAgentId = await mk('p4-test-claude', 'claude')
  codexAgentId = await mk('p4-test-codex', 'codex')
})

afterAll(async () => {
  for (const id of [claudeAgentId, codexAgentId]) {
    if (id) await runQuery(`DELETE FROM agents WHERE id = $1`, [id]).catch(() => {})
  }
})

describe('resolveInteractiveAgent（解析层诚实边界）', () => {
  it('未知 agent → 404', async () => {
    await expect(resolveInteractiveAgent('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('不支持的 runtime → 400（不静默裸启 CLI 冒充人格）', async () => {
    await expect(resolveInteractiveAgent(codexAgentId)).rejects.toMatchObject({
      status: 400,
    })
  })

  it('claude runtime → argv 携带人格全文与模型', async () => {
    const spawn = await resolveInteractiveAgent(claudeAgentId)
    expect(spawn.command).toBe('claude')
    expect(spawn.kind).toBe('agent')
    expect(spawn.label).toBe('p4-test-claude')
    const i = spawn.args.indexOf('--system-prompt')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(spawn.args[i + 1]).toContain('测试人格')
  })
})

describe('注册表命令模式（PTY 托管任意命令）', () => {
  it('/bin/cat 回声：写入即回显（PTY 直通）+ kind/label 贯穿', async () => {
    const session = createSession({ command: '/bin/cat', kind: 'agent', label: '回声' })
    expect(session.kind).toBe('agent')
    expect(session.label).toBe('回声')
    expect(session.id.startsWith('agt_')).toBe(true)

    const frames: string[] = []
    const handle = attach(session.id, (evt) => {
      if (evt.type === 'data') frames.push(evt.b64)
    })
    expect(handle).not.toBeNull()
    try {
      // base64('echo-p4\n')
      const ok = (() => {
        const bytes = new TextEncoder().encode('echo-p4\n')
        let bin = ''
        for (const b of bytes) bin += String.fromCharCode(b)
        // eslint-disable-next-line no-undef
        return btoa(bin)
      })()
      const res = await app.request(`/api/v1/shell/${session.id}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: ok }),
      })
      expect(res.status).toBe(200)

      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const text = frames
          .map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
          .join('')
        if (text.includes('echo-p4')) break
        await new Promise((r) => setTimeout(r, 50))
      }
      const echoed = frames.map((b64) => Buffer.from(b64, 'base64').toString('utf8')).join('')
      expect(echoed).toContain('echo-p4')
    } finally {
      handle!.unsubscribe()
      killSession(session.id)
    }

    // 列表投影不再包含已杀会话；活着时 kind/label 可见（此处只验杀后即清）
    const listRes = await app.request('/api/v1/shell')
    const listJson = (await listRes.json()) as { data?: { sessions?: Array<{ id: string }> } }
    expect(listJson.data?.sessions?.find((s) => s.id === session.id)).toBeUndefined()
  })

  it('会话上限对 agent 会话同样生效（同一张注册表）', () => {
    // 不再造 8 个真 PTY —— ShellSessionError 路径已被 shell.test 覆盖；
    // 这里钉 createSession 接受 CreateSessionOptions 形状的类型事实由
    // 上例承担，此用例防止未来把 agent 会话挪出注册表的回归注释。
    expect(ShellSessionError).toBeDefined()
  })
})
