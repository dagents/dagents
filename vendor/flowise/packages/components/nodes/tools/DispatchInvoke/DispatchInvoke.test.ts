const { nodeClass: DispatchInvoke_Tools } = require('./DispatchInvoke')
import type { INodeData } from '../../../src/Interface'

// Mock getBaseClasses so the INode wrapper doesn't pull in all of utils.
jest.mock('../../../src/utils', () => ({
    getBaseClasses: jest.fn(() => ['Tool', 'StructuredTool'])
}))

// Mock secureFetch — the tool never does real HTTP in tests.
jest.mock('../../../src/httpSecurity', () => ({
    secureFetch: jest.fn()
}))

import { secureFetch } from '../../../src/httpSecurity'
import { DispatchInvokeTool } from './core'

const secureFetchMock = secureFetch as jest.MockedFunction<typeof secureFetch>

/** Build a node-fetch-like Response with a JSON body. */
function jsonResponse(body: unknown, ok = true, status = 200): any {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body)
    }
}

const DAEMON_ID = '11111111-2222-3333-4444-555555555555'

function createNodeData(inputs: any): INodeData {
    return {
        id: 'dispatch-invoke-node',
        label: 'Dispatch Invoke',
        name: 'dispatchInvoke',
        type: 'DispatchInvoke',
        icon: 'dispatchinvoke.svg',
        version: 1.0,
        category: 'Tools',
        baseClasses: ['DispatchInvoke', 'Tool'],
        inputs
    }
}

/** Drive fake timers until `p` settles, returning {ok, value}. */
async function drive<T>(p: Promise<T>, stepMs: number, maxSteps = 100): Promise<{ ok: boolean; value: T | Error }> {
    let settled: { ok: boolean; value: T | Error } | undefined
    p.then(
        (r) => {
            settled = { ok: true, value: r }
        },
        (e) => {
            settled = { ok: false, value: e }
        }
    )
    for (let i = 0; i < maxSteps && !settled; i++) {
        await jest.advanceTimersByTimeAsync(stepMs)
    }
    return settled as { ok: boolean; value: T | Error }
}

/** Wire secureFetch to return the given GET-poll task states in order. */
function mockInvokeThenPolls(taskId: string, pollStates: Array<Record<string, unknown>>): void {
    let pollIdx = 0
    secureFetchMock.mockImplementation(async (url: string, init: any) => {
        if (init.method === 'POST') {
            return jsonResponse({ success: true, data: { taskId } })
        }
        const data = { id: taskId, ...pollStates[Math.min(pollIdx, pollStates.length - 1)] }
        pollIdx += 1
        return jsonResponse({ success: true, data })
    })
}

describe('DispatchInvoke', () => {
    let nodeClass: any

    beforeEach(() => {
        jest.useFakeTimers()
        secureFetchMock.mockReset()
        nodeClass = new DispatchInvoke_Tools()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    describe('Node definition', () => {
        it('exposes the expected identity and inputs', () => {
            expect(nodeClass.label).toBe('Dispatch Invoke')
            expect(nodeClass.name).toBe('dispatchInvoke')
            expect(nodeClass.type).toBe('DispatchInvoke')
            expect(nodeClass.category).toBe('Tools')
            expect(nodeClass.icon).toBe('dispatchinvoke.svg')
            expect(nodeClass.baseClasses).toEqual(['DispatchInvoke', 'Tool', 'StructuredTool', 'Tool'])

            const inputNames = nodeClass.inputs.map((i: any) => i.name)
            expect(inputNames).toEqual(['agentDaemonId', 'gatewayUrl', 'pollIntervalMs', 'timeoutMs', 'name', 'description'])
            const required = nodeClass.inputs.find((i: any) => i.name === 'agentDaemonId')
            expect(required.optional).toBeUndefined()
        })
    })

    describe('init()', () => {
        it('throws when agentDaemonId is missing', async () => {
            await expect(nodeClass.init(createNodeData({ agentDaemonId: '' }), '')).rejects.toThrow('Agent Daemon ID is required')
        })

        it('builds a tool with defaults when only agentDaemonId is given', async () => {
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')
            expect(tool).toBeInstanceOf(DispatchInvokeTool)
            expect(tool.name).toBe('dispatch_invoke')
            expect(tool.gatewayUrl).toBe('http://localhost:8080')
            expect(tool.pollIntervalMs).toBe(1000)
            expect(tool.timeoutMs).toBe(120000)
        })

        it('applies custom gatewayUrl, polling, and tool name/description', async () => {
            const tool = await nodeClass.init(
                createNodeData({
                    agentDaemonId: DAEMON_ID,
                    gatewayUrl: 'http://gateway.example/',
                    pollIntervalMs: '500',
                    timeoutMs: '60000',
                    name: 'my_dispatch',
                    description: 'custom desc'
                }),
                ''
            )
            expect(tool.gatewayUrl).toBe('http://gateway.example')
            expect(tool.pollIntervalMs).toBe(500)
            expect(tool.timeoutMs).toBe(60000)
            expect(tool.name).toBe('my_dispatch')
            expect(tool.description).toBe('custom desc')
        })
    })

    describe('Tool._call — happy path', () => {
        it('returns result.output when the first poll is completed', async () => {
            mockInvokeThenPolls('task-1', [{ status: 'completed', result: { output: 'agent-output' } }])
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'hello' }), 1000)
            expect(settled.ok).toBe(true)
            expect(settled.value).toBe('agent-output')

            // Exactly one POST (invoke) + one GET (poll); no extra polls after terminal.
            expect(secureFetchMock).toHaveBeenCalledTimes(2)
            const invokeCall = secureFetchMock.mock.calls[0]
            const invokeInit = invokeCall?.[1] as { method: string; body: string }
            expect(invokeInit.method).toBe('POST')
            const body = JSON.parse(invokeInit.body)
            expect(body).toMatchObject({ agentDaemonId: DAEMON_ID, prompt: 'hello', execOptions: {} })
            expect(body.runId).toEqual(expect.any(String))
        })

        it('polls queued -> running -> completed and returns output', async () => {
            mockInvokeThenPolls('task-2', [
                { status: 'queued' },
                { status: 'running' },
                { status: 'completed', result: { output: 'multi-poll-output' } }
            ])
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID, pollIntervalMs: 10 }), '')

            const settled = await drive(tool._call({ prompt: 'go' }), 10)
            expect(settled.ok).toBe(true)
            expect(settled.value).toBe('multi-poll-output')
            // 1 invoke POST + 3 GET polls.
            expect(secureFetchMock).toHaveBeenCalledTimes(4)
        })
    })

    describe('Tool._call — error paths', () => {
        it('throws when invoke returns success:false', async () => {
            secureFetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'bad daemon' }))
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toBe('dispatch invoke failed: bad daemon')
        })

        it('throws when invoke omits taskId', async () => {
            secureFetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }))
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toBe('dispatch invoke failed: no taskId returned')
        })

        it('throws the failureReason when status is failed', async () => {
            mockInvokeThenPolls('task-3', [{ status: 'failed', failureReason: 'agent crashed' }])
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toBe('agent crashed')
        })

        it('falls back to a generic message when failed has no failureReason', async () => {
            mockInvokeThenPolls('task-3b', [{ status: 'failed' }])
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toBe('dispatch task failed')
        })

        it('throws "dispatch task timed out" when no terminal state is reached in time', async () => {
            // Every poll returns running; never terminates.
            mockInvokeThenPolls('task-4', [{ status: 'running' }])
            const tool = await nodeClass.init(
                createNodeData({ agentDaemonId: DAEMON_ID, pollIntervalMs: 10, timeoutMs: 25 }),
                ''
            )

            const settled = await drive(tool._call({ prompt: 'x' }), 10, 50)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toBe('dispatch task timed out')
        })

        it('throws when secureFetch rejects (network error)', async () => {
            secureFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toMatch(/dispatch request to .* failed: ECONNREFUSED/)
        })

        it('throws on non-ok HTTP status', async () => {
            secureFetchMock.mockResolvedValueOnce(jsonResponse({}, false, 502))
            const tool = await nodeClass.init(createNodeData({ agentDaemonId: DAEMON_ID }), '')

            const settled = await drive(tool._call({ prompt: 'x' }), 1000)
            expect(settled.ok).toBe(false)
            expect((settled.value as Error).message).toMatch(/returned HTTP 502/)
        })
    })

    describe('HTTP contract', () => {
        it('POSTs to /api/v1/dispatch/invoke through the gatewayUrl and polls /api/v1/dispatch/tasks/:id', async () => {
            mockInvokeThenPolls('task-5', [{ status: 'completed', result: { output: 'ok' } }])
            const tool = await nodeClass.init(
                createNodeData({ agentDaemonId: DAEMON_ID, gatewayUrl: 'http://gw:8080' }),
                ''
            )
            await drive(tool._call({ prompt: 'hi' }), 1000)

            const invokeUrl = secureFetchMock.mock.calls[0][0]
            const pollUrl = secureFetchMock.mock.calls[1][0]
            expect(invokeUrl).toBe('http://gw:8080/api/v1/dispatch/invoke')
            expect(pollUrl).toBe('http://gw:8080/api/v1/dispatch/tasks/task-5')
        })
    })
})
