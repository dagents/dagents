/**
 * @mil/daemon — local long-lived agent daemon.
 *
 * Public surface:
 *   - `runDaemon(opts)`    start the register→heartbeat→claim→execute loop
 *   - `DispatchClient`     raw HTTP client for the dispatch protocol
 *   - `defaultBackendFactory`  claude-backed factory (the only MVP adapter)
 *
 * The CLI entrypoint lives in `cli.ts` (bin: `mil-daemon`).
 */
export { runDaemon, defaultBackendFactory, type DaemonOpts, type DaemonHandle } from './main.js'
export {
  DispatchClient,
  DispatchHttpError,
  type DispatchClientOptions,
} from './client.js'
