import { randomUUID } from 'crypto'
import { z } from 'zod/v3'
import { StructuredTool } from '@langchain/core/tools'
import { secureFetch } from '../../../src/httpSecurity'

/**
 * Tool that invokes a mil-agents dispatch task via the gateway and polls
 * until it reaches a terminal state, returning the agent's output.
 *
 * All HTTP goes through `secureFetch` (Flowise's SSRF-guarded fetch) and the
 * gateway (default :8080) — never direct to dispatch (:8081). This honours
 * the M2.9 contract: invoke → poll → terminal.
 */

export const DEFAULT_GATEWAY_URL = 'http://localhost:8080'
export const DEFAULT_POLL_INTERVAL_MS = 1000
export const DEFAULT_TIMEOUT_MS = 120000
export const DEFAULT_TOOL_NAME = 'dispatch_invoke'
export const DEFAULT_TOOL_DESCRIPTION = 'Invoke a mil-agents dispatch task and return its output'

/** Constructor parameters for {@link DispatchInvokeTool}. */
export interface DispatchInvokeParams {
    agentDaemonId: string
    gatewayUrl?: string
    pollIntervalMs?: number
    timeoutMs?: number
    name?: string
    description?: string
}

/** Body for POST /api/v1/dispatch/invoke (M2.9 contract). */
interface InvokeBody {
    agentDaemonId: string
    runId: string
    prompt: string
    execOptions: Record<string, unknown>
}

/** Standard gateway/dispatch envelope: { success, data?, error? }. */
interface ApiEnvelope<T> {
    success: boolean
    data?: T
    error?: string
}

/** `data` shape returned by POST /invoke. */
interface InvokeData {
    taskId: string
}

/** `data` shape returned by GET /tasks/:id. `result` is present once terminal. */
interface TaskData {
    id: string
    status: string
    result?: { output?: string; sessionId?: string; usage?: unknown } | null
    failureReason?: string | null
    sessionId?: string | null
}

/** Request init shape accepted by `secureFetch` (a subset of node-fetch RequestInit). */
interface SecureRequestInit {
    method: string
    headers?: Record<string, string>
    body?: string
}

/** Sleep for `ms`. Uses standard timers so jest fake timers can drive it. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class DispatchInvokeTool extends StructuredTool {
    name = DEFAULT_TOOL_NAME
    description = DEFAULT_TOOL_DESCRIPTION

    schema = z.object({
        prompt: z.string().describe('The prompt to send to the agent')
    })

    private readonly agentDaemonId: string
    private readonly gatewayUrl: string
    private readonly pollIntervalMs: number
    private readonly timeoutMs: number

    constructor(params: DispatchInvokeParams) {
        super()
        if (!params.agentDaemonId) {
            throw new Error('agentDaemonId is required')
        }
        this.agentDaemonId = params.agentDaemonId
        this.gatewayUrl = (params.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '')
        this.pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
        this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
        if (params.name) this.name = params.name
        if (params.description) this.description = params.description
    }

    async _call({ prompt }: z.infer<typeof this.schema>): Promise<string> {
        const runId = randomUUID()
        const invokeUrl = `${this.gatewayUrl}/api/v1/dispatch/invoke`
        const taskUrl = (taskId: string) => `${this.gatewayUrl}/api/v1/dispatch/tasks/${taskId}`

        // 1. Enqueue the task via the gateway.
        const invokeBody: InvokeBody = {
            agentDaemonId: this.agentDaemonId,
            runId,
            prompt,
            execOptions: {}
        }
        const invokeRes = await this.callJson<InvokeData>(invokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(invokeBody)
        })
        if (!invokeRes.success || !invokeRes.data?.taskId) {
            throw new Error(`dispatch invoke failed: ${invokeRes.error ?? 'no taskId returned'}`)
        }
        const taskId = invokeRes.data.taskId

        // 2. Poll GET /tasks/:id until terminal (completed|failed) or timeout.
        const startedAt = Date.now()
        while (true) {
            const taskRes = await this.callJson<TaskData>(taskUrl(taskId), { method: 'GET' })
            if (!taskRes.success || !taskRes.data) {
                throw new Error(`dispatch task lookup failed: ${taskRes.error ?? 'no task data'}`)
            }
            const task = taskRes.data

            if (task.status === 'completed') {
                const output = task.result?.output
                if (typeof output !== 'string') {
                    throw new Error('dispatch task completed without output')
                }
                return output
            }
            if (task.status === 'failed') {
                throw new Error(task.failureReason ?? 'dispatch task failed')
            }

            // Non-terminal (queued|claimed|running). Bound the wait before polling again.
            if (Date.now() - startedAt > this.timeoutMs) {
                throw new Error('dispatch task timed out')
            }
            await sleep(this.pollIntervalMs)
        }
    }

    /**
     * Fetch + JSON-parse an envelope. Throws on network error or non-ok HTTP
     * status, propagating the URL for context. A non-ok response (e.g. gateway
     * 502) is treated as a hard failure — the caller does not see dispatch's
     * raw error body, consistent with the gateway's sanitising proxy.
     */
    private async callJson<T>(url: string, init: SecureRequestInit): Promise<ApiEnvelope<T>> {
        let res
        try {
            res = await secureFetch(url, init)
        } catch (err) {
            throw new Error(`dispatch request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!res.ok) {
            throw new Error(`dispatch request to ${url} returned HTTP ${res.status}`)
        }
        try {
            return (await res.json()) as ApiEnvelope<T>
        } catch (err) {
            throw new Error(`dispatch response from ${url} was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
}
