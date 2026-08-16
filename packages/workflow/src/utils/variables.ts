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
    return val !== undefined ? stringifyVal(val) : `{{${trimmed}}}`
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
