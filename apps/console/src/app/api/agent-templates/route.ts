/**
 * Console → gateway agent-templates-list proxy.
 *
 * Forwards GET /api/agent-templates to the gateway's static template catalogue
 * (`/api/v1/agent-templates`), which returns the curated one-click agent
 * templates the gallery renders. Server-side proxy keeps the gateway URL
 * private and threads the run id + headers through.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/agent-templates')
