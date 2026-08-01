/**
 * `DispatchClient` — thin HTTP client for the dispatch ↔ daemon protocol
 * (spec §1.5, plan M2.3). One method per lifecycle endpoint in
 * `apps/dispatch/src/routes/{daemons,tasks}.ts`:
 *
 *   register / heartbeat / claim / start / messages / complete / fail
 *
 * Dispatch wraps every success body in the standard envelope
 * `{ success, data }` (see `apps/dispatch/src/app.ts` `ok`). The terminal
 * task endpoints (start/heartbeat/messages/complete/fail) return `204` with
 * no body, so callers branch on status rather than parsing JSON. `register`
 * and `claim` return envelopes and are unwrapped here into the bare DTOs the
 * daemon loop consumes.
 *
 * Auth: `register` is unauthenticated and returns a token; the daemon mutates
 * it onto the client immediately after, so every subsequent call carries
 * `authorization: Bearer <token>`. MVP claim is unauthenticated server-side
 * (P1.5.T7 routing/auth is pending), but the client always sends the header
 * so it is correct the moment auth lands.
 */
import type {
  AgentEvent,
  ClaimTaskResponse,
  HeartbeatPayload,
  RegisterRequest,
  RegisterResponse,
  TaskComplete,
  TaskFail,
} from '@dagents/contracts'
import { createLogger, type Logger } from '@dagents/shared'

/** Dispatch envelope returned by `ok()` (only present on JSON responses). */
interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

/** Raised when dispatch returns a non-success HTTP status. Carries body text. */
export class DispatchHttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`dispatch ${url} → ${status}`)
    this.name = 'DispatchHttpError'
  }
}

export interface DispatchClientOptions {
  /** Base URL of the dispatch server, e.g. `http://localhost:8080`. */
  baseUrl: string
  /** Bearer token; empty until `register` returns one. */
  token?: string
  /** Per-request timeout (ms); the register call and each claim poll honour it. */
  timeoutMs?: number
  /** Injectable logger; defaults to a `dispatch-client` svc logger. */
  logger?: Logger
  /**
   * Injectable fetch (tests pass a stub; Node 20+ has global `fetch`).
   * Typed loosely because the DOM lib's `Response`/`RequestInit` differ from
   * undici's; we only read `.ok`, `.status`, and `.text()`.
   */
  fetchImpl?: typeof fetch
}

export class DispatchClient {
  private readonly baseUrl: string
  private token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly log: Logger

  constructor(opts: DispatchClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token ?? ''
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.log = opts.logger ?? createLogger({ svc: 'dispatch-client' })
  }

  /** Replace the bearer token (called right after `register`). */
  setToken(token: string): void {
    this.token = token
  }

  /** Daemon → dispatch: register, receive daemon id + auth token. */
  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const data = await this.post<RegisterResponse>('/api/v1/dispatch/daemons/register', req)
    return data
  }

  /** Daemon → dispatch: periodic liveness + load signal. 204 on success. */
  async heartbeat(p: HeartbeatPayload): Promise<void> {
    await this.postVoid('/api/v1/dispatch/daemons/heartbeat', p)
  }

  /**
   * Daemon → dispatch: atomically claim one queued task.
   * Returns `{ task: null }` on an idle poll (nothing queued).
   */
  async claimTask(daemonId: string): Promise<ClaimTaskResponse> {
    const data = await this.post<ClaimTaskResponse>(
      `/api/v1/dispatch/daemons/${daemonId}/tasks/claim`,
      null,
    )
    return data
  }

  /** Daemon → dispatch: mark a claimed task as running. 204 on success. */
  async startTask(taskId: string): Promise<void> {
    await this.postVoid(`/api/v1/dispatch/tasks/${taskId}/start`, null)
  }

  /** Daemon → dispatch: batched event upload (cuts HTTP chatter). 204 on success. */
  async reportMessages(taskId: string, messages: AgentEvent[]): Promise<void> {
    await this.postVoid(`/api/v1/dispatch/tasks/${taskId}/messages`, { messages })
  }

  /** Daemon → dispatch: terminal success (aggregated usage). 204 on success. */
  async completeTask(taskId: string, r: TaskComplete): Promise<void> {
    await this.postVoid(`/api/v1/dispatch/tasks/${taskId}/complete`, r)
  }

  /** Daemon → dispatch: terminal failure. 204 on success. */
  async failTask(taskId: string, r: TaskFail): Promise<void> {
    await this.postVoid(`/api/v1/dispatch/tasks/${taskId}/fail`, r)
  }

  // ────────────────────────────────────────────────────────────────────────
  // request plumbing
  // ────────────────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    }
  }

  /** POST that returns the unwrapped `data` of a JSON envelope. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(path, body)
    if (!res.ok) {
      throw new DispatchHttpError(res.status, path, await res.text())
    }
    const envelope = (await res.json()) as Envelope<T>
    if (!envelope.success || envelope.data === undefined) {
      throw new DispatchHttpError(res.status, path, JSON.stringify(envelope))
    }
    return envelope.data
  }

  /** POST that returns 204 No Content; status-checked only. */
  private async postVoid(path: string, body: unknown): Promise<void> {
    const res = await this.request(path, body)
    if (!res.ok) {
      throw new DispatchHttpError(res.status, path, await res.text())
    }
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: body === null ? undefined : JSON.stringify(body),
    }

    if (this.timeoutMs > 0 && typeof AbortController !== 'undefined') {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        return await this.fetchImpl(url, { ...init, signal: ctrl.signal })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new DispatchHttpError(0, path, `timeout after ${this.timeoutMs}ms`)
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    }
    return this.fetchImpl(url, init)
  }
}
