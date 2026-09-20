/**
 * Shell session wire contract (browser terminal, 2026-09).
 *
 * One source of truth for the PTY-terminal protocol shared by the gateway
 * (`apps/gateway/src/routes/shell.ts` + `shell-registry.ts`) and the browser
 * client (`apps/console` — lib/shell-protocol.ts + shell-terminal.tsx).
 * This seam has produced a real bug before (hello.replay shipped as raw text
 * while the client decoded base64) —— 双端各自手写形状是根因，本文件是根治。
 *
 * Transport: SSE over `GET /api/v1/shell/:id/stream` (browser → console BFF
 * streaming proxy → gateway). Frames are `event:`/`data:` pairs whose data is
 * JSON matching the shapes below. PTY bytes are ALWAYS base64 —— SSE data
 * lines cannot carry raw control bytes / newlines, and base64 keeps the
 * byte-stream intact across chunk boundaries (ANSI, UTF-8).
 *
 * Frame order contract:
 *   1. `hello` — exactly once, first frame. Carries the replay snapshot
 *      (reconnect renders history from it) + the session state AFTER the
 *      subscribe (an exit racing the subscribe is reported here, not lost).
 *   2. `data` — zero or more, live PTY output.
 *   3. `exit` — at most once, terminal frame (also sent immediately after
 *      hello when the session was already dead at subscribe time).
 *   `: ping` comment lines may interleave as keepalive.
 *
 * Control surface (JSON REST, same base path):
 *   POST   /            { cwd?, cols?, rows? }  → ShellSessionCreated
 *   GET    /            → ShellSessionList
 *   POST   /:id/input   { data: base64 }        → PTY stdin (keystrokes/paste)
 *   POST   /:id/resize  { cols, rows }          → PTY winsize
 *   DELETE /:id         → kill + forget
 */

/** `event: hello` — subscribe acknowledgement + replay snapshot. */
export interface ShellHelloFrame {
  /** Full replay buffer, base64 (UTF-8 bytes of prior PTY output). */
  replay: string
  /** Session state as of AFTER subscribing — an exit racing the subscribe
   *  surfaces here instead of being lost with the cleared subscriber set. */
  exited: boolean
  cols: number
  rows: number
}

/** `event: data` — one live PTY output chunk, base64. */
export interface ShellDataFrame {
  b64: string
}

/** `event: exit` — the shell process terminated with this code. */
export interface ShellExitFrame {
  code: number
}

/** Union keyed by the SSE `event:` name. */
export type ShellStreamFrame =
  | { event: 'hello'; data: ShellHelloFrame }
  | { event: 'data'; data: ShellDataFrame }
  | { event: 'exit'; data: ShellExitFrame }

/** POST / response body `data`. */
export interface ShellSessionCreated {
  sessionId: string
  /** Absolute working directory the PTY actually started in. */
  cwd: string
  /** Gateway host home dir — client folds cwd against it for `~/…` labels. */
  home: string
  cols: number
  rows: number
  /** 会话形态（P4）：shell = 用户 $SHELL；agent = agent CLI 托管。 */
  kind?: 'shell' | 'agent'
  /** 展示标签（agent 会话 = agent 名）。 */
  label?: string
}

/** One row of GET / response `data.sessions`. */
export interface ShellSessionSummary {
  id: string
  cwd: string
  createdAt: number
  exited: boolean
  /** 会话形态（P4 交互式 agent 会话，2026-09-19）：shell = 用户 $SHELL；
   *  agent = agent CLI 托管在 PTY 里。缺省按 shell 处理（向后兼容）。 */
  kind?: 'shell' | 'agent'
  /** 展示标签（agent 会话 = agent 名；shell 会话缺省）。 */
  label?: string
}

/** GET / response body `data`. */
export interface ShellSessionList {
  home: string
  sessions: ShellSessionSummary[]
}

/** POST /:id/input body. */
export interface ShellInputBody {
  data: string
}

/** POST /:id/resize body. */
export interface ShellResizeBody {
  cols: number
  rows: number
}

/** POST / body (optional fields fall back: cwd → host home, 80×24). */
export interface ShellCreateBody {
  cwd?: string
  cols?: number
  rows?: number
}
