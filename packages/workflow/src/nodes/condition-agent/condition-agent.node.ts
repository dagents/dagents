import type { INode, INodeData, INodeOutput, IExecutionContext } from '../../types/index.js'
import { resolveVariables } from '../../utils/variables.js'

interface Scenario {
  name: string
  description: string
}

export class ConditionAgentNode implements INode {
  label = 'Condition Agent'
  name = 'conditionAgentAgentflow'
  version = 1
  type = 'ConditionAgent'
  category = 'logic'
  color = '#f59e0b'
  inputs = [
    {
      label: 'Model',
      name: 'model',
      type: 'options' as const,
      default: '',
    },
    {
      label: 'System Prompt',
      name: 'systemPrompt',
      type: 'code' as const,
      rows: 4,
      default: '',
    },
    {
      label: 'Scenarios',
      name: 'scenarios',
      type: 'json' as const,
      default: [],
    },
  ]

  async run(nodeData: INodeData, input: unknown, options: IExecutionContext): Promise<INodeOutput> {
    const model = (nodeData.inputs?.model as string) ?? ''
    const systemPrompt = (nodeData.inputs?.systemPrompt as string) ?? ''
    const scenarios = (nodeData.inputs?.scenarios as Scenario[]) ?? []

    const resolvedSystemPrompt = resolveVariables(systemPrompt, options.state) as string

    if (scenarios.length === 0) {
      return {
        id: nodeData.id,
        name: this.name,
        input: { model, systemPrompt, scenarios },
        output: { selected: '', reason: 'No scenarios provided', result: '' },
        state: options.state,
      }
    }

    if (!options.llmClient) {
      const firstScenario = scenarios[0]
      return {
        id: nodeData.id,
        name: this.name,
        input: { model, systemPrompt, scenarios },
        output: {
          selected: firstScenario.name,
          reason: 'LLM client not available, using first scenario as default',
          result: firstScenario.name,
        },
        state: options.state,
      }
    }

    const scenarioDescriptions = scenarios
      .map((s, i) => `${i + 1}. ${s.name}: ${s.description}`)
      .join('\n')

    let userPrompt = 'Given the following input and scenarios, select the most appropriate scenario.\n\n'
    userPrompt += `Input:\n${typeof input === 'string' ? input : JSON.stringify(input)}\n\n`
    userPrompt += `Scenarios:\n${scenarioDescriptions}\n\n`
    userPrompt += 'Respond with ONLY the scenario name (exactly as written), nothing else.'

    const messages: Array<{ role: string; content: string }> = []
    if (resolvedSystemPrompt.length > 0) {
      messages.push({ role: 'system', content: resolvedSystemPrompt })
    }
    messages.push({ role: 'user', content: userPrompt })

    const result = await options.llmClient.chat({ model, messages })
    const selected = result.text.trim()

    const matched = scenarios.find((s) => s.name === selected)
    const finalSelected = matched ? selected : scenarios[0].name
    const reason = matched
      ? `LLM selected scenario: ${finalSelected}`
      : `LLM response "${selected}" did not match any scenario, using first scenario as default`

    return {
      id: nodeData.id,
      name: this.name,
      input: { model, systemPrompt, scenarios },
      output: {
        selected: finalSelected,
        reason,
        result: finalSelected,
      },
      state: options.state,
    }
  }
}
