/**
 * L2 生命周期测试（方案 C · spec §6.3）—— 假 CLI wrapper 回放真机行 +
 * 注入模式，走真实 `codexBackend.execute`。
 *
 * 移植 claude.lifecycle.test.ts 的 harness 模式：mkdtemp 写 harness.mjs +
 * wrapper.sh，`cfg.executablePath` 指向 wrapper，`MIL_FAKE_CODEX_MODE` 选
 * 行为。**行来源 = 读真机夹具回放**（spec D4：手编行 = 重演「按文档想象」
 * 的原罪；注入只做夹具给不了的进程级行为）。
 *
 * 注入模式（spec §6.3 三个）：
 *   - replay-fixture   真机 raw.ndjson 原样回放（happy/error 路径的 spawn
 *                      → readline → parse → queue → result 全链路）
 *   - hang             一行后挂死且 trap SIGTERM（超时/kill 升级路径钉子）
 *   - exit-nonzero-silent 非零退出且无终态帧（退出码映射缺口取证）
 *   - garbage-lines    非 JSON 噪声行（容错钉子）
 *
 * Unix-only（win32 无 /bin/sh，对齐 claude.lifecycle）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'

import * as path from 'node:path'
import * as os from 'node:os'
import * as url from 'node:url'
import { codexBackend } from './codex.js'
import type { AgentEvent } from '@dagents/contracts'

const isWindows = process.platform === 'win32'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const fixturesRoot = path.resolve(here, '../fixtures/codex')

/** Path to the wrapper script the adapter spawns (set in beforeAll). */
let wrapperPath = ''
/** 行为模式 → 回放哪份真机夹具（env 传给 harness）。 */
let fixtureDir = ''

beforeAll(async () => {
  if (isWindows) return
  const fs = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mil-fake-codex-'))
  const harness = path.join(dir, 'harness.mjs')
  wrapperPath = path.join(dir, 'wrapper.sh')

  await fs.writeFile(
    harness,
    `import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const mode = process.env.MIL_FAKE_CODEX_MODE
const fixture = process.env.MIL_FAKE_CODEX_FIXTURE
const out = (s) => process.stdout.write(s)

if (mode === 'replay-fixture') {
  // 真机 raw.ndjson 原样回放（byte-for-byte，含噪声行），退出码取 meta.json。
  const raw = readFileSync(fixture + '/raw.ndjson', 'utf8')
  const meta = JSON.parse(readFileSync(fixture + '/meta.json', 'utf8'))
  out(raw)
  process.exit(meta.exitCode ?? 0)
}
if (mode === 'replay-fixture-nonzero') {
  // 真机行回放但退出码强制非零（模拟「帧流正常却异常退出」——比手编更真实
  // 的进程级行为注入：行内容来自真机）。
  const raw = readFileSync(fixture + '/raw.ndjson', 'utf8')
  out(raw)
  process.exit(3)
}
if (mode === 'hang') {
  out(JSON.stringify({ type: 'thread.started', thread_id: 'th-hang' }) + '\\n')
  process.on('SIGTERM', () => {})   // trap SIGTERM → exercises SIGKILL escalation
  await sleep(60_000)
  process.exit(0)
}
if (mode === 'exit-nonzero-silent') {
  // 非零退出且零 stdout（无终态帧）—— spec §6.3 指定的语义缺口取证位。
  process.stderr.write('codex: catastrophic startup failure\\n')
  process.exit(127)
}
if (mode === 'garbage-lines') {
  // 非 JSON 噪声 + 真机成功帧混合（容错钉子：噪声行→log，正常行照常解析）。
  out('NOT-JSON at all\\n')
  out('\\u001b[2mansi dim noise\\u001b[0m\\n')
  out(JSON.stringify({ type: 'thread.started', thread_id: 'th-garbage' }) + '\\n')
  out(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'still fine' } }) + '\\n')
  out(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 } }) + '\\n')
  process.exit(0)
}
process.stderr.write('unknown mode: ' + mode + '\\n')
process.exit(64)
`,
  )
  await fs.writeFile(
    wrapperPath,
    `#!/bin/sh
# codex 形状的 argv（exec --json ... -- <prompt>）对 node 无害，但统一
# 忽略并经 env 选行为，与 claude.lifecycle 的 wrapper 模式一致。
exec "${process.execPath}" "${harness}"
`,
  )
  await chmod(wrapperPath, 0o755)
}, 60_000)

/** Collect all events from the stream into an array. */
async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

/** Backend pointed at the fake-codex wrapper; behavior via env. */
function fakeBackend(mode: string, fixtureScenario?: string) {
  const env: Record<string, string> = { MIL_FAKE_CODEX_MODE: mode }
  if (fixtureScenario) env.MIL_FAKE_CODEX_FIXTURE = path.join(fixturesRoot, fixtureScenario)
  return codexBackend({ executablePath: wrapperPath, env })
}

describe.skipIf(isWindows)('codexBackend execute lifecycle — 真机夹具回放', () => {
  // 动态发现夹具目录（同步 API——describe 体非 async；防夹具新增后 L2 漏跑）。
  const scenarios = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  it('ENOENT (missing binary) → failed result, no uncaughtException', async () => {
    const b = codexBackend({ executablePath: '/definitely/not/installed/codex-xyz' })
    const session = b.execute('hi', { timeoutMs: 5_000 })
    const result = await session.result
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/spawn failed/i)
    const evs = await collect(session.events)
    expect(evs).toEqual([])
  })

  for (const scenario of scenarios) {
    it(`replay ${scenario}: spawn→readline→parse→queue→result 全链路（真机行）`, async () => {
      const b = fakeBackend('replay-fixture', scenario)
      const session = b.execute('hi', { timeoutMs: 10_000 })
      const [events, result] = await Promise.all([collect(session.events), session.result])

      const meta = JSON.parse(
        await readFile(path.join(fixturesRoot, scenario, 'meta.json'), 'utf8'),
      ) as { exitCode: number | null }

      if (meta.exitCode === 0) {
        // 成功夹具：completed + sessionId + usage['codex'] 存在。
        expect(result.status).toBe('completed')
        expect(result.sessionId).toBeTruthy()
        expect(result.usage.codex).toBeDefined()
      } else {
        // 失败夹具（error-model-invalid）：failed + error 内容。
        expect(result.status).toBe('failed')
        expect(result.error ?? '').not.toBe('')
      }
      // 事件流必须终止（EOF）而非挂死；text/log/error 至少有产出。
      expect(events.length).toBeGreaterThan(0)
    }, 20_000)
  }

  it('replay single-turn: 标记串 + sessionId 端到端透出（dual-channel）', async () => {
    const b = fakeBackend('replay-fixture', 'single-turn')
    const session = b.execute('hi', {})
    const [events, result] = await Promise.all([collect(session.events), session.result])
    expect(result.status).toBe('completed')
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { content: string }).content)
    expect(texts.join('')).toContain('dagents-codex-ok')
    expect(result.sessionId).toBeTruthy()
    expect(result.usage.codex!.cacheReadTokens).toBeGreaterThanOrEqual(0)
  })

  it('replay error-model-invalid: 瞬态帧不毒化、终态 failed（全链路版）', async () => {
    const b = fakeBackend('replay-fixture', 'error-model-invalid')
    const session = b.execute('hi', {})
    const [events, result] = await Promise.all([collect(session.events), session.result])
    expect(result.status).toBe('failed')
    expect(result.error).toContain('not found')
    const reconnectLogs = events.filter(
      (e) => e.type === 'log' && (e as { content: string }).content.startsWith('Reconnecting'),
    )
    expect(reconnectLogs.length).toBeGreaterThan(0)
    const errorEvents = events.filter((e) => e.type === 'error')
    expect(errorEvents).toHaveLength(2)
  })
})

describe.skipIf(isWindows)('codexBackend execute lifecycle — 进程级注入', () => {
  it('hang: SIGTERM ignored → SIGKILL escalation resolves timeout', async () => {
    const b = fakeBackend('hang')
    const session = b.execute('hi', { timeoutMs: 300 })
    const result = await session.result
    expect(result.status).toBe('timeout')
    expect(result.error).toMatch(/timed out/)
  }, 15_000)

  it('exit-nonzero-silent: 非零退出且无终态帧 → failed + 退出码 + stderr 尾部', async () => {
    // spec §6.3 指定的取证位：帧流没给终态、进程又异常退出时，唯一的失败
    // 信号是退出码——钉住 stream-backend 现状（code≠0 → failed，stderr 尾
    // 部并入 error），若未来出现「既不 failed 也不报 stderr」的缺口在此红。
    const b = fakeBackend('exit-nonzero-silent')
    const session = b.execute('hi', {})
    const result = await session.result
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exited with code 127/)
    expect(result.error).toContain('catastrophic startup failure')
  })

  it('replay-fixture-nonzero: 帧流是成功形状但退出码非零 → 退出码优先（failed）', async () => {
    const b = fakeBackend('replay-fixture-nonzero', 'single-turn')
    const session = b.execute('hi', {})
    const result = await session.result
    // parseLine 全程 completed、无终态帧 → 收尾的 code!==0 分支接管。
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exited with code 3/)
  })

  it('garbage-lines: 非 JSON 噪声行 → log 容错，正常帧照常解析', async () => {
    const b = fakeBackend('garbage-lines')
    const session = b.execute('hi', {})
    const [events, result] = await Promise.all([collect(session.events), session.result])
    expect(result.status).toBe('completed')
    expect(result.sessionId).toBe('th-garbage')
    expect(result.output).toBe('still fine')
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as { content: string }).content)
    expect(logs.some((c) => c.includes('NOT-JSON'))).toBe(true)
    expect(logs.some((c) => c.includes('ansi dim'))).toBe(true)
    expect(result.usage.codex).toMatchObject({ inputTokens: 10, outputTokens: 3 })
  })

  it('cancel 路径钉子: AbortSignal → cancelled（cancellation.test.ts 已泛型覆盖，此处钉 codex argv 下接线）', async () => {
    const b = fakeBackend('hang')
    const ac = new AbortController()
    const session = b.execute('hi', { signal: ac.signal, inactivityTimeoutMs: 60_000 })
    setTimeout(() => ac.abort(), 150)
    const result = await session.result
    expect(result.status).toBe('cancelled')
  }, 15_000)
})
