/**
 * Template variable resolution.
 *
 * Nodes accept variables in their input strings using two syntaxes:
 *
 *   1. `{{key}}` or `{{dotted.path}}` — resolved from runtime state.
 *      The canvas variable picker inserts `{{<nodeId>}}` for upstream node
 *      outputs (the executor stores each executed node's output in state
 *      under its node id), and dotted paths reach into it
 *      (e.g. `{{cf1.content}}`, `{{cf1.output.content}}`).
 *   2. `$scope.field` — shorthand for common scopes:
 *      `$flow.chatId` / `$flow.sessionId` (run metadata), `$flow.state.<key>`
 *      (flat runtime state), `$iteration` (current Iteration item).
 *
 * When a variable is not found in state, it's left as-is (no error) — the
 * node will receive the literal string and can decide how to handle it.
 *
 * Non-string values resolve to their JSON form (an object interpolating as
 * `[object Object]` would be useless in a prompt). Non-string inputs are
 * returned unchanged (numbers, objects, null).
 */

/** Resolve `{{var}}` and `$scope.field` variables in a string against state. */
export function resolveVariables(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value

  // Resolve {{var}} syntax first — handles {{path}} and {{$scope.field}}.
  // The {{$scope.field}} form strips the leading $ and looks up scope.field.
  // Running this before the bare $scope.field pass avoids double-substitution
  // when a $-shorthand is wrapped in braces.
  let resolved = value.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const trimmed = path.trim()
    let lookupPath = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed
    // `{{$flow.state.<key>}}` maps onto the flat runtime state (the nested
    // `flow` object deliberately doesn't contain the state itself, so the
    // state stays acyclic).
    lookupPath = lookupPath.replace(/^flow\.state\./, '')
    const val = getByPath(state, lookupPath)
    if (val !== undefined) {
      // `{{<id>.output}}` 精确命中时，executor 注入的是自引用 output 对象
      // （`runtime.merge({[nodeId]: {...out, output: out}})`），直接 stringify
      // 会把 {"text":…,"content":…} 整包塞进 prompt —— 文档语义「引用上游
      // 产出」指的是正文，这里解包 text ?? content；更深的
      // `{{id.output.field}}` 嵌套路径不走此分支，保持原样。
      const selfRef = /^([\w$-]+)\.output$/.exec(lookupPath)
      if (selfRef && val !== null && typeof val === 'object') {
        const rec = val as Record<string, unknown>
        if (typeof rec.text === 'string' && rec.text.length > 0) return rec.text
        if (typeof rec.content === 'string' && rec.content.length > 0) return rec.content
      }
      return stringifyVal(val)
    }
    // 文档语法兼容别名（PRD FR-02 / 决议 D2）：显式字段未命中时兜底
    // `{{$start.input}}` / `{{<id>.output}}` —— 运行面板与教程宣传的写法。
    // 优先级恒为「显式字段 > 别名 > 字面量保留」：输出恰好含真实
    // `.output` 字段时（如 ExecuteFlow）显式路径已在上面命中，不会进这里。
    const aliased = resolveAlias(lookupPath, state)
    if (aliased !== undefined) return stringifyVal(aliased)
    return `{{${trimmed}}}`
  })

  // `$flow.state.<key>` is the flat runtime state itself (kept out of the
  // nested `flow` object so the state stays acyclic) — rewrite it to a plain
  // lookup before the generic $-shorthand pass below tries (and fails) to
  // walk `flow.state.*`.
  resolved = resolved.replace(/\$flow\.state\.(\w+(?:\.\w+)*)/g, (_, path: string) => {
    const val = getByPath(state, path)
    return val !== undefined ? stringifyVal(val) : `$flow.state.${path}`
  })

  // Resolve bare $scope.field shorthand (outside {{}}).
  resolved = resolved.replace(/\$(\w+(?:\.\w+)*)/g, (_, path: string) => {
    const val = getByPath(state, path)
    return val !== undefined ? stringifyVal(val) : `$${path}`
  })

  return resolved
}

/** Interpolate a resolved value into a string (JSON for non-strings). */
function stringifyVal(val: unknown): string {
  if (typeof val === 'string') return val
  try {
    return JSON.stringify(val) ?? String(val)
  } catch {
    return String(val)
  }
}

/** Get a value by dotted path from an object. Returns undefined if not found. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * 兼容别名解析（PRD FR-02 / 决议 D2）。两条规则：
 *
 *   1. `start.input`（含 `{{$start.input}}` 去 $ 后）→ 运行输入。Start 节点
 *      的输出形状是 `{ variables, content }`（content 即输入文本），并没有
 *      `.input` 字段 —— 文档宣传的 `{{$start.input}}` 在别名出现之前永远
 *      解析为字面量（实测 run f68b83dd「变量未解析」vs d9064c5d）。
 *   2. `<id>.output` → 该节点输出正文（`text ?? content`）。LLM 输出形状是
 *      `{text, content}`，同样没有 `.output` 字段；两者皆无（如 Condition
 *      只有 `matched`）时回落整对象 JSON —— 至少引用者拿得到东西。
 *
 * 节点 id 段与既有 getByPath 行为一致（不含点）；显式字段命中优先于别名。
 */
function resolveAlias(path: string, state: Record<string, unknown>): unknown {
  if (path === 'start.input') {
    return getByPath(state, 'start.content')
  }
  const m = /^([\w$-]+)\.output$/.exec(path)
  if (!m) return undefined
  const out = getByPath(state, m[1])
  if (out === undefined || out === null) return undefined
  if (typeof out === 'object') {
    const rec = out as Record<string, unknown>
    if (typeof rec.text === 'string' && rec.text.length > 0) return rec.text
    if (typeof rec.content === 'string' && rec.content.length > 0) return rec.content
    return stringifyVal(out)
  }
  return out
}
