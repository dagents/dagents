// Per-file vitest setup for the console package (M0.2 component-test scaffold).
//
// Runs once before each test file. The route-handler / lib suites don't render
// React, so `cleanup()` is a no-op for them; for component tests it unmounts
// whatever `render` mounted so the next `it` starts from a clean DOM. jest-dom
// matchers (`toBeInTheDocument`, `toHaveTextContent`, …) extend vitest's
// `expect` globally so assertions read like the design-fidelity plan expects.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom does not ship ResizeObserver; React Flow (@reactflow/core) reads it at
// mount to size the pane, so any component test that renders `<FlowDag>` throws
// `ReferenceError: ResizeObserver is not defined` before the first assertion.
// Polyfill a noop observer so the DAG canvas mounts under jsdom — the layout
// math isn't under test here, only the list-page scope/filter/card DOM and the
// showDetail swap + inspector DOM.
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverPolyfill
}

afterEach(() => {
  cleanup()
})
