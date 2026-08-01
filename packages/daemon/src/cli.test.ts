import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * CLI arg-parsing tests (M2.3). Drives `main()` with a stubbed `runDaemon`
 * via module mocks so no real loop starts; asserts usage / exit codes.
 *
 * `main` calls `process.exit` on bad args, which vitest intercepts via
 * `vi.spyOn(process, 'exit').mockImplementation` so the process survives.
 */
const runDaemonMock = vi.fn((_opts: unknown) => ({
  done: new Promise<void>(() => {}), // never resolves under test
  stop: () => {},
}))

vi.mock('./main.js', () => ({
  runDaemon: (opts: unknown) => runDaemonMock(opts),
}))

// import AFTER the mock is registered
const { main } = await import('./cli.js')

afterEach(() => {
  runDaemonMock.mockClear()
})

describe('mil-daemon CLI — arg parsing', () => {
  it('starts the daemon with a valid agentType', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      main(['http://localhost:8080', 'dev-laptop', 'claude'])
      expect(runDaemonMock).toHaveBeenCalledTimes(1)
      expect(runDaemonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: 'http://localhost:8080',
          label: 'dev-laptop',
          agentType: 'claude',
        }),
      )
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('exits 2 on missing args', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit:2')
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => main(['http://localhost:8080'])).toThrow('exit:2')
      expect(runDaemonMock).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('exits 2 on an unknown agentType', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit:2')
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => main(['http://x', 'l', 'not-a-real-agent'])).toThrow('exit:2')
      expect(runDaemonMock).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
