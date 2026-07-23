import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { context, trace } from '@opentelemetry/api'
import { createLogger, createTestTracing } from '../index.js'

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

// `withRunId` is exercised indirectly via `createLogger` inside an active span.
// These tests register a real test SDK so `currentRunId()` resolves and the
// logger merges the span's `run.id` into the pino context — the "日志关联"
// behavior `currentRunId()` was annotated for. Without a span, the logger
// leaves the caller's context untouched (no spurious `runId`).
describe('logger — run.id auto-binding from active span', () => {
  let tracing: ReturnType<typeof createTestTracing>
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    tracing = createTestTracing('logger-test')
    // Capture stdout so the pino log line is asserted on without spamming the
    // test runner. pino writes synchronously to its destination (stdout by
    // default), so intercepting `process.stdout.write` catches it.
    originalWrite = process.stdout.write.bind(process.stdout)
  })

  afterEach(async () => {
    process.stdout.write = originalWrite
    await tracing.shutdown()
  })

  it('attaches the active span run.id to a log line when the caller omits it', () => {
    const lines: string[] = []
    process.stdout.write = ((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write

    const log = createLogger({ svc: 'x' })
    const tracer = trace.getTracer('logger-test')
    tracer.startActiveSpan('run.span', async (span) => {
      span.setAttribute('run.id', 'run-log-1')
      log.info('hello', { step: 'a' })
      span.end()
    })

    const emitted = lines.find((l) => l.includes('"msg":"hello"'))
    expect(emitted).toBeDefined()
    const parsed = JSON.parse(emitted!)
    expect(parsed.runId).toBe('run-log-1')
    expect(parsed.step).toBe('a')
  })

  it('does not overwrite an explicit ctx.runId', () => {
    const lines: string[] = []
    process.stdout.write = ((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write

    const log = createLogger({ svc: 'x' })
    const tracer = trace.getTracer('logger-test')
    tracer.startActiveSpan('run.span', async (span) => {
      span.setAttribute('run.id', 'span-id')
      log.info('hello', { runId: 'explicit-id' })
      span.end()
    })

    const emitted = lines.find((l) => l.includes('"msg":"hello"'))
    const parsed = JSON.parse(emitted!)
    expect(parsed.runId).toBe('explicit-id')
  })

  it('leaves the context untouched when no span is active', () => {
    const lines: string[] = []
    process.stdout.write = ((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write

    const log = createLogger({ svc: 'x' })
    log.info('hello', { step: 'a' })

    const emitted = lines.find((l) => l.includes('"msg":"hello"'))
    const parsed = JSON.parse(emitted!)
    expect(parsed.runId).toBeUndefined()
    expect(parsed.step).toBe('a')
  })
})
