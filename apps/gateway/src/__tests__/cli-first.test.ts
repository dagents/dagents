/**
 * CLI-first workflow layer tests — pure pieces of the CLI-as-baseline design:
 * buildCliMessages (engine messages → CLI prompt shape) and the workflow
 * generator prompt (must carry the REAL agent/skill inventories so generated
 * flows bind platform agents instead of inventing anonymous LLM nodes).
 */
import { describe, it, expect } from 'vitest'
import { buildCliMessages } from '../routes/workflow-clients.js'
import { buildWorkflowGeneratorPrompt } from '../routes/chat-execute.js'

describe('buildCliMessages', () => {
  it('merges system messages into the system prompt, role-prefixes the rest', () => {
    const { systemPrompt, prompt } = buildCliMessages([
      { role: 'system', content: 'You design workflows.' },
      { role: 'user', content: 'Create a pipeline.' },
      { role: 'assistant', content: 'Sure, questions?' },
      { role: 'user', content: 'Three steps.' },
    ])
    expect(systemPrompt).toBe('You design workflows.')
    expect(prompt).toBe('user: Create a pipeline.\n\nassistant: Sure, questions?\n\nuser: Three steps.')
  })

  it('returns undefined systemPrompt when there are no system messages', () => {
    const { systemPrompt, prompt } = buildCliMessages([{ role: 'user', content: 'hi' }])
    expect(systemPrompt).toBeUndefined()
    expect(prompt).toBe('user: hi')
  })

  it('degrades to a placeholder prompt for an empty conversation', () => {
    const { prompt } = buildCliMessages([])
    expect(prompt).toBe('(no input)')
  })
})

describe('buildWorkflowGeneratorPrompt', () => {
  const agents = [
    { id: 'uuid-a', name: 'claude-a', kind: 'claude', summary: '需求规划' },
    { id: 'uuid-b', name: 'claude-b', kind: 'claude', summary: '' },
  ]
  const skills = [{ name: 'agent-reach', description: 'Internet eyes for agents.' }]

  it('embeds the real agent inventory with UUIDs for platformAgent binding', () => {
    const prompt = buildWorkflowGeneratorPrompt('编排 a 规划 b 开发', agents, skills)
    expect(prompt).toContain('platformAgentAgentflow')
    expect(prompt).toContain('uuid-a')
    expect(prompt).toContain('claude-a')
    expect(prompt).toContain('claude-b')
  })

  it('embeds the skill inventory and the user description', () => {
    const prompt = buildWorkflowGeneratorPrompt('编排 a 规划 b 开发', agents, skills)
    expect(prompt).toContain('agent-reach')
    expect(prompt).toContain('Internet eyes for agents.')
    expect(prompt).toContain('编排 a 规划 b 开发')
  })

  it('guards the agent-free case explicitly', () => {
    const prompt = buildWorkflowGeneratorPrompt('做点什么', [], [])
    expect(prompt).toContain('no agents registered')
    expect(prompt).toContain('no skills installed')
  })

  it('mandates a per-node task instruction for every platformAgent node', () => {
    const prompt = buildWorkflowGeneratorPrompt('编排', agents, skills)
    expect(prompt).toContain('MUST set data.inputs.systemPrompt')
    expect(prompt).toContain('the label is display-only')
  })
})
