/**
 * Console → gateway chat search proxy.
 *
 * Forwards GET /api/chats/search?q=…&directory_id=…&limit=… to the gateway's
 * GET /api/v1/chats/search, threading the query string through unchanged.
 * The gateway does the ILIKE search across chats.title and chat_messages.content
 * and returns grouped results with <mark>-wrapped snippets.
 */
import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = gatewayProxy('GET', (req) => `/api/v1/chats/search${new URL(req.url).search}`)
