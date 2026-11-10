import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@dagents/shared'
import { assembleWorkflowEngine } from '../routes/workflow-engine-service.js'
import { BLACKBOARD_DIR } from '../lib/blackboard.js'

/**
 * 黑板注入链路（方向 B 注入层）：assembleWorkflowEngine 在 cwd 指向带
 * `.agents/` 的项目时，把黑板块拼进 baseOptions.flowContext（LLM/Agent
 * 节点 system 前部的同一通道）。装配本身不触 DB（clients 惰性），
 * 纯内存可测。
 */

const FLOW_DATA = {
  nodes: [
    { id: 's1', type: 'customNode', position: { x: 0, y: 0 }, data: { name: 'startAgentflow' } },
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
} as Parameters<typeof assembleWorkflowEngine>[0]['flowData']

const log = createLogger({ svc: 'test:blackboard-inject' })
const roots: string[] = []

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots.length = 0
})

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dagents-inj-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, BLACKBOARD_DIR, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('黑板注入（assembleWorkflowEngine.flowContext）', () => {
  it('cwd 带黑板 → flowContext 前置 [项目黑板] 块', () => {
    const cwd = makeProject({
      'BOARD.md': '# 任务板\n- [ ] 落地页实现',
      'knowledge/k.md': '结论',
    })
    const assembled = assembleWorkflowEngine({
      flowData: FLOW_DATA,
      runId: '11111111-1111-4111-8111-111111111111',
      flowId: '22222222-2222-4222-8222-222222222222',
      cwd,
      logger: log,
      flowContextMd: '# 流程上下文',
    })
    expect(assembled.baseOptions.flowContext).toContain('[项目黑板')
    expect(assembled.baseOptions.flowContext).toContain('任务板')
    expect(assembled.baseOptions.flowContext).toContain('# 流程上下文')
  })

  it('cwd 无黑板 / 无 cwd → flowContext 只有 flow 上下文（不拼空块）', () => {
    const bare = mkdtempSync(join(tmpdir(), 'dagents-inj-'))
    roots.push(bare)
    const assembled = assembleWorkflowEngine({
      flowData: FLOW_DATA,
      runId: '11111111-1111-4111-8111-111111111111',
      flowId: '22222222-2222-4222-8222-222222222222',
      cwd: bare,
      logger: log,
      flowContextMd: '# 流程上下文',
    })
    expect(assembled.baseOptions.flowContext).toBe('# 流程上下文')
  })
})
