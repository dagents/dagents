/**
 * Runtime state container — holds mutable state that flows through a DAG execution.
 *
 * Nodes read from `state` (via `IExecutionContext.state`) to access upstream
 * values, and write to it (via `INodeOutput.state`) to pass values downstream.
 * The executor merges each node's `state` output into this container.
 */
export class RuntimeState {
  private _state: Record<string, unknown> = {}

  /** The current state object (nodes read from this). */
  get state(): Record<string, unknown> {
    return this._state
  }

  /** Get a single value by key. */
  get<T = unknown>(key: string): T | undefined {
    return this._state[key] as T | undefined
  }

  /** Set a single value. */
  set(key: string, value: unknown): void {
    this._state[key] = value
  }

  /** Merge a partial state object (from node output) into the current state. */
  merge(partial: Record<string, unknown> | undefined): void {
    if (!partial) return
    for (const [key, value] of Object.entries(partial)) {
      this._state[key] = value
    }
  }

  /** Return a shallow snapshot of the current state. */
  snapshot(): Record<string, unknown> {
    return { ...this._state }
  }
}
