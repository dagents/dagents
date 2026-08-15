/**
 * Console → gateway chat search proxy.
 *
 * Forwards GET /api/chats/search?q=…&directory_id=…&limit=… to the gateway's
 * GET /api/v1/chats/search. The gateway does the ILIKE search across
 * chats.title and chat_messages.content and returns grouped results with
 * <mark>-wrapped snippets.
 *
 * The query string is threaded by gatewayProxy itself (it appends
 * req.nextUrl.search) — the path builder must NOT append it too, or the
 * upstream URL ends up with a doubled "?q=…?q=…" that matches nothing.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', () => '/api/v1/chats/search')
