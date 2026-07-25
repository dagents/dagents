import { describe, it, expect } from 'vitest'
import { RuntimeState } from '../engine/runtime.js'

describe('RuntimeState', () => {
  it('starts empty', () => {
    const rt = new RuntimeState()
    expect(rt.state).toEqual({})
  })

  it('sets and gets values', () => {
    const rt = new RuntimeState()
    rt.set('foo', 'bar')
    expect(rt.get('foo')).toBe('bar')
  })

  it('merges state from node output', () => {
    const rt = new RuntimeState()
    rt.set('existing', 'value')
    rt.merge({ existing: 'updated', newKey: 'added' })
    expect(rt.get('existing')).toBe('updated')
    expect(rt.get('newKey')).toBe('added')
  })

  it('snapshot returns a shallow copy', () => {
    const rt = new RuntimeState()
    rt.set('a', 1)
    const snap = rt.snapshot()
    rt.set('a', 2)
    expect(snap.a).toBe(1)
    expect(rt.get('a')).toBe(2)
  })
})
