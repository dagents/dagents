import { describe, it, expectTypeOf } from 'vitest'
import type {
  AgentBackend,
  AgentEvent,
  AgentResult,
  AgentSession,
  AgentType,
  BackendConfig,
  BackendFactory,
  DaemonCapability,
  DispatchTask,
  ExecOptions,
  RegisterRequest,
} from '../index.js'

describe('contracts types', () => {
  it('AgentBackend.execute returns AgentSession', () => {
    expectTypeOf<AgentBackend['execute']>().returns.toMatchTypeOf<AgentSession>()
  })

  it('AgentSession has events and result', () => {
    expectTypeOf<AgentSession>().toHaveProperty('events').toMatchTypeOf<AsyncIterable<AgentEvent>>()
    expectTypeOf<AgentSession>().toHaveProperty('result').toMatchTypeOf<Promise<AgentResult>>()
  })

  it('ExecOptions carries timeoutMs and inactivityTimeoutMs (v0.2 补全)', () => {
    expectTypeOf<ExecOptions>().toHaveProperty('timeoutMs').toEqualTypeOf<number | undefined>()
    expectTypeOf<ExecOptions>().toHaveProperty('inactivityTimeoutMs').toEqualTypeOf<number | undefined>()
  })

  it('ExecOptions carries extraArgs and customArgs (multica 双层透传)', () => {
    expectTypeOf<ExecOptions>().toHaveProperty('extraArgs').toEqualTypeOf<string[] | undefined>()
    expectTypeOf<ExecOptions>().toHaveProperty('customArgs').toEqualTypeOf<string[] | undefined>()
  })

  it('AgentEvent includes the log variant (multica MessageLog)', () => {
    expectTypeOf<{ type: 'log'; content: string }>().toMatchTypeOf<AgentEvent>()
    expectTypeOf<{ type: 'error'; content: string }>().toMatchTypeOf<AgentEvent>()
  })

  it('BackendFactory parameters are (AgentType, BackendConfig)', () => {
    expectTypeOf<BackendFactory>().parameters.toEqualTypeOf<[AgentType, BackendConfig]>()
  })

  it('DispatchTask carries execOptions', () => {
    expectTypeOf<DispatchTask>().toHaveProperty('execOptions').toMatchTypeOf<ExecOptions>()
  })

  it('RegisterRequest carries a capabilities array', () => {
    expectTypeOf<RegisterRequest>().toHaveProperty('capabilities').toMatchTypeOf<DaemonCapability[]>()
  })
})
