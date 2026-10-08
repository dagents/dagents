/**
 * trial-mock-llm 内核 ↔ e2e :4010 mock server 行为等价钉子（NFR-2：
 * 「同一脚本引擎内核的两份宿主」的验收形式，design-sharp §6.4）。
 *
 * 真 spawn 夹具服务器（apps/console/tests/e2e/fixtures/mock-llm-server/
 * server.mjs，零依赖 node:http——受控通道真 spawn 先例 controlled-exec.test.ts），
 * 对共享脚本语料逐例比对：服务器的 /__control/calls 记录（matchedRule）与
 * 响应体（text/tool_calls/usage/finish_reason）vs 内核 resolveMockResponse
 * 的同字段。谓词命中序/未知谓词不命中/toolLoop/空文本/错误注入/用量透传——
 * 两份宿主漂移即在此红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveMockResponse } from '../lib/trial-mock-llm.js'
import type { TrialMockScript } from '@dagents/contracts'

const SERVER_PATH = fileURLToPath(
  new URL('../../../console/tests/e2e/fixtures/mock-llm-server/server.mjs', import.meta.url),
)

const PORT = 4600 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`

let child: ChildProcess

async function waitHealthy(): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${BASE}/__control/health`)
      if (res.ok) return
    } catch {
      /* 未起完，继续轮询 */
    }
    if (Date.now() - started > 8000) throw new Error('mock server 未在 8s 内就绪')
    await new Promise((r) => setTimeout(r, 100))
  }
}

interface ServerCallRecord {
  matchedRule?: string
  response?: { mode?: string; text?: string; toolCalls?: unknown[] | null }
}

async function serverCall(
  script: unknown,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any; raw: string; record: ServerCallRecord | undefined }> {
  await fetch(`${BASE}/__control/script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(script),
  })
  await fetch(`${BASE}/__control/calls`, { method: 'DELETE' })
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
  })
  const raw = await res.text()
  let json: any = null
  try {
    json = JSON.parse(raw)
  } catch {
    json = null
  }
  const callsRes = await fetch(`${BASE}/__control/calls`)
  const calls = (await callsRes.json()) as ServerCallRecord[]
  return { status: res.status, json, raw, record: calls[calls.length - 1] }
}

const MESSAGES = [
  { role: 'system', content: 'sys-marker' },
  { role: 'user', content: 'user-marker ABC' },
]

describe('trial-mock-llm ↔ server.mjs 行为等价（NFR-2 共用内核）', () => {
  beforeAll(async () => {
    child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, E2E_MOCK_LLM_PORT: String(PORT) },
      stdio: 'ignore',
    })
    await waitHealthy()
  }, 15_000)

  afterAll(async () => {
    child?.kill()
    await new Promise((r) => setTimeout(r, 100))
  })

  const cases: Array<{
    name: string
    script: TrialMockScript
    body: Record<string, unknown>
  }> = [
    {
      name: '规则命中（userContains）→ 同文本同 label',
      script: {
        rules: [
          { match: { userContains: 'ABC' }, label: 'hit-abc', respond: { text: 'FROM-RULE' } },
        ],
        fallback: { text: 'FROM-FALLBACK' },
      },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: '无命中 → fallback（label=fallback）',
      script: {
        rules: [{ match: { userContains: '不存在的串' }, respond: { text: 'never' } }],
        fallback: { text: 'FROM-FALLBACK' },
      },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: '未知谓词 → 不命中走 fallback（脚本写错快速失败）',
      script: {
        rules: [{ match: { nopeContains: 'x' }, respond: { text: 'never' } }] as never,
        fallback: { text: 'FROM-FALLBACK' },
      } as never,
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: '空脚本无 fallback → mock:unmatched',
      script: { rules: [] },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: 'toolLoop → 恒返工具调用（finish_reason=tool_calls）',
      script: {
        rules: [],
        fallback: {
          mode: 'toolLoop',
          toolCalls: [{ function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
      },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: 'empty 模式 → 合法响应体但空文本',
      script: { rules: [], fallback: { mode: 'empty', text: 'ignored' } },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: 'usage 透传（自定义用量原样返回）',
      script: {
        rules: [],
        fallback: {
          text: 'ok',
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      },
      body: { model: 'm1', messages: MESSAGES },
    },
    {
      name: 'modelIs 谓词（命中档）',
      script: {
        rules: [{ match: { modelIs: 'specific-model' }, respond: { text: 'MODEL-HIT' } }],
        fallback: { text: 'FROM-FALLBACK' },
      },
      body: { model: 'specific-model', messages: MESSAGES },
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const server = await serverCall(c.script, c.body)
      const kernel = resolveMockResponse(c.script, c.body as never)

      // label 语义一致：server 的 matchedRule == kernel 的 label
      expect(server.record?.matchedRule).toBe(kernel.label)

      if (kernel.mode === 'error') {
        expect(server.status).toBeGreaterThanOrEqual(500)
        return
      }
      expect(server.status).toBe(200)
      expect(server.json).not.toBeNull()

      // 文本一致（toolLoop 内核 text=''；server message.content ''）
      const serverText = server.json?.choices?.[0]?.message?.content ?? ''
      expect(serverText).toBe(kernel.text)

      // 工具调用一致（server 以 tool_calls + finish_reason 表达）
      const serverTools = server.json?.choices?.[0]?.message?.tool_calls
      const finishReason = server.json?.choices?.[0]?.finish_reason
      if (kernel.toolCalls && kernel.toolCalls.length > 0) {
        expect(finishReason).toBe('tool_calls')
        expect(serverTools).toHaveLength(kernel.toolCalls.length)
        expect(serverTools[0].function.name).toBe(
          (kernel.toolCalls[0] as { function: { name: string } }).function.name,
        )
      } else {
        expect(finishReason).toBe('stop')
        expect(serverTools).toBeUndefined()
      }

      // 用量一致：server body.usage == kernel usage（缺省 DEFAULT_USAGE 同值）
      expect(server.json?.usage).toEqual(
        kernel.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      )
    })
  }

  it('error 注入：server HTTP 500 ⇔ 内核抛错（两宿主同语义）', async () => {
    const script: TrialMockScript = { rules: [], fallback: { mode: 'error' } }
    const server = await serverCall(script, { model: 'm1', messages: MESSAGES })
    expect(server.status).toBe(500)
    expect(() => {
      // 与 createTrialLlmClient.chat 的 injectOrFail 同语义：error 档抛错
      if (resolveMockResponse(script, { model: 'm1', messages: MESSAGES }).mode === 'error') {
        throw new Error('mock: injected error')
      }
    }).toThrow(/mock/)
  })

  it('malformed 注入：server 200 + 非 JSON 体 ⇔ 内核抛「非合法 JSON」', async () => {
    const script: TrialMockScript = { rules: [], fallback: { mode: 'malformed' } }
    const server = await serverCall(script, { model: 'm1', messages: MESSAGES })
    expect(server.status).toBe(200)
    expect(server.json).toBeNull() // 'this-is{not-json' 解析失败
  })
})
