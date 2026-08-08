import { Hono, type Context } from 'hono'
import { runQuery } from '@dagents/db'
import { createLogger } from '@dagents/shared'
import { decryptSecret } from '../crypto.js'

export const llmRoutes = new Hono()

const log = createLogger({ svc: 'gateway:llm' })

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
])

const ALLOW_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
])

const connectionListedFields = (connectionHeader: string | null | undefined): string[] => {
  if (!connectionHeader) return []
  return connectionHeader
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== 'close' && s !== 'keep-alive')
}

const fail = (c: Context, status: 400 | 502, error: string, extra?: Record<string, unknown>) =>
  c.json({ success: false, error, ...extra }, status)

interface LlmProviderRow {
  id: string
  base_url: string
  api_key: string
  status: string
}

function decodeApiKey(encoded: string): string {
  return decryptSecret(encoded)
}

async function getProviderById(id: string): Promise<LlmProviderRow | null> {
  const { records } = await runQuery<LlmProviderRow>(
    `SELECT id, base_url, api_key, status FROM llm_providers WHERE id = $1`,
    [id],
  )
  return records[0] ?? null
}

async function getFirstActiveProvider(): Promise<LlmProviderRow | null> {
  const { records } = await runQuery<LlmProviderRow>(
    `SELECT id, base_url, api_key, status FROM llm_providers WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`,
  )
  return records[0] ?? null
}

llmRoutes.all('/*', async (c) => {
  const inbound = new URL(c.req.url)
  const rest = inbound.pathname.replace(/^\/api\/v1\/llm\//, '')
  if (!rest || rest.includes('..')) {
    return fail(c, 400, 'unsupported llm path')
  }

  const providerId = c.req.header('x-llm-provider-id')
  let provider: LlmProviderRow | null

  try {
    if (providerId) {
      provider = await getProviderById(providerId)
    } else {
      provider = await getFirstActiveProvider()
    }
  } catch (err) {
    log.error('llm provider lookup failed', { error: String(err) })
    return fail(c, 502, 'provider lookup failed')
  }

  if (!provider) {
    return fail(c, 400, 'no llm provider available')
  }

  const method = c.req.method
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)

  const drop = new Set(DROP_REQUEST_HEADERS)
  for (const f of connectionListedFields(c.req.raw.headers.get('connection'))) {
    drop.add(f)
  }
  drop.add('authorization')

  const fwdHeaders = new Headers()
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (drop.has(k.toLowerCase())) continue
    fwdHeaders.set(k, v)
  }

  const decodedKey = decodeApiKey(provider.api_key)
  fwdHeaders.set('authorization', `Bearer ${decodedKey}`)

  const body = hasBody ? await c.req.text() : undefined

  const baseUrl = provider.base_url.endsWith('/') ? provider.base_url : `${provider.base_url}/`
  const upstreamUrl = new URL(rest, baseUrl)
  upstreamUrl.search = inbound.search

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method, headers: fwdHeaders, body })
  } catch (err) {
    log.error('llm upstream failed', { path: rest, method, providerId: provider.id, error: String(err) })
    return fail(c, 502, 'upstream unavailable')
  }

  if (upstream.status >= 500) {
    log.warn('llm upstream 5xx', { path: rest, method, providerId: provider.id, status: upstream.status })
    return fail(c, 502, 'upstream error', { upstreamStatus: upstream.status })
  }

  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers.entries()) {
    if (ALLOW_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders.set(k, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
})
