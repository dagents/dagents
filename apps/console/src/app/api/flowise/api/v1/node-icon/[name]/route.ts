import { NextResponse } from 'next/server'

const ICON_COLORS: Record<string, string> = {
  startAgentflow: '#10b981',
  agentAgentflow: '#8b5cf6',
  llmAgentflow: '#8b5cf6',
  toolAgentflow: '#3b82f6',
  httpAgentflow: '#3b82f6',
  conditionAgentflow: '#f59e0b',
  conditionAgentAgentflow: '#f59e0b',
  iterationAgentflow: '#ec4899',
  loopAgentflow: '#ec4899',
  humanInputAgentflow: '#ec4899',
  directReplyAgentflow: '#8b5cf6',
  customFunctionAgentflow: '#3b82f6',
  executeFlowAgentflow: '#ec4899',
  retrieverAgentflow: '#06b6d4',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const color = ICON_COLORS[name] || '#6366f1'

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="${color}"/><text x="20" y="28" font-family="Arial" font-size="16" font-weight="bold" fill="white" text-anchor="middle">${name.charAt(0).toUpperCase()}</text></svg>`

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
