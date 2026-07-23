import { INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { DispatchInvokeTool, DEFAULT_GATEWAY_URL, DEFAULT_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS, DEFAULT_TOOL_NAME, DEFAULT_TOOL_DESCRIPTION } from './core'

/**
 * Flowise node for the mil-agents DispatchInvoke tool (M2.9 / P1.9.T3).
 *
 * Drops into the canvas under Tools. Wires a {@link DispatchInvokeTool} that
 * POSTs /api/v1/dispatch/invoke through the gateway and polls
 * GET /api/v1/dispatch/tasks/:id until the agent task resolves, so an LLM can
 * delegate work to a mil-agents agent daemon and read its output.
 */
class DispatchInvoke_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Dispatch Invoke'
        this.name = 'dispatchInvoke'
        this.version = 1.0
        this.type = 'DispatchInvoke'
        this.icon = 'dispatchinvoke.svg'
        this.category = 'Tools'
        this.description = 'Invoke a mil-agents dispatch task via the gateway and return its output'
        this.baseClasses = [this.type, ...getBaseClasses(DispatchInvokeTool), 'Tool']
        this.inputs = [
            {
                label: 'Agent Daemon ID',
                name: 'agentDaemonId',
                type: 'string',
                description: 'UUID of the target agent daemon that will run the task',
                acceptVariable: true
            },
            {
                label: 'Gateway URL',
                name: 'gatewayUrl',
                type: 'string',
                default: DEFAULT_GATEWAY_URL,
                description: 'Gateway base address (default http://localhost:8080). Dispatch is reached through the gateway, never directly.',
                acceptVariable: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Poll Interval (ms)',
                name: 'pollIntervalMs',
                type: 'number',
                default: DEFAULT_POLL_INTERVAL_MS,
                step: 1,
                description: 'Interval between GET /tasks/:id polls',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Timeout (ms)',
                name: 'timeoutMs',
                type: 'number',
                default: DEFAULT_TIMEOUT_MS,
                step: 1,
                description: 'Max total wait before failing the task as timed out',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Name',
                name: 'name',
                type: 'string',
                default: DEFAULT_TOOL_NAME,
                description: 'Name of the tool as seen by the LLM',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Description',
                name: 'description',
                type: 'string',
                rows: 4,
                default: DEFAULT_TOOL_DESCRIPTION,
                description: 'Describe to the LLM when it should use this tool',
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string): Promise<any> {
        const agentDaemonId = (nodeData.inputs?.agentDaemonId as string) || ''
        const gatewayUrl = (nodeData.inputs?.gatewayUrl as string) || DEFAULT_GATEWAY_URL
        const pollIntervalMs = parseNumber(nodeData.inputs?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
        const timeoutMs = parseNumber(nodeData.inputs?.timeoutMs, DEFAULT_TIMEOUT_MS)
        const name = (nodeData.inputs?.name as string) || DEFAULT_TOOL_NAME
        const description = (nodeData.inputs?.description as string) || DEFAULT_TOOL_DESCRIPTION

        if (!agentDaemonId) {
            throw new Error('Agent Daemon ID is required')
        }

        return new DispatchInvokeTool({
            agentDaemonId,
            gatewayUrl,
            pollIntervalMs,
            timeoutMs,
            name,
            description
        })
    }
}

/** Parse a node input as a number, falling back to `fallback` when absent/invalid. */
function parseNumber(raw: unknown, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : fallback
}

module.exports = { nodeClass: DispatchInvoke_Tools }
