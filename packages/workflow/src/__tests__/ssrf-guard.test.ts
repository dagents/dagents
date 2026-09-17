import { describe, it, expect, afterEach } from 'vitest'
import { assertPublicHttpUrl, isPrivateHttpHost, privateHttpAllowed } from '../nodes/http/ssrf-guard.js'

describe('ssrf-guard: isPrivateHttpHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '[::1]',
    '::1',
    'fe80::1',
    'fc00::1234',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'my-service.local',
    'gateway.internal',
    'app.localhost',
  ])('%s is private', (host) => {
    expect(isPrivateHttpHost(host)).toBe(true)
  })

  it.each([
    'example.com',
    'api.openai.com',
    '8.8.8.8',
    '172.32.0.1', // 172.16/12 段之外
    '172.15.0.1',
    '192.169.1.1',
    '2606:4700::1111', // 公网 IPv6
  ])('%s is public', (host) => {
    expect(isPrivateHttpHost(host)).toBe(false)
  })
})

describe('ssrf-guard: assertPublicHttpUrl', () => {
  afterEach(() => {
    delete process.env.DAGENTS_HTTP_ALLOW_PRIVATE
  })

  it('rejects loopback and metadata targets', () => {
    expect(() => assertPublicHttpUrl(new URL('http://localhost:9200/_search'))).toThrow(/private\/local/)
    expect(() => assertPublicHttpUrl(new URL('http://169.254.169.254/latest/meta-data/'))).toThrow(/private\/local/)
    expect(() => assertPublicHttpUrl(new URL('http://127.0.0.1:8080/health'))).toThrow(/private\/local/)
  })

  it('allows public targets', () => {
    expect(() => assertPublicHttpUrl(new URL('https://api.example.com/v1'))).not.toThrow()
  })

  it('escape hatch DAGENTS_HTTP_ALLOW_PRIVATE=1 unlocks private targets', () => {
    process.env.DAGENTS_HTTP_ALLOW_PRIVATE = '1'
    expect(privateHttpAllowed()).toBe(true)
    expect(() => assertPublicHttpUrl(new URL('http://localhost:9200/_search'))).not.toThrow()
  })

  it('error message mentions the escape hatch', () => {
    try {
      assertPublicHttpUrl(new URL('http://10.0.0.1/admin'), 'http_request tool')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err instanceof Error && err.message).toContain('http_request tool')
      expect(err instanceof Error && err.message).toContain('DAGENTS_HTTP_ALLOW_PRIVATE')
    }
  })
})
