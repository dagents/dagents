/**
 * Console → gateway daemons-list proxy.
 * Forwards to dispatch passthrough. Server-side proxy keeps the gateway URL
 * private and threads the SSO session cookie through.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/dispatch/daemons')
export const POST = gatewayProxy('POST', '/api/v1/dispatch/daemons/register')
