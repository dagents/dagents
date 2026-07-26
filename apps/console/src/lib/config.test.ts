import { describe, it, expect, afterEach } from 'vitest'
import { flowiseEditorUrl } from './config'

/**
 * Unit tests for flowiseEditorUrl() (plan M0.3 / M2.3 前置).
 *
 * The console embeds the Flowise canvas editor in an `<iframe>`; this resolver
 * is the iframe SRC side of that wiring. Its mirror, the CSP `frame-ancestors`
 * side, lives on the Flowise server (IFRAME_ORIGINS — see vendor/flowise/
 * packages/server/.env.dagents). These pin the default + override + the
 * trailing-slash normalization the iframe src relies on, without booting Next.
 */
describe('flowiseEditorUrl', () => {
  const orig = process.env.FLOWISE_EDITOR_URL

  afterEach(() => {
    if (orig === undefined) delete process.env.FLOWISE_EDITOR_URL
    else process.env.FLOWISE_EDITOR_URL = orig
  })

  it('defaults to the vendored Flowise on :3100 when unset', () => {
    delete process.env.FLOWISE_EDITOR_URL
    expect(flowiseEditorUrl()).toBe('http://localhost:3100')
  })

  it('reads FLOWISE_EDITOR_URL when set', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://flowise.local:3101'
    expect(flowiseEditorUrl()).toBe('http://flowise.local:3101')
  })

  it('strips a single trailing slash', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://localhost:3100/'
    expect(flowiseEditorUrl()).toBe('http://localhost:3100')
  })

  it('strips multiple trailing slashes', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://localhost:3100///'
    expect(flowiseEditorUrl()).toBe('http://localhost:3100')
  })

  it('preserves a path when the env includes one', () => {
    process.env.FLOWISE_EDITOR_URL = 'http://localhost:3100/flowise/'
    expect(flowiseEditorUrl()).toBe('http://localhost:3100/flowise')
  })
})
