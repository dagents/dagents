#!/usr/bin/env node
/**
 * Mock LLM Provider — 确定性 e2e 地基（docs/e2e-test-plan.md §4.1）。
 *
 * 两个面：
 *  1. OpenAI 兼容面 `POST /v1/chat/completions`——gateway 的 createLlmClient
 *     只消费这个端点（stream:false 返回 message.content/tool_calls + usage；
 *     stream:true 按 intervalMs 逐 delta 推 SSE + usage 尾帧 + [DONE]）。
 *  2. 控制面 `/__control/*`——测试编排：设置脚本（规则数组按序匹配）、读
 *     调用记录（「谁收到什么 prompt / 工具是否回灌 / 循环了几次」的协作
 *     证据）、清空状态。
 *
 * 零依赖（node:http），独立进程由 playwright webServer 数组拉起。
 */

import http from 'node:http'

const PORT = Number(process.env.E2E_MOCK_LLM_PORT ?? 4010)

/** @typedef {{ match?: Record<string, unknown>, label?: string, respond?: Record<string, unknown> }} Rule */
/** @typedef {{ rules: Rule[], fallback?: Record<string, unknown> }} Script */

/** @type {Script} */ let script = { rules: [] }
/** @type {Array<Record<string, unknown>>} */ let calls = []
let callSeq = 0

const DEFAULT_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

// ── 规则匹配 ─────────────────────────────────────────────────────────────
// match 谓词（全部满足才命中；对 messages 逐条扫描）：
//   systemContains / userContains / assistantContains — 对应 role 的消息 content 含子串
//   toolResultContains — role:'tool' 的消息含子串（工具循环第 2 轮的判据）
//   messagesContain   — 任意 role
//   hasToolResult     — messages 中是否存在 role:'tool'（true/false 都可指定）
//   modelIs           — body.model 精确相等
function matches(match, body) {
  if (!match) return true
  const messages = Array.isArray(body.messages) ? body.messages : []
  const contentOf = (role) =>
    messages
      .filter((m) => m && m.role === role && typeof m.content === 'string')
      .map((m) => m.content)
  const hasToolResult = messages.some((m) => m && m.role === 'tool')

  for (const [key, want] of Object.entries(match)) {
    switch (key) {
      case 'systemContains':
        if (!contentOf('system').some((c) => c.includes(want))) return false
        break
      case 'userContains':
        if (!contentOf('user').some((c) => c.includes(want))) return false
        break
      case 'assistantContains':
        if (!contentOf('assistant').some((c) => c.includes(want))) return false
        break
      case 'toolResultContains':
        if (!contentOf('tool').some((c) => c.includes(want))) return false
        break
      case 'messagesContain':
        if (!messages.some((m) => typeof m?.content === 'string' && m.content.includes(want))) return false
        break
      case 'hasToolResult':
        if (hasToolResult !== Boolean(want)) return false
        break
      case 'modelIs':
        if (body.model !== want) return false
        break
      default:
        return false // 未知谓词一律不命中，脚本写错时快速失败
    }
  }
  return true
}

function resolveResponse(body) {
  const rule = script.rules.find((r) => matches(r.match, body))
  const source = rule?.respond ?? script.fallback ?? { text: 'mock:unmatched' }
  const label = rule?.label ?? (rule ? `rule[${script.rules.indexOf(rule)}]` : 'fallback')
  // mode 扩展：toolLoop = 无视消息内容永远要工具（测 maxIterations 封顶）
  if (source.mode === 'toolLoop') {
    return { label, mode: 'ok', text: '', toolCalls: source.toolCalls ?? [] }
  }
  return {
    label,
    mode: source.mode ?? 'ok',
    text: source.text ?? '',
    toolCalls: source.toolCalls,
    usage: source.usage,
    delayMs: Number(source.delayMs ?? 0),
    // 流式调速透传（writeStream 的文档化参数 —— 此前投影漏掉这两个键，
    // 无论脚本设什么都走默认 8 字符/10ms，慢速流根本测不了）
    streamChunkSize: source.streamChunkSize,
    streamIntervalMs: source.streamIntervalMs,
  }
}

// ── OpenAI 兼容响应构造 ──────────────────────────────────────────────────
function completionBody(model, resolved) {
  const message = { role: 'assistant', content: resolved.text }
  if (resolved.toolCalls && resolved.toolCalls.length > 0) {
    message.tool_calls = resolved.toolCalls.map((tc, i) => ({
      id: tc.id ?? `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: tc.function?.name ?? 'unknown', arguments: tc.function?.arguments ?? '{}' },
    }))
  }
  return {
    id: `chatcmpl-mock-${callSeq}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'e2e-mock',
    choices: [
      {
        index: 0,
        message,
        finish_reason: resolved.toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: resolved.usage ?? DEFAULT_USAGE,
  }
}

/** stream:true — 按 chunkSize/intervalMs 切片逐帧推送（默认 8 字符 / 10ms）。 */
async function writeStream(res, model, resolved) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const text = resolved.text ?? ''
  const chunkSize = Math.max(1, Number(resolved.streamChunkSize ?? 8))
  const intervalMs = Math.max(0, Number(resolved.streamIntervalMs ?? 10))
  const chunks = []
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize))
  if (chunks.length === 0 && (!resolved.toolCalls || resolved.toolCalls.length === 0)) chunks.push('')
  let first = true
  for (const chunk of chunks) {
    if (!first && intervalMs > 0) await sleep(intervalMs)
    first = false
    const frame = {
      id: 'chatcmpl-mock-stream',
      object: 'chat.completion.chunk',
      model: model ?? 'e2e-mock',
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    }
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  if (resolved.toolCalls?.length) {
    // 流式工具调用帧（引擎 chatStream 目前只消费 delta.content，这里补齐形态）
    const frame = {
      id: 'chatcmpl-mock-stream',
      object: 'chat.completion.chunk',
      model: model ?? 'e2e-mock',
      choices: [
        {
          index: 0,
          delta: { tool_calls: resolved.toolCalls.map((tc, i) => ({ index: i, id: tc.id ?? `call_s_${i}`, type: 'function', function: tc.function })) },
          finish_reason: null,
        },
      ],
    }
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  // usage 尾帧（engine 侧 stream_options.include_usage）+ 终止帧
  res.write(`data: ${JSON.stringify({ choices: [], usage: resolved.usage ?? DEFAULT_USAGE })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // ---- 控制面 ----
  if (url.pathname === '/__control/health' && req.method === 'GET') {
    return json(200, { ok: true, calls: calls.length, rules: script.rules.length })
  }
  if (url.pathname === '/__control/script' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      script = typeof body === 'object' && body !== null ? body : { rules: [] }
      if (!Array.isArray(script.rules)) script = { ...script, rules: [] }
    } catch {
      return json(400, { error: 'script body must be JSON' })
    }
    return json(200, { ok: true, rules: script.rules.length })
  }
  if (url.pathname === '/__control/calls') {
    if (req.method === 'GET') return json(200, calls)
    if (req.method === 'DELETE') {
      calls = []
      return json(200, { ok: true, cleared: true })
    }
  }
  if (url.pathname === '/__control/reset' && req.method === 'POST') {
    script = { rules: [] }
    calls = []
    return json(200, { ok: true })
  }
  // 永不响应的端点（ED-07：HTTP 节点 15s 超时路径的确定性挂起点）
  if (url.pathname === '/__control/hang') {
    return // 不写头不结束 —— 读方只能靠自身超时
  }

  // ---- OpenAI 兼容面 ----
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch {
      return json(400, { error: 'invalid json' })
    }
    const resolved = resolveResponse(body)
    const record = {
      seq: ++callSeq, // 单调递增的调用序号，供顺序断言
      ts: new Date().toISOString(),
      model: body.model,
      messages: body.messages,
      tools: body.tools ?? null,
      stream: Boolean(body.stream),
      temperature: body.temperature ?? null,
      matchedRule: resolved.label,
    }
    calls.push(record)

    // 可控延迟：把同波次节点的执行窗口拉宽，让「并行重叠」断言不靠毫秒巧合
    if (resolved.delayMs > 0) await sleep(resolved.delayMs)

    // 错误/边界注入
    if (resolved.mode === 'error') {
      record.response = { mode: 'error', status: body.errorStatus ?? 500 }
      return json(body.errorStatus ?? 500, { error: { message: 'mock: injected error' } })
    }
    if (resolved.mode === 'malformed') {
      record.response = { mode: 'malformed' }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('this-is{not-json')
    }
    if (resolved.mode === 'empty') {
      record.response = { mode: 'empty', text: '' }
      return json(200, completionBody(body.model, { ...resolved, text: '' }))
    }
    if (resolved.mode === 'hang') {
      record.response = { mode: 'hang' }
      return // 挂起：不响应也不结束（ED-07 P2 用，读方靠自身超时）
    }

    record.response = { mode: 'ok', text: resolved.text, toolCalls: resolved.toolCalls ?? null }
    if (body.stream) return writeStream(res, body.model, resolved)
    return json(200, completionBody(body.model, resolved))
  }

  json(404, { error: `no route: ${req.method} ${url.pathname}` })
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw.length ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`)
})
