/**
 * Template variable resolution.
 *
 * Nodes accept variables in their input strings using two syntaxes:
 *
 *   1. `{{key}}` or `{{dotted.path}}` — resolved from runtime state
 *      (e.g. `{{directReplyAgentflow.output.content}}`)
 *   2. `$scope.field` — shorthand for common scopes
 *      (e.g. `$start.question`, `$webhook.body.user`)
 *
 * When a variable is not found in state, it's left as-is (no error) — the
 * node will receive the literal string and can decide how to handle it.
 *
 * Non-string values are returned unchanged (numbers, objects, null).
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
    const lookupPath = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed
    const val = getByPath(state, lookupPath)
    return val !== undefined ? String(val) : `{{${trimmed}}}`
  })

  // Resolve bare $scope.field shorthand (outside {{}}).
  resolved = resolved.replace(/\$(\w+(?:\.\w+)*)/g, (_, path: string) => {
    const val = getByPath(state, path)
    return val !== undefined ? String(val) : `$${path}`
  })

  return resolved
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
