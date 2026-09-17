import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { originAllowed, safeEqual } from '../auth.js'
import { checkExecutablePath } from '../lib/executable-path.js'
import { app } from '../app.js'

describe('auth: safeEqual', () => {
  it('matches identical strings and rejects mismatches without throwing', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true)
    expect(safeEqual('abc123', 'abc124')).toBe(false)
    expect(safeEqual('short', 'longer-string')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('auth: originAllowed (default-mode browser guard)', () => {
  const host = '127.0.0.1:8080'
  it('allows same-origin requests', () => {
    expect(originAllowed('http://127.0.0.1:8080', host)).toBe(true)
  })
  it('allows loopback origins on any port (console :3000, IAB webviews)', () => {
    expect(originAllowed('http://localhost:3000', host)).toBe(true)
    expect(originAllowed('http://127.0.0.1:5173', host)).toBe(true)
    expect(originAllowed('http://[::1]:3000', host)).toBe(true)
  })
  it('rejects foreign origins a malicious page would send', () => {
    expect(originAllowed('https://evil.example', host)).toBe(false)
    expect(originAllowed('http://evil.example:8080', host)).toBe(false)
    expect(originAllowed('null', host)).toBe(false)
    expect(originAllowed('not a url', host)).toBe(false)
  })
  it('honors GATEWAY_ALLOWED_ORIGINS extras', () => {
    process.env.GATEWAY_ALLOWED_ORIGINS = 'console.corp.example:443, https://tool.corp.example'
    try {
      expect(originAllowed('https://console.corp.example', host)).toBe(true)
      expect(originAllowed('https://other.corp.example', host)).toBe(false)
    } finally {
      delete process.env.GATEWAY_ALLOWED_ORIGINS
    }
  })
})

describe('lib: checkExecutablePath (spawn surface guard)', () => {
  it('accepts an existing absolute file (this test file itself)', () => {
    const p = new URL(import.meta.url).pathname
    const check = checkExecutablePath(p)
    expect(check.ok).toBe(true)
  })
  it('rejects relative paths, traversal and non-files', () => {
    expect(checkExecutablePath('claude').ok).toBe(false)
    expect(checkExecutablePath('../bin/claude').ok).toBe(false)
    expect(checkExecutablePath('/definitely/not/here/claude').ok).toBe(false)
    expect(checkExecutablePath('/tmp').ok).toBe(false) // 目录不是可执行文件
    expect(checkExecutablePath('').ok).toBe(false)
    expect(checkExecutablePath('/bin/ls\u0000x').ok).toBe(false)
  })
})

describe('app middleware: cross-origin browser guard', () => {
  beforeEach(() => {
    delete process.env.GATEWAY_API_KEY
  })
  afterEach(() => {
    delete process.env.GATEWAY_API_KEY
  })

  it('rejects requests carrying a foreign Origin even in open mode', async () => {
    const res = await app.request('/api/v1/runs', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain('cross-origin')
  })

  it('allows loopback origins through to the route layer', async () => {
    // 404 而非 403 = 通过了 Origin 门（路径不存在，未触达 DB）
    const res = await app.request('/definitely/not/a/route', {
      method: 'GET',
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(404)
  })

  it('requests without Origin (server-side / CLI clients) are unaffected', async () => {
    const res = await app.request('/definitely/not/a/route', { method: 'GET' })
    expect(res.status).toBe(404)
  })

  it('GATEWAY_API_KEY mode gates /api/v1/llm/* (whitelist removed 2026-09-17)', async () => {
    process.env.GATEWAY_API_KEY = 'x'.repeat(24)
    const res = await app.request('/api/v1/llm/chat/completions', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('/health stays public in key mode', async () => {
    process.env.GATEWAY_API_KEY = 'x'.repeat(24)
    const res = await app.request('/health')
    expect([200, 503]).toContain(res.status) // 503 = DB down，同样说明未挡在 auth 层
  })
})
