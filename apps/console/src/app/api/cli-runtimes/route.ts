import { gatewayProxy } from '@/lib/gateway-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = gatewayProxy('GET', '/api/v1/cli-runtimes')
