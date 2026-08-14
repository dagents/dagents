/**
 * Console → gateway daemons-list proxy.
 * Forwards to dispatch passthrough. Server-side proxy keeps the gateway URL
 * private and threads the run id + headers through.
 *
 * GET only — daemon processes self-register by POSTing the gateway's
 * /daemons/register directly; the console has no need to pre-register.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', '/api/v1/dispatch/daemons')
