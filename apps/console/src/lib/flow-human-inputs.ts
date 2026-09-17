/**
 * HumanInput 预供答案（2026-09-18 PM 优化）。
 *
 * 画布/列表的「运行」是非交互路径：HumanInput 节点没有 resolver 注入时
 * 必然失败（「no pre-supplied answer」）。网关契约支持 `state.humanInputs`
 * （按 **已解析的 prompt** 键控，见 gateway human-input.ts
 * createStaticHumanInputResolver）—— 本模块从 flow 文档提取待答清单，
 * 运行面板按节点渲染答案输入，提交时拼进 run body。
 *
 * 已知边界：prompt 含模板变量（如 {{input}}）时，运行期解析后的字符串才
 * 是键 —— 提取侧标记 `hasTemplate`，UI 提示这类提示需走聊天路径或在
 * 文案里避免变量。
 */

export interface HumanInputSpec {
  nodeId: string
  /** 节点配置里的原文 prompt（也是无模板时的答案键）。 */
  prompt: string
  inputType?: string
  options?: string[]
  /** prompt 含 {{...}} —— 预供答案可能对不上运行期解析后的键。 */
  hasTemplate: boolean
}

/** 从 flow 文档（nodes/edges JSON）提取 HumanInput 待答清单。宽容任意输入形状。 */
export function extractHumanInputPrompts(flowData: unknown): HumanInputSpec[] {
  if (!flowData || typeof flowData !== 'object') return []
  const nodes = (flowData as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []

  const specs: HumanInputSpec[] = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as { id?: unknown; data?: unknown }
    const data = node.data
    if (!data || typeof data !== 'object') continue
    const d = data as Record<string, unknown>
    const name = typeof d.name === 'string' ? d.name : ''
    if (name !== 'humanInputAgentflow') continue

    // 与引擎同款双形态归一：平铺 data.<field> 打底、嵌套 data.inputs.<field> 覆盖
    const nested = (typeof d.inputs === 'object' && d.inputs !== null && !Array.isArray(d.inputs))
      ? (d.inputs as Record<string, unknown>)
      : undefined
    const read = (key: string): unknown => nested?.[key] ?? d[key]

    const prompt = typeof read('prompt') === 'string' ? (read('prompt') as string).trim() : ''
    const inputType = typeof read('inputType') === 'string' ? (read('inputType') as string) : undefined
    const rawOptions = read('options')
    const options =
      typeof rawOptions === 'string'
        ? safeSplitOptions(rawOptions)
        : Array.isArray(rawOptions)
          ? rawOptions.filter((o): o is string => typeof o === 'string')
          : undefined

    specs.push({
      nodeId: typeof node.id === 'string' ? node.id : `node-${specs.length}`,
      prompt,
      inputType,
      options: options && options.length > 0 ? options : undefined,
      hasTemplate: /\{\{[^}]+\}\}/.test(prompt),
    })
  }
  return specs
}

/** options 配置容错：字符串按行/逗号切（画布 textarea 存行、生成器可能给 JSON 数组串）。 */
function safeSplitOptions(raw: string): string[] | undefined {
  const s = raw.trim()
  if (!s) return undefined
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) {
        const strs = parsed.filter((o): o is string => typeof o === 'string')
        return strs.length > 0 ? strs : undefined
      }
    } catch { /* 落到行切 */ }
  }
  const lines = s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean)
  return lines.length > 0 ? lines : undefined
}

/** 答案表 → run body 的 state.humanInputs（跳过空答案；无有效答案返回 undefined）。 */
export function buildHumanInputsState(
  specs: HumanInputSpec[],
  answers: Record<string, string>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const spec of specs) {
    if (!spec.prompt) continue
    const v = answers[spec.nodeId]?.trim()
    if (v) out[spec.prompt] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
