/**
 * Integration tests for the `claudeBackend.execute` lifecycle — spawn, the
 * dual-channel events/result split, ENOENT, and timeout escalation.
 *
 * These run through the REAL `claudeBackend.execute` against a fake subprocess
 * so the spawn/pipe/parse/queue/timeout/ENOENT paths exercise actual
 * `child_process` + the production readline/queue code (covers the fixes for
 * code-reviewer review #1 spawn error/EPIPE, #2 dual-channel, #3 SIGKILL).
 *
 * Harness: a temp ESM script that emits stream-json lines. The adapter spawns
 * it via a shell wrapper that ignores the adapter's claude-shaped argv (node
 * would otherwise choke on `--print` as a node option); behavior is selected
 * by `MIL_FAKE_CLAUDE_MODE` so the wrapper needs no args itself.
 *
 * Unix-only (the Go reference also splits exec fixtures by platform); skipped
 * on win32 where `/bin/sh` is absent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { claudeBackend } from './claude.js'
import type { AgentEvent } from '@dagents/contracts'

const isWindows = process.platform === 'win32'

/** Path to the wrapper script the adapter spawns (set in beforeAll). */
let wrapperPath = ''
/** Argv-forwarding wrapper: passes "$@" through to the harness as script args. */
let wrapperArgvPath = ''

// Write the harness + a shell wrapper once. The wrapper ignores all argv and
// runs `node harness.mjs`, picking behavior from $MIL_FAKE_CLAUDE_MODE.
beforeAll(async () => {
  if (isWindows) return
  const path = await import('node:path')
  const os = await import('node:os')
  const fs = await import('node:fs/promises')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mil-fake-claude-'))
  const harness = path.join(dir, 'harness.mjs')
  wrapperPath = path.join(dir, 'wrapper.sh')
  await fs.writeFile(
    harness,
    `import { setTimeout as sleep } from 'node:timers/promises'
const mode = process.env.MIL_FAKE_CLAUDE_MODE
const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
if (mode === 'emit-lines') {
  // 1 system init + 4 assistant text + 1 result frame.
  line({ type: 'system', subtype: 'init', session_id: 'sess-fake' })
  for (let i = 1; i <= 4; i++) line({ type: 'assistant', message: { content: [{ type: 'text', text: 'E' + i }] } })
  line({ type: 'result', subtype: 'success', session_id: 'sess-fake', result: 'E1E2E3E4', is_error: false, modelUsage: { m: { inputTokens: 10, outputTokens: 4 } } })
  process.exit(0)
}
if (mode === 'hang') {
  line({ type: 'system', subtype: 'init', session_id: 'sess-hang' })
  process.on('SIGTERM', () => {})   // trap SIGTERM → exercises SIGKILL escalation
  await sleep(60_000)
  process.exit(0)
}
if (mode === 'silent') {
  // Emit init then go quiet (no SIGTERM trap) — exercises the inactivity
  // watchdog, distinct from the wall-clock 'hang' path above.
  line({ type: 'system', subtype: 'init', session_id: 'sess-silent' })
  await sleep(60_000)
  process.exit(0)
}
if (mode === 'flush-on-sigterm') {
  // Emit init, then stay silent until the inactivity watchdog fires. On EVERY
  // SIGTERM received, flush one assistant line — simulating a child that
  // dribbles buffered output during the kill grace. With the post-kill freeze
  // (killWithEscalation nulls inactivityTimer so resetInactivity is a no-op),
  // only the SIGKILL grace timer ends the run. Without that freeze, each
  // flushed line re-arms inactivity, which re-fires and resets the SIGKILL
  // timer every inactivity window — the run never escalates and hangs. So a
  // bounded resolve here pins "no re-arm after kill".
  line({ type: 'system', subtype: 'init', session_id: 'sess-flush' })
  let n = 0
  process.on('SIGTERM', () => {
    n++
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'flush' + n }] } })
  })
  await sleep(120_000)
  process.exit(0)
}
if (mode === 'echo-args') {
  // Emit the spawn argv (forwarded by the wrapper via $MIL_FAKE_CLAUDE_ARGV)
  // as one assistant text event + a result, so the resume test can assert
  // --resume reached the real child end-to-end. The wrapper can't pass the
  // claude-shaped flags to node directly (--print is a node option), so it
  // forwards them via env instead.
  const argv = JSON.stringify((process.env.MIL_FAKE_CLAUDE_ARGV || '').split(' ').filter(Boolean))
  line({ type: 'assistant', message: { content: [{ type: 'text', text: argv }] } })
  line({ type: 'result', subtype: 'success', session_id: 'sess-echo', result: 'ok', is_error: false })
  process.exit(0)
}
if (mode === 'exit-fast') {
  process.stderr.write('boom\\n')
  process.exit(1)
}
if (mode === 'multi-model') {
  // Two models in one run: assistant frames for modelA and modelB
  // (incremental usage), then a result frame whose modelUsage reports the
  // AUTHORITATIVE per-model totals. Verifies result.usage aggregates each
  // model independently through the real spawn→parse→aggregate loop.
  line({ type: 'system', subtype: 'init', session_id: 'sess-multi' })
  line({ type: 'assistant', message: { model: 'modelA', usage: { input_tokens: 3, output_tokens: 1 }, content: [{ type: 'text', text: 'A1' }] } })
  line({ type: 'assistant', message: { model: 'modelB', usage: { input_tokens: 4, output_tokens: 0 }, content: [{ type: 'text', text: 'B1' }] } })
  line({ type: 'assistant', message: { model: 'modelA', usage: { input_tokens: 2, output_tokens: 2 }, content: [{ type: 'text', text: 'A2' }] } })
  line({
    type: 'result', subtype: 'success', session_id: 'sess-multi',
    result: 'A1B1A2', is_error: false,
    modelUsage: {
      modelA: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 5 },
      modelB: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 8 },
    },
  })
  process.exit(0)
}
// MCP-injection probe: emit the claude-shaped argv we were spawned with as a
// JSON array in the result frame, so the test can assert --mcp-config and its
// path landed. Used with the argv-forwarding wrapper (wrapperArgvPath) below,
// which passes "$@" through after '--' so node treats them as script args
// (not node options) — that's why the main wrapper ignores argv.
if (mode === 'dump-argv') {
  line({ type: 'system', subtype: 'init', session_id: 'sess-argv' })
  line({ type: 'result', subtype: 'success', session_id: 'sess-argv', result: JSON.stringify(process.argv.slice(2)), is_error: false })
  process.exit(0)
}
`,
  )
  await fs.writeFile(
    wrapperPath,
    `#!/bin/sh
# node would choke on the adapter's claude-shaped argv (e.g. --print is a
# node option), so the wrapper ignores them as node args but forwards them
# via env so the echo-args mode can prove they reached the real spawn.
MIL_FAKE_CLAUDE_ARGV="$*" exec "${process.execPath}" "${harness}"
`,
  )
  await fs.chmod(wrapperPath, 0o755)
  // Argv-forwarding wrapper: for the MCP-injection probe we need the
  // adapter's argv to reach the harness. `node script` would treat flags like
  // `--print` as node options and choke; '"$@"' after '--' makes node pass
  // them through as script args, so process.argv.slice(2) recovers them.
  wrapperArgvPath = path.join(dir, 'wrapper-argv.sh')
  await fs.writeFile(
    wrapperArgvPath,
    `#!/bin/sh
exec "${process.execPath}" "${harness}" -- "$@"
`,
  )
  await fs.chmod(wrapperArgvPath, 0o755)
}, 60_000)

/** Collect all events from the stream into an array. */
async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

/** Backend pointed at the fake-claude wrapper; picks behavior via env. */
function fakeBackend(mode: string) {
  return claudeBackend({
    executablePath: wrapperPath,
    env: { MIL_FAKE_CLAUDE_MODE: mode },
  })
}

/** Like fakeBackend but uses the argv-forwarding wrapper (for MCP probe). */
function fakeArgvBackend(mode: string) {
  return claudeBackend({
    executablePath: wrapperArgvPath,
    env: { MIL_FAKE_CLAUDE_MODE: mode },
  })
}

describe.skipIf(isWindows)('claudeBackend execute lifecycle', () => {
  it('ENOENT (missing binary) → failed result, no uncaughtException', async () => {
    const b = claudeBackend({ executablePath: '/definitely/not/installed/claude-xyz' })
    const session = b.execute('hi', { timeoutMs: 5_000 })
    const result = await session.result
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/spawn failed/i)
    // events must still terminate (EOF) rather than hang.
    const evs = await collect(session.events)
    expect(evs).toEqual([])
  })

  it('timeout: SIGTERM ignored → SIGKILL resolves result as timeout', async () => {
    // The prod grace is 5s; this test asserts the escalation path fires and
    // resolves, not the exact latency, so allow headroom for SIGKILL + reap.
    const b = fakeBackend('hang')
    const session = b.execute('hi', { timeoutMs: 300 })
    const result = await session.result
    expect(result.status).toBe('timeout')
    expect(result.error).toMatch(/timed out/)
  }, 15_000)

  it('non-zero exit → failed result with code + stderr tail', async () => {
    const b = fakeBackend('exit-fast')
    const session = b.execute('hi', {})
    const result = await session.result
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exited with code 1/)
    expect(result.error).toContain('boom')
  })

  it('happy path: events stream + result aggregated, dual-channel', async () => {
    const b = fakeBackend('emit-lines')
    const session = b.execute('hi', {})

    // Pull events concurrently with awaiting result — the #2 regression case.
    // Under the old single-generator design, result's drain would steal events
    // from this consumer; here every event must survive.
    const [events, result] = await Promise.all([collect(session.events), session.result])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('E1E2E3E4')
    expect(result.sessionId).toBe('sess-fake')
    expect(result.usage).toMatchObject({ m: { inputTokens: 10, outputTokens: 4 } })

    // 1 started + 4 text + 1 completed = 6 surfaced events.
    const texts = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { content: string }).content)
    expect(texts).toEqual(['E1', 'E2', 'E3', 'E4'])
    expect(events.filter((e) => e.type === 'status')).toHaveLength(2)
  })

  it('result-only drain: awaiting result without iterating events still completes', async () => {
    const b = fakeBackend('emit-lines')
    const session = b.execute('hi', {})
    // Do NOT iterate events — the run must still complete and produce a result.
    const result = await session.result
    expect(result.status).toBe('completed')
    expect(result.output).toBe('E1E2E3E4')
  })

  it('multi-model: result.usage aggregates each model independently (不串/不丢)', async () => {
    // Two models (modelA, modelB) each carry their own token totals in the
    // result's modelUsage. The incremental assistant-frame usage (small
    // numbers) must be REPLACED by the authoritative per-model totals (large
    // numbers), and the two models must never bleed into each other.
    const b = fakeBackend('multi-model')
    const session = b.execute('hi', { model: 'modelA' })

    const [events, result] = await Promise.all([collect(session.events), session.result])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('A1B1A2')
    expect(result.sessionId).toBe('sess-multi')
    expect(result.usage).toEqual({
      modelA: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5 },
      modelB: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 8, cacheWriteTokens: 0 },
    })
    // The incremental counts (3/4/2) must NOT survive the result-frame reset.
    expect(result.usage.modelA.inputTokens).not.toBe(5)
    expect(result.usage.modelB.inputTokens).not.toBe(4)

    // Three assistant text events surfaced, in stream order.
    const texts = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { content: string }).content)
    expect(texts).toEqual(['A1', 'B1', 'A2'])
  })

  it('MCP: opts.mcpConfig 写临时文件 + --mcp-config <path> 透传到 spawn argv', async () => {
    const fs = await import('node:fs/promises')
    const mcp = { mcpServers: { fs: { command: 'npx', args: ['-y', 'srv'] } } }
    const b = fakeArgvBackend('dump-argv')
    const session = b.execute('hi', { mcpConfig: mcp })
    const result = await session.result
    expect(result.status).toBe('completed')
    // The probe JSON-encoded the argv (after the '--' separator) into result.
    const argv = JSON.parse(result.output) as string[]
    const idx = argv.indexOf('--mcp-config')
    expect(idx).toBeGreaterThan(-1)
    const mcpPath = argv[idx + 1]
    expect(mcpPath).toMatch(/mil-claude-mcp/)
    // The temp file carried our config. It may already be removed by the
    // run's finally-cleanup; the path-in-argv assertion above is the
    // authoritative injection proof, so a raced ENOENT is acceptable.
    try {
      const written = await fs.readFile(mcpPath, 'utf8')
      expect(JSON.parse(written)).toEqual(mcp)
    } catch (err) {
      // Acceptable: cleanup raced ahead. Anything other than not-found is a
      // real failure and will surface from the expect() below.
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
    }
  })

  it('MCP: 无 mcpConfig 时 argv 不含 --mcp-config（不创建空文件）', async () => {
    const b = fakeArgvBackend('dump-argv')
    const session = b.execute('hi', {})
    const result = await session.result
    expect(result.status).toBe('completed')
    const argv = JSON.parse(result.output) as string[]
    expect(argv).not.toContain('--mcp-config')
  })

  it('inactivity: silent child (emits init, then quiet) → aborted result', async () => {
    // No wall-clock timeout — only the inactivity watchdog guards this run,
    // so the assertion is unambiguous about which layer fired. The child
    // emits one init line (resetting the timer once) then goes silent; the
    // inactivity timer fires, kills the proc, and resolves `aborted`.
    const b = fakeBackend('silent')
    const session = b.execute('hi', { inactivityTimeoutMs: 300 })
    const result = await session.result
    expect(result.status).toBe('aborted')
    expect(result.error).toMatch(/no output for 300ms|stalled|inactivity|silent/i)
  }, 15_000)

  it('inactivity: a chatty run is never killed by the inactivity watchdog', async () => {
    // emit-lines streams 6 frames in well under the inactivity budget; the
    // timer resets on every line and never fires, so the run completes
    // normally — guards against a regression where the watchdog fires on a
    // healthy run (or a leaked timer trips a later run).
    const b = fakeBackend('emit-lines')
    const session = b.execute('hi', { inactivityTimeoutMs: 60_000 })
    const result = await session.result
    expect(result.status).toBe('completed')
    expect(result.output).toBe('E1E2E3E4')
  })

  it('both watchdogs: wall-clock fires first → status=timeout, inactivity cleared', async () => {
    // hang traps SIGTERM and emits nothing → only the wall-clock budget can
    // end this run. With both watchdogs armed, the wall-clock timer fires
    // first and calls killWithEscalation, which (post-LOW#1 fix) also clears
    // the inactivity timer. The run resolves `timeout` (the budget status),
    // NOT `aborted` — pinning the precedence `timedOut > stalled` and that the
    // inactivity watchdog does not independently fire to overwrite it.
    const b = fakeBackend('hang')
    const session = b.execute('hi', { timeoutMs: 300, inactivityTimeoutMs: 60_000 })
    const result = await session.result
    expect(result.status).toBe('timeout')
    expect(result.error).toMatch(/timed out/)
  }, 15_000)

  it('inactivity: flushed grace lines do not re-arm after kill → still aborted', async () => {
    // flush-on-sigterm emits init then stays silent until the inactivity
    // watchdog fires; on each SIGTERM it flushes one line. The post-kill
    // freeze (killWithEscalation nulls inactivityTimer) means resetInactivity
    // becomes a no-op, so the flushed lines do NOT re-arm inactivity and
    // restart the SIGKILL grace — the run still resolves `aborted` in bounded
    // time instead of hanging. Without the freeze this would loop forever.
    const b = fakeBackend('flush-on-sigterm')
    const session = b.execute('hi', { inactivityTimeoutMs: 300 })
    const result = await session.result
    expect(result.status).toBe('aborted')
    expect(result.error).toMatch(/no output for 300ms|stalled|inactivity|silent/i)
  }, 15_000)

  it('inactivity: inactivityTimeoutMs=0 / undefined → watchdog never arms', async () => {
    // emit-lines with NO inactivity budget must complete normally; a watchdog
    // that armed on a falsy/zero budget would be a regression. Covers both the
    // `> 0` guard and the `if (!inactivityTimer) return` early-out in
    // resetInactivity (called on every line) — neither may throw when the
    // timer was never created.
    const b = fakeBackend('emit-lines')
    const zero = b.execute('hi', { inactivityTimeoutMs: 0 })
    const zeroResult = await zero.result
    expect(zeroResult.status).toBe('completed')
    const undef = b.execute('hi', {})
    const undefResult = await undef.result
    expect(undefResult.status).toBe('completed')
  })

  it('resume: resumeSessionId → --resume <id> reaches the real spawn argv', async () => {
    // echo-args emits process.argv as a streamed text event. Pulling the
    // events stream (not just result) is what surfaces it end-to-end through
    // the real spawn + parse + queue path — the pure buildClaudeArgs unit
    // test only covers argv construction, not that execute threads it through.
    const b = fakeBackend('echo-args')
    const session = b.execute('hi', { resumeSessionId: 'sess-resume-xyz' })
    const events = await collect(session.events)
    const result = await session.result
    expect(result.status).toBe('completed')
    const textEvent = events.find((e) => e.type === 'text') as
      | { content: string }
      | undefined
    expect(textEvent).toBeDefined()
    // The child received the adapter's claude-shaped flags forwarded via env
    // (the wrapper can't pass them to node directly — `--print` is a node
    // option). Assert --resume + the id are present end-to-end.
    const argv = textEvent!.content.trim() ? JSON.parse(textEvent!.content) as string[] : []
    const resumeIdx = argv.indexOf('--resume')
    expect(resumeIdx).toBeGreaterThan(-1)
    expect(argv[resumeIdx + 1]).toBe('sess-resume-xyz')
  })
})
