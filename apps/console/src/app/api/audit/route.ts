/**
 * Console → gateway audit log proxy.
 *
 * The settings "审计日志" tab drives this route to browse the audit trail. The
 * browser never talks to the gateway directly: it calls this route, which
 * forwards to the gateway's `GET /api/v1/audit` endpoint. Same posture as the
 * other console proxy routes — the gateway URL stays server-side (no CORS, no
 * origin leak), and the `{ success, data?, error? }` envelope is piped through
 * verbatim.
 *
 * All query params (actorType / action / targetType / targetId / before /
 * limit) are forwarded unchanged via gatewayProxy's automatic search passthrough.
 */

import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// gatewayProxy auto-appends req.nextUrl.search, so we pass the bare path —
// the gateway receives the exact query string the browser sent.
export const GET = gatewayProxy('GET', '/api/v1/audit')
